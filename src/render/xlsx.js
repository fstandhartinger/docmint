'use strict';

const { readZip, readText, writeEntry, addEntry, writeZip } = require('../ooxml/zip');
const {
  decodeXml, escapeXml, stripInvalidXmlChars, findElements, attr, setAttr, applyEdits,
} = require('../ooxml/xml');
const { flatten, splice } = require('../ooxml/runs');
const { scan, KIND } = require('../template/scan');
const {
  resolveValue, resolveSection, resolveInverted, makeContext, lookup,
} = require('../template/resolve');
const { applyFormatters } = require('../template/formatters');
const { TemplateError } = require('../template/errors');

/**
 * XLSX renderer.
 *
 * Three things make a spreadsheet different from a document, and each of them is
 * a place where a naive filler quietly produces a wrong file.
 *
 * 1. THE SHARED STRING TABLE. Excel does not store cell text in the cell. It
 *    stores an index into xl/sharedStrings.xml, and two cells that happen to
 *    contain the same text share one entry. Editing that entry in place changes
 *    both cells. Repeating a loop row is not expressible at all, because every
 *    copy would need its own entry and the copies would fight over one index. So
 *    this renderer never edits sharedStrings: a cell whose text contains a tag is
 *    rewritten as an inline string (or a real number) and the shared entry is
 *    left where it is. Orphaned entries are harmless — Excel ignores them.
 *
 * 2. TYPES. A cell holding the text "1234.5" is not a number. SUM() over a column
 *    of them returns 0, the chart is empty, and nothing warns anybody. This is the
 *    single biggest difference between a spreadsheet filler that is useful and one
 *    that is not, so a cell whose entire content is one placeholder that resolves
 *    to a number becomes a numeric cell, keeping its `s=` style so the number
 *    format, font, border and fill all survive.
 *
 * 3. ROW GEOMETRY. Repeating rows moves everything below them. Row indices, cell
 *    references, merged ranges, the dimension, conditional formatting, data
 *    validation, hyperlinks, autofilter, defined names, drawing anchors and —
 *    above all — formulas have to move with them. A SUM(D5:D6) over what was the
 *    loop body has to become SUM(D5:D10) when the loop produced six rows, or the
 *    invoice totals only its first line. Formula rewriting uses Excel's
 *    insert-rows semantics (a reference follows the row it pointed at) rather than
 *    copy-paste semantics, except inside a repeated row, where a reference to a
 *    row of the same copy stays inside that copy.
 */

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const EMU_PER_PX = 9525;
const MAX_ROWS = 1048576;

/** Formatters that produce a number even when they hand back a string. */
const NUMERIC_FORMATTERS = new Set([
  'sum', 'sumProduct', 'count', 'multiply', 'add', 'subtract', 'divide', 'round',
]);

function colToNum(col) {
  let n = 0;
  for (let i = 0; i < col.length; i += 1) n = n * 26 + (col.charCodeAt(i) - 64);
  return n;
}

function numToCol(n) {
  let s = '';
  let v = n;
  while (v > 0) { const r = (v - 1) % 26; s = String.fromCharCode(65 + r) + s; v = Math.floor((v - 1) / 26); }
  return s;
}

const REF_RE = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/;

function parseRef(ref) {
  const m = REF_RE.exec(String(ref || ''));
  if (!m) return null;
  return { col: m[1].toUpperCase(), row: Number(m[2]) };
}

/** Removes an attribute from an opening tag. xml.js can set one but not drop one. */
function removeAttr(openTag, name) {
  const re = new RegExp(`\\s${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*=\\s*("[^"]*"|'[^']*')`);
  return openTag.replace(re, '');
}

const textOf = (xml, el) => (el.selfClosing ? '' : xml.slice(el.contentStart, el.contentEnd));

// ---------------------------------------------------------------------------
// Package navigation
// ---------------------------------------------------------------------------

function relsPathFor(partPath) {
  const i = partPath.lastIndexOf('/');
  return `${partPath.slice(0, i)}/_rels/${partPath.slice(i + 1)}.rels`;
}

function resolveRelTarget(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const base = fromPart.slice(0, fromPart.lastIndexOf('/'));
  const segs = base.split('/').filter(Boolean);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  return segs.join('/');
}

function readRels(zip, partPath) {
  const entry = zip.byName.get(relsPathFor(partPath));
  const map = new Map();
  if (!entry) return map;
  const xml = readText(entry);
  for (const el of findElements(xml, 'Relationship')) {
    map.set(attr(el.openTag, 'Id'), {
      type: attr(el.openTag, 'Type') || '',
      target: attr(el.openTag, 'Target') || '',
      mode: attr(el.openTag, 'TargetMode') || null,
    });
  }
  return map;
}

/** The workbook part is wherever _rels/.rels says it is, not necessarily xl/workbook.xml. */
function findWorkbookPath(zip) {
  const root = zip.byName.get('_rels/.rels');
  if (root) {
    const xml = readText(root);
    for (const el of findElements(xml, 'Relationship')) {
      const type = attr(el.openTag, 'Type') || '';
      // A relationship target is relative to the *owner* part's folder, and the
      // owner of _rels/.rels is the package root, not the _rels folder.
      if (type.endsWith('/officeDocument')) return resolveRelTarget('', attr(el.openTag, 'Target'));
    }
  }
  if (zip.byName.get('xl/workbook.xml')) return 'xl/workbook.xml';
  throw new TemplateError('not_xlsx', 'This file does not contain a workbook part — it is not an .xlsx file.', {
    hint: 'Send an .xlsx workbook. A .xls (the old binary format) has to be re-saved as .xlsx first.',
  });
}

function listSheets(zip, workbookPath) {
  const xml = readText(zip.byName.get(workbookPath));
  const rels = readRels(zip, workbookPath);
  const sheets = [];
  const sheetsEl = findElements(xml, 'sheets')[0];
  const scope = sheetsEl ? textOf(xml, sheetsEl) : xml;
  for (const el of findElements(scope, 'sheet')) {
    const rid = attr(el.openTag, 'r:id') || attr(el.openTag, 'id');
    const rel = rels.get(rid);
    if (!rel) continue;
    sheets.push({
      name: attr(el.openTag, 'name') || `Sheet${sheets.length + 1}`,
      sheetId: attr(el.openTag, 'sheetId'),
      state: attr(el.openTag, 'state') || 'visible',
      path: resolveRelTarget(workbookPath, rel.target),
      index: sheets.length,
    });
  }
  return sheets;
}

/**
 * Shared strings as plain text, one per <si>.
 *
 * A shared string is often rich text — several <r><t> runs, because somebody made
 * half of a word bold or the file came back from a converter. `{{customer.name}}`
 * then lives in the table as `{cus` + `tomer.name}` and a scanner that looks at
 * one <t> at a time finds nothing at all. So the <t> nodes of one <si> are
 * concatenated before scanning, exactly as a Word paragraph's runs are.
 */
function readSharedStrings(zip) {
  const entry = zip.byName.get('xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = readText(entry);
  const out = [];
  for (const el of findElements(xml, 'si')) {
    const inner = stripPhonetics(textOf(xml, el));
    out.push({ inner, text: flatten(inner, 't').text });
  }
  return out;
}

/** <rPh> holds furigana whose <t> is not part of the cell's text. */
const stripPhonetics = (s) => s.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr[^>]*\/>/g, '');

// ---------------------------------------------------------------------------
// Number formats: is this cell styled as a date?
// ---------------------------------------------------------------------------

const BUILTIN_DATE_FMTS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36,
  45, 46, 47, 50, 51, 52, 53, 54, 55, 56, 57, 58]);

function readStyles(zip) {
  const entry = zip.byName.get('xl/styles.xml');
  const xfs = [];
  const custom = new Map();
  if (!entry) return { isDateStyle: () => false };
  const xml = readText(entry);
  for (const el of findElements(xml, 'numFmt')) {
    custom.set(Number(attr(el.openTag, 'numFmtId')), attr(el.openTag, 'formatCode') || '');
  }
  const cellXfs = findElements(xml, 'cellXfs')[0];
  if (cellXfs) {
    for (const el of findElements(textOf(xml, cellXfs), 'xf')) xfs.push(Number(attr(el.openTag, 'numFmtId') || 0));
  }
  return {
    isDateStyle(s) {
      const idx = Number(s);
      if (!Number.isInteger(idx) || idx < 0 || idx >= xfs.length) return false;
      const id = xfs[idx];
      if (BUILTIN_DATE_FMTS.has(id)) return true;
      const code = custom.get(id);
      return code ? looksLikeDateFormat(code) : false;
    },
  };
}

/**
 * A format code is a date format if a date placeholder survives once the parts
 * that are literal text are removed. Without the stripping, `#,###.00 [$$-409]`
 * reads as a date because of the "d" hiding inside the locale id.
 */
function looksLikeDateFormat(code) {
  const bare = String(code)
    .replace(/\[[^\]]*\]/g, '')     // [$$-409], [Red], [h]
    .replace(/"[^"]*"/g, '')        // literal text
    .replace(/\\./g, '')            // escaped literals
    .replace(/General/gi, '');
  return /[ymd]/i.test(bare) || /h+:mm/i.test(bare);
}

// ---------------------------------------------------------------------------
// Excel date serials
// ---------------------------------------------------------------------------

const EPOCH_1900 = Date.UTC(1899, 11, 30);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

function toExcelSerial(value) {
  let d;
  if (value instanceof Date) d = value;
  else if (typeof value === 'string' && ISO_DATE_RE.test(value.trim())) {
    const s = value.trim();
    // A bare "2026-02-14" is a calendar date, not an instant; parsing it as UTC
    // keeps it on the day the caller wrote no matter where the server stands.
    d = new Date(s.length === 10 ? `${s}T00:00:00Z` : s);
  } else return null;
  if (Number.isNaN(d.getTime())) return null;
  const serial = (d.getTime() - EPOCH_1900) / 86400000;
  if (!Number.isFinite(serial) || serial < 0) return null;
  return Math.round(serial * 1e8) / 1e8;
}

// ---------------------------------------------------------------------------
// Formula rewriting
// ---------------------------------------------------------------------------

// A formula is scanned for A1-style references while stepping over string
// literals. The negative lookarounds are what stop LOG10( and R1C1 lookalikes
// from being read as cell references.
const FORMULA_TOKEN_RE = /("(?:[^"]|"")*")|((?:'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)?!)?(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g;

function splitRef(ref) {
  const m = /^(\$?)([A-Za-z]{1,3})(\$?)(\d{1,7})$/.exec(ref);
  if (!m) return null;
  return { colAbs: m[1] === '$', col: m[2].toUpperCase(), rowAbs: m[3] === '$', row: Number(m[4]) };
}

/**
 * Rewrites the row part of every relative reference in `formula`.
 *
 * @param {(row:number, which:'start'|'end'|'single', sheet:string|null)=>number|null} mapRow
 *   returns the new row, or null to leave the reference alone.
 */
function rewriteFormula(formula, mapRow) {
  return formula.replace(FORMULA_TOKEN_RE, (match, str, sheetQ, a, b, offset, whole) => {
    if (str !== undefined) return match;
    const sheet = sheetQ ? sheetQ.slice(0, -1).replace(/^'|'$/g, '') : null;
    // "LOG10(" and "A1B" are not references; neither is a name we are in the
    // middle of, such as the "B2" inside "TAB2".
    const after = whole[offset + match.length];
    if (after === '(') return match;
    if (after && /[A-Za-z0-9_.]/.test(after)) return match;
    const before = whole[offset - 1];
    if (!sheetQ && before && /[A-Za-z0-9_.$]/.test(before)) return match;

    const first = splitRef(a);
    if (!first) return match;
    const second = b ? splitRef(b) : null;
    if (b && !second) return match;

    const one = (r, which) => {
      if (r.rowAbs) return `${r.colAbs ? '$' : ''}${r.col}$${r.row}`;
      const next = mapRow(r.row, which, sheet);
      const row = next === null || next === undefined ? r.row : next;
      return `${r.colAbs ? '$' : ''}${r.col}${row}`;
    };

    const head = sheetQ || '';
    if (!second) return `${head}${one(first, 'single')}`;
    return `${head}${one(first, 'start')}:${one(second, 'end')}`;
  });
}

/** Translates a formula by a row/column delta, for materialising shared formulas. */
function translateFormula(formula, dRow, dCol) {
  return formula.replace(FORMULA_TOKEN_RE, (match, str, sheetQ, a, b, offset, whole) => {
    if (str !== undefined) return match;
    const after = whole[offset + match.length];
    if (after === '(') return match;
    if (after && /[A-Za-z0-9_.]/.test(after)) return match;
    const before = whole[offset - 1];
    if (!sheetQ && before && /[A-Za-z0-9_.$]/.test(before)) return match;

    const shift = (ref) => {
      const r = splitRef(ref);
      if (!r) return ref;
      const col = r.colAbs ? r.col : numToCol(Math.max(1, colToNum(r.col) + dCol));
      const row = r.rowAbs ? r.row : Math.min(MAX_ROWS, Math.max(1, r.row + dRow));
      return `${r.colAbs ? '$' : ''}${col}${r.rowAbs ? '$' : ''}${row}`;
    };
    const head = sheetQ || '';
    return b ? `${head}${shift(a)}:${shift(b)}` : `${head}${shift(a)}`;
  });
}

// ---------------------------------------------------------------------------
// Sheet parsing
// ---------------------------------------------------------------------------

function parseSheet(xml) {
  const sd = findElements(xml, 'sheetData')[0];
  if (!sd) return null;
  const inner = textOf(xml, sd);
  const rows = [];
  let implied = 0;
  for (const rel of findElements(inner, 'row')) {
    const rAttr = attr(rel.openTag, 'r');
    const r = rAttr ? Number(rAttr) : implied + 1;
    implied = r;
    const body = textOf(inner, rel);
    const cells = [];
    let impliedCol = 0;
    for (const cel of findElements(body, 'c')) {
      const ref = attr(cel.openTag, 'r');
      const p = ref ? parseRef(ref) : null;
      impliedCol = p ? colToNum(p.col) : impliedCol + 1;
      cells.push({
        col: p ? p.col : numToCol(impliedCol),
        openTag: cel.openTag,
        inner: textOf(body, cel),
        selfClosing: cel.selfClosing,
        s: attr(cel.openTag, 's'),
        t: attr(cel.openTag, 't') || 'n',
      });
    }
    rows.push({ r, openTag: rel.openTag, cells, selfClosing: rel.selfClosing });
  }
  return {
    before: xml.slice(0, sd.start),
    sdOpen: sd.selfClosing ? '<sheetData>' : sd.openTag,
    after: xml.slice(sd.end),
    rows,
  };
}

/**
 * Rewrites <f t="shared"> groups as ordinary formulas.
 *
 * A follower in a shared group carries no formula text — only `si` — and its
 * meaning comes from the master cell's `ref` range. Copy such a cell into a
 * repeated row and the group's ref no longer covers its members, at which point
 * Excel calls the file damaged. Materialising the group first makes every later
 * step a plain formula rewrite.
 */
function materialiseSharedFormulas(sheet) {
  const masters = new Map();
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const fEl = findElements(cell.inner, 'f')[0];
      if (!fEl) continue;
      if (attr(fEl.openTag, 't') !== 'shared') continue;
      const si = attr(fEl.openTag, 'si');
      const body = textOf(cell.inner, fEl);
      if (si !== null && body.trim() !== '') {
        masters.set(si, { formula: decodeXml(body), row: row.r, col: colToNum(cell.col) });
      }
    }
  }
  if (!masters.size) return;
  for (const row of sheet.rows) {
    for (const cell of row.cells) {
      const fEl = findElements(cell.inner, 'f')[0];
      if (!fEl || attr(fEl.openTag, 't') !== 'shared') continue;
      const si = attr(fEl.openTag, 'si');
      const master = masters.get(si);
      const body = textOf(cell.inner, fEl);
      const formula = body.trim() !== ''
        ? decodeXml(body)
        : (master ? translateFormula(master.formula, row.r - master.row, colToNum(cell.col) - master.col) : '');
      let open = removeAttr(removeAttr(removeAttr(fEl.openTag, 't'), 'si'), 'ref');
      if (open.endsWith('/>')) open = `${open.slice(0, -2)}>`;
      const replacement = `${open}${escapeXml(formula)}</f>`;
      cell.inner = cell.inner.slice(0, fEl.start) + replacement + cell.inner.slice(fEl.end);
    }
  }
}

/** The plain text a cell contributes to the template, or null when it holds none. */
function cellSource(cell, shared) {
  if (findElements(cell.inner, 'f').length) return null;   // a formula cell's cached value is not template text
  if (cell.t === 's') {
    const v = findElements(cell.inner, 'v')[0];
    if (!v) return null;
    const idx = Number(decodeXml(textOf(cell.inner, v)));
    const si = shared[idx];
    return si ? { inner: si.inner, text: si.text } : null;
  }
  if (cell.t === 'inlineStr') {
    const is = findElements(cell.inner, 'is')[0];
    if (!is) return null;
    const inner = stripPhonetics(textOf(cell.inner, is));
    return { inner, text: flatten(inner, 't').text };
  }
  if (cell.t === 'str') {
    const v = findElements(cell.inner, 'v')[0];
    if (!v) return null;
    const text = decodeXml(textOf(cell.inner, v));
    return { inner: `<t xml:space="preserve">${escapeXml(text)}</t>`, text };
  }
  return null;
}

/**
 * Every row interval any formula in the package points at, per sheet.
 *
 * Needed because a section that renders zero times would otherwise take rows out
 * from under a SUM that covered them. Excel's own answer to deleting the rows a
 * range spans is #REF!, which on an invoice with no line items means the total
 * cell reads "#REF!" instead of "0.00" — so a span that something references
 * collapses to one blank row rather than to nothing at all.
 */
function collectFormulaRanges(sheets) {
  const bySheet = new Map();
  const add = (name, from, to) => {
    const key = name.toLowerCase();
    if (!bySheet.has(key)) bySheet.set(key, []);
    bySheet.get(key).push([Math.min(from, to), Math.max(from, to)]);
  };
  for (const { sheet, prep } of sheets) {
    for (const row of prep.parsed.rows) {
      for (const cell of row.cells) {
        const fEl = findElements(cell.inner, 'f')[0];
        if (!fEl) continue;
        const formula = decodeXml(textOf(cell.inner, fEl));
        formula.replace(FORMULA_TOKEN_RE, (match, str, sheetQ, a, b) => {
          if (str !== undefined) return match;
          const first = splitRef(a);
          if (!first) return match;
          const second = b ? splitRef(b) : null;
          const name = sheetQ ? sheetQ.slice(0, -1).replace(/^'|'$/g, '') : sheet.name;
          add(name, first.row, second ? second.row : first.row);
          return match;
        });
      }
    }
  }
  return bySheet;
}

const rangesTouch = (intervals, from, to) => !!intervals
  && intervals.some(([a, b]) => a <= to && b >= from);

// ---------------------------------------------------------------------------
// Section structure over rows
// ---------------------------------------------------------------------------

/**
 * Builds the tree of row spans opened by {#x} / {^x} and closed by {/x}.
 *
 * A section is a *row* construct here even when both tags sit in one cell: a
 * spreadsheet loop that repeated only part of a row would leave the rest of the
 * line behind, which is never what an invoice wants.
 */
function buildBlocks(rows, sheetName) {
  const root = { kind: 'root', startRow: 0, endRow: rows.length - 1, children: [] };
  const stack = [root];
  rows.forEach((row, i) => {
    for (const cell of row.cells) {
      if (!cell.tags) continue;
      for (const tag of cell.tags) {
        const where = `${sheetName}!${cell.col}${row.r}`;
        if (tag.kind === KIND.OPEN_SECTION || tag.kind === KIND.OPEN_INVERTED) {
          const node = { kind: tag.kind, tag, startRow: i, endRow: null, children: [], location: where };
          stack[stack.length - 1].children.push(node);
          stack.push(node);
        } else if (tag.kind === KIND.CLOSE) {
          const open = stack[stack.length - 1];
          if (open === root) {
            throw new TemplateError('section_unbalanced',
              `{${tag.raw.replace(/[{}]/g, '')}} closes a section that was never opened.`, {
                field: tag.path || null,
                location: where,
                hint: 'Every {/name} needs a matching {#name} in the same sheet, in an earlier or the same row.',
              });
          }
          if (tag.path && tag.path !== open.tag.path) {
            throw new TemplateError('section_unbalanced',
              `{/${tag.path}} closes {#${open.tag.path}}, which was opened at ${open.location}.`, {
                field: tag.path,
                location: where,
                hint: `Write {/${open.tag.path}} here, or {/} to close whichever section is open.`,
              });
          }
          open.endRow = i;
          stack.pop();
        }
      }
    }
  });
  if (stack.length > 1) {
    const open = stack[stack.length - 1];
    throw new TemplateError('section_unbalanced',
      `{#${open.tag.path}} is never closed.`, {
        field: open.tag.path,
        location: open.location,
        hint: `Add {/${open.tag.path}} in the last row the section should cover.`,
      });
  }
  return root;
}

// ---------------------------------------------------------------------------
// Cell rendering
// ---------------------------------------------------------------------------

/**
 * Renders one cell for one output row.
 *
 * The return value keeps the pieces rather than a finished string, because the
 * row number is not known until every row has been emitted and numbered.
 */
function renderCell(cell, row, stack, env) {
  const out = {
    col: cell.col,
    openTag: cell.openTag,
    inner: cell.inner,
    selfClosing: cell.selfClosing,
    formula: null,
    formulaOpen: null,
    srcRow: row.r,
  };

  const fEl = findElements(cell.inner, 'f')[0];
  if (fEl) {
    out.formula = decodeXml(textOf(cell.inner, fEl));
    out.formulaOpen = fEl.selfClosing ? `${fEl.openTag.slice(0, -2)}>` : fEl.openTag;
    return out;
  }

  const src = cell.src;
  if (!src || !cell.tags || !cell.tags.length) return out;

  env.ctx.location = `${env.sheetName}!${cell.col}${row.r}`;

  // Whole-cell single value tag: the one case where the cell can become a real
  // number, a real boolean or a real date rather than text.
  const solo = cell.tags.length === 1
    && cell.tags[0].kind === KIND.VALUE
    && cell.tags[0].start === 0
    && cell.tags[0].end === src.text.length;

  const flat = flatten(src.inner, 't');
  const edits = [];
  let soloText = null;
  for (const tag of cell.tags) {
    if (tag.kind === KIND.COMMENT) { edits.push({ start: tag.start, end: tag.end, text: '' }); continue; }
    if (tag.kind === KIND.OPEN_SECTION || tag.kind === KIND.OPEN_INVERTED || tag.kind === KIND.CLOSE) {
      edits.push({ start: tag.start, end: tag.end, text: '' });
      continue;
    }
    if (tag.kind === KIND.IMAGE) {
      env.images.push({ tag, cell, srcRow: row.r, out, stack: [...stack] });
      edits.push({ start: tag.start, end: tag.end, text: '' });
      continue;
    }
    if (tag.kind === KIND.RAW) {
      const raw = resolveValue({ ...tag, kind: KIND.VALUE, formatters: tag.formatters || [] }, stack, env.ctx);
      env.stats.resolved += 1;
      edits.push({ start: tag.start, end: tag.end, text: stripInvalidXmlChars(raw) });
      continue;
    }
    const text = resolveValue(tag, stack, env.ctx);
    env.stats.resolved += 1;
    if (solo) soloText = text;
    edits.push({ start: tag.start, end: tag.end, text: escapeXml(stripInvalidXmlChars(text)) });
  }

  if (solo && soloText !== null) {
    const typed = typedValue(cell.tags[0], stack, env.ctx, cell, soloText);
    // Only a number, a boolean or a date changes the cell's type. Text falls
    // through to the run-splicing path below so that a placeholder somebody made
    // bold in half of the shared string keeps its formatting.
    if (typed && typed.kind !== 'text') { applyTyped(out, typed); return out; }
    if (typed) { setStringCell(out, `<t xml:space="preserve">${escapeXml(stripInvalidXmlChars(String(typed.value)))}</t>`); return out; }
  }

  const body = splice(src.inner, flat, edits, (s) => escapeXml(stripInvalidXmlChars(s)));
  if (flatten(body, 't').text === '') setEmptyCell(out);
  else setStringCell(out, body);
  return out;
}

/**
 * Works out whether a whole-cell placeholder should become a number, a boolean
 * or a date serial rather than text.
 *
 * `resolveValue` has already run and produced the display string, so the lookup
 * here cannot fail in a new way; it is repeated only to see the value before it
 * was stringified.
 */
function typedValue(tag, stack, ctx, cell, text) {
  const { found, value } = lookup(tag.path, stack);
  const hasDefault = tag.formatters.some((f) => f.name === 'default');
  if (!found && !hasDefault) return null;          // onMissing relaxation: keep it as text
  let raw;
  try {
    raw = applyFormatters(found ? value : undefined, tag.formatters, ctx);
  } catch { return null; }

  const last = tag.formatters.length ? tag.formatters[tag.formatters.length - 1].name : null;
  const dateAsked = last === 'date';

  if (typeof raw === 'boolean') return { kind: 'bool', value: raw };

  if (typeof raw === 'number' && Number.isFinite(raw)) return { kind: 'number', value: raw };

  // round/multiply/sum and friends hand back a string that is really a number;
  // writing it as text would silently break every SUM() over the column.
  if (typeof raw === 'string' && last && NUMERIC_FORMATTERS.has(last)
      && raw.trim() !== '' && Number.isFinite(Number(raw))) {
    return { kind: 'number', value: Number(raw) };
  }

  // A date-formatted cell should hold the serial, so it sorts, charts and
  // re-formats. A cell without a date format keeps whatever text the caller
  // asked for — including {d|date:...}, where they chose the format themselves.
  if (!dateAsked && (raw instanceof Date || typeof raw === 'string')) {
    if (cell.isDateStyled) {
      const serial = toExcelSerial(raw);
      if (serial !== null) return { kind: 'number', value: serial };
    }
  }
  // String(new Date()) is "Mon Feb 14 2026 00:00:00 GMT+0000 (UTC)", which nobody
  // wants in a cell. A Date that could not become a serial goes in as ISO.
  if (raw instanceof Date && !dateAsked) {
    return { kind: 'text', value: Number.isNaN(raw.getTime()) ? text : raw.toISOString().slice(0, 10) };
  }
  return null;
}

function applyTyped(out, typed) {
  if (typed.kind === 'number') {
    out.openTag = removeAttr(out.openTag, 't');
    out.inner = `<v>${numberToXml(typed.value)}</v>`;
    out.selfClosing = false;
    return;
  }
  if (typed.kind === 'bool') {
    out.openTag = setAttr(out.openTag, 't', 'b');
    out.inner = `<v>${typed.value ? 1 : 0}</v>`;
    out.selfClosing = false;
    return;
  }
  setStringCell(out, `<t xml:space="preserve">${escapeXml(stripInvalidXmlChars(String(typed.value)))}</t>`);
}

/** Excel wants a plain decimal; 1e21 or "NaN" in a <v> makes the file unreadable. */
function numberToXml(n) {
  if (!Number.isFinite(n)) return '0';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const s = String(Math.round(n * 1e10) / 1e10);
  return s.includes('e') || s.includes('E') ? n.toFixed(10).replace(/0+$/, '').replace(/\.$/, '') : s;
}

function setStringCell(out, body) {
  out.openTag = setAttr(out.openTag, 't', 'inlineStr');
  out.inner = `<is>${body}</is>`;
  out.selfClosing = false;
}

/**
 * An empty result becomes a genuinely blank cell rather than an inline string
 * holding "". A blank cell is what ISBLANK, COUNTA and a chart all expect.
 */
function setEmptyCell(out) {
  out.openTag = removeAttr(out.openTag, 't');
  out.inner = '';
  out.selfClosing = true;
}

// ---------------------------------------------------------------------------
// Row expansion
// ---------------------------------------------------------------------------

/**
 * A single empty row standing in for a span that rendered zero times. Styles are
 * kept so the table's borders do not break; text and formulas are not.
 */
function blankRow(row, lastSrc, group) {
  return {
    srcRow: row.r,
    lastSrc,
    aliasRows: [],
    openTag: row.openTag,
    selfClosing: row.selfClosing,
    group,
    cells: row.cells.map((cell) => ({
      col: cell.col,
      openTag: removeAttr(cell.openTag, 't'),
      inner: '',
      selfClosing: true,
      formula: null,
      formulaOpen: null,
      srcRow: row.r,
    })),
  };
}

function renderRows(rows, node, stack, outRows, group, env) {
  const children = node.children;
  let ci = 0;
  let i = node.startRow;
  while (i <= node.endRow) {
    while (ci < children.length && children[ci].startRow < i) ci += 1;
    const child = ci < children.length && children[ci].startRow === i ? children[ci] : null;
    if (child) {
      env.ctx.location = child.location;
      const res = child.kind === KIND.OPEN_SECTION
        ? resolveSection(child.tag, stack, env.ctx)
        : resolveInverted(child.tag, stack, env.ctx);
      env.stats.sections += 1;
      if (!res.passes.length) {
        const from = rows[child.startRow].r;
        const to = rows[child.endRow].r;
        if (rangesTouch(env.referenced, from, to)) outRows.push(blankRow(rows[child.startRow], to, group));
      }
      for (const pass of res.passes) {
        stack.push({ value: pass.value, meta: pass.meta });
        renderRows(rows, child, stack, outRows, { parent: group, map: new Map() }, env);
        stack.pop();
      }
      i = child.endRow + 1;
      ci += 1;
      continue;
    }
    const row = rows[i];
    outRows.push({
      srcRow: row.r,
      openTag: row.openTag,
      selfClosing: row.selfClosing,
      group,
      cells: row.cells.map((cell) => renderCell(cell, row, stack, env)),
    });
    i += 1;
  }
}

/**
 * Assigns output row numbers.
 *
 * Two rules, and the difference between them is why they are written out rather
 * than "just renumber sequentially". A row the template left empty — no <row>
 * element at all — is a blank line the author put there on purpose, so the gap is
 * preserved. A row that existed but was dropped by a section is not a blank line;
 * leaving a hole where it stood would put a stray empty row in every document
 * whose {^empty} branch did not fire.
 */
function numberRows(outRows, presentRows) {
  const occ = new Map();
  let prevSrc = null;
  let prevNew = 0;
  for (const row of outRows) {
    let n;
    if (prevSrc === null) n = row.srcRow;
    else if (row.srcRow > prevSrc) {
      let gaps = 0;
      for (let r = prevSrc + 1; r < row.srcRow; r += 1) if (!presentRows.has(r)) gaps += 1;
      n = prevNew + 1 + gaps;
    } else n = prevNew + 1;
    row.newRow = n;
    prevSrc = row.lastSrc === undefined ? row.srcRow : row.lastSrc;
    prevNew = n;
    // A blank stand-in row answers for every source row of the span it replaced,
    // so SUM(D5:D6) becomes SUM(D5:D5) over that one blank row instead of
    // pointing at whatever moved up into its place.
    for (let src = row.srcRow; src <= (row.lastSrc === undefined ? row.srcRow : row.lastSrc); src += 1) {
      // Each enclosing iteration records the span its own rows occupy, so a
      // per-group subtotal such as SUM(B2:B2) sitting in the outer loop widens to
      // that department's staff rows and not to every department's.
      for (let g = row.group; g; g = g.parent) {
        const cur = g.map.get(src);
        if (!cur) g.map.set(src, [n, n]);
        else { cur[0] = Math.min(cur[0], n); cur[1] = Math.max(cur[1], n); }
      }
      if (!occ.has(src)) occ.set(src, []);
      occ.get(src).push(n);
    }
  }
  return occ;
}

/**
 * Where a row reference should point after expansion.
 *
 * `which` matters for a range: a SUM over what was the loop body must start at
 * the first copy and end at the last, which is the whole reason SUM(D5:D6)
 * becomes SUM(D5:D10) instead of staying two rows long.
 */
function makeRowMapper(occ, sortedSrc, tailDelta) {
  return (oldRow, which) => {
    const list = occ.get(oldRow);
    if (list) return which === 'end' ? list[list.length - 1] : list[0];
    // A row with no <row> element of its own moves with the last row above it.
    let delta = 0;
    for (let i = sortedSrc.length - 1; i >= 0; i -= 1) {
      if (sortedSrc[i] <= oldRow) {
        const l = occ.get(sortedSrc[i]);
        delta = l[l.length - 1] - sortedSrc[i];
        break;
      }
    }
    if (oldRow > sortedSrc[sortedSrc.length - 1]) delta = tailDelta;
    return Math.min(MAX_ROWS, oldRow + delta);
  };
}

// ---------------------------------------------------------------------------
// Ranges outside sheetData
// ---------------------------------------------------------------------------

/**
 * Maps one A1 range to the ranges it becomes.
 *
 * A merged cell, a conditional format or a hyperlink that sits inside the loop
 * body has to appear once per generated row — a merged A6:D6 note line that
 * stayed a single merge would leave every copy but the first unmerged.
 */
function mapRange(range, occ, mapRow) {
  const parts = range.split(':');
  const a = parseRef(parts[0]);
  const b = parts[1] ? parseRef(parts[1]) : null;
  if (!a || (parts[1] && !b)) return [range];
  const keepAbs = (ref, row) => ref.replace(/\d+$/, String(row));

  const o1 = occ.get(a.row);
  const o2 = b ? occ.get(b.row) : o1;
  if (o1 && o2 && o1.length === o2.length && o1.length > 1 && o1.every((v, i) => v <= o2[i])) {
    return o1.map((_, i) => (b
      ? `${keepAbs(parts[0], o1[i])}:${keepAbs(parts[1], o2[i])}`
      : keepAbs(parts[0], o1[i])));
  }
  const start = mapRow(a.row, b ? 'start' : 'single');
  if (!b) return [keepAbs(parts[0], start)];
  return [`${keepAbs(parts[0], start)}:${keepAbs(parts[1], mapRow(b.row, 'end'))}`];
}

const mapSqref = (sqref, occ, mapRow) => sqref.trim().split(/\s+/)
  .flatMap((r) => mapRange(r, occ, mapRow)).join(' ');

/** Rewrites the range-bearing elements that live outside <sheetData>. */
function fixSheetTail(xml, occ, mapRow) {
  let out = xml;

  const merges = findElements(out, 'mergeCells')[0];
  if (merges) {
    const inner = textOf(out, merges);
    const refs = [];
    for (const el of findElements(inner, 'mergeCell')) {
      const ref = attr(el.openTag, 'ref');
      if (ref) refs.push(...mapRange(ref, occ, mapRow));
    }
    const body = refs.map((r) => `<mergeCell ref="${escapeXml(r)}"/>`).join('');
    out = out.slice(0, merges.start)
      + (refs.length ? `<mergeCells count="${refs.length}">${body}</mergeCells>` : '')
      + out.slice(merges.end);
  }

  out = mapAttrEverywhere(out, 'hyperlink', 'ref', occ, mapRow, true);
  out = mapAttrEverywhere(out, 'conditionalFormatting', 'sqref', occ, mapRow, false);
  out = mapAttrEverywhere(out, 'dataValidation', 'sqref', occ, mapRow, false);
  out = mapAttrEverywhere(out, 'autoFilter', 'ref', occ, mapRow, false);
  return out;
}

/**
 * Rewrites `attrName` on every `tag` element. When `duplicate` is set and the
 * range expanded into several, the element itself is repeated — which is what a
 * hyperlink inside a loop body needs.
 */
function mapAttrEverywhere(xml, tag, attrName, occ, mapRow, duplicate) {
  const els = findElements(xml, tag);
  if (!els.length) return xml;
  const edits = [];
  for (const el of els) {
    const value = attr(el.openTag, attrName);
    if (!value) continue;
    const ranges = attrName === 'sqref' ? [mapSqref(value, occ, mapRow)] : mapRange(value, occ, mapRow);
    if (!duplicate || ranges.length === 1) {
      const open = setAttr(el.openTag, attrName, attrName === 'sqref' ? ranges[0] : ranges[0]);
      edits.push({ start: el.start, end: el.openEnd, text: open });
      continue;
    }
    const whole = xml.slice(el.start, el.end);
    const text = ranges.map((r) => whole.replace(el.openTag, setAttr(el.openTag, attrName, r))).join('');
    edits.push({ start: el.start, end: el.end, text });
  }
  return applyEdits(xml, edits);
}

/**
 * An Excel table (xl/tables/tableN.xml) names the range it covers and repeats it
 * on its autoFilter. Leave those behind after inserting rows and Excel reports
 * the workbook as damaged rather than just showing the wrong range.
 */
function fixTableParts(zip, sheet, occ, mapRow, touched) {
  const rels = readRels(zip, sheet.path);
  for (const rel of rels.values()) {
    if (!rel.type.endsWith('/table')) continue;
    const path = resolveRelTarget(sheet.path, rel.target);
    const entry = zip.byName.get(path);
    if (!entry) continue;
    let xml = readText(entry);
    const before = xml;
    for (const tag of ['table', 'autoFilter']) {
      const el = findElements(xml, tag)[0];
      if (!el) continue;
      const ref = attr(el.openTag, 'ref');
      if (!ref) continue;
      xml = xml.slice(0, el.start)
        + setAttr(el.openTag, 'ref', mapRange(ref, occ, mapRow).slice(-1)[0])
        + xml.slice(el.openEnd);
    }
    if (xml !== before) { writeEntry(entry, xml); touched.add(path); }
  }
}

// ---------------------------------------------------------------------------
// Rendering a sheet
// ---------------------------------------------------------------------------

function prepareSheet(zip, sheet, shared, styles) {
  const entry = zip.byName.get(sheet.path);
  if (!entry) return null;
  const xml = readText(entry);
  const parsed = parseSheet(xml);
  if (!parsed) return null;
  materialiseSharedFormulas(parsed);
  let tagCount = 0;
  for (const row of parsed.rows) {
    for (const cell of row.cells) {
      cell.src = cellSource(cell, shared);
      cell.tags = cell.src ? scan(cell.src.text) : null;
      cell.isDateStyled = styles.isDateStyle(cell.s);
      if (cell.tags) tagCount += cell.tags.length;
    }
  }
  return { entry, xml, parsed, tagCount };
}

function renderSheet(prep, sheet, stack, env) {
  const { parsed } = prep;
  const blocks = buildBlocks(parsed.rows, sheet.name);
  const outRows = [];
  env.sheetName = sheet.name;
  if (parsed.rows.length) renderRows(parsed.rows, blocks, stack, outRows, { parent: null, map: new Map() }, env);

  const presentRows = new Set(parsed.rows.map((r) => r.r));
  const occ = numberRows(outRows, presentRows);
  const sortedSrc = [...occ.keys()].sort((a, b) => a - b);
  const lastSrc = parsed.rows.length ? parsed.rows[parsed.rows.length - 1].r : 0;
  const lastNew = outRows.length ? outRows[outRows.length - 1].newRow : 0;
  return { parsed, outRows, occ, sortedSrc, tailDelta: lastNew - lastSrc, lastSrc, lastNew };
}

/** Second pass: now that every sheet has been numbered, formulas can be written. */
function emitSheet(state, sheet, sheetMappers) {
  const { parsed, outRows, occ, sortedSrc, tailDelta } = state;
  const mapRow = makeRowMapper(occ, sortedSrc, tailDelta);

  const body = outRows.map((row) => {
    const open = setAttr(row.openTag, 'r', row.newRow);
    const cells = row.cells.map((cell) => emitCell(cell, row, sheet, sheetMappers, mapRow)).join('');
    // A row the template wrote as <row r="3"/> has to stay self-closing; closing
    // it with </row> would produce a stray end tag and an unreadable workbook.
    if (!cells && row.selfClosing) return open;
    return `${open.endsWith('/>') ? `${open.slice(0, -2)}>` : open}${cells}</row>`;
  }).join('');

  let before = parsed.before;
  const dim = findElements(before, 'dimension')[0];
  if (dim) {
    const ref = attr(dim.openTag, 'ref');
    if (ref) {
      before = before.slice(0, dim.start)
        + setAttr(dim.openTag, 'ref', mapRange(ref, occ, mapRow).slice(-1)[0])
        + before.slice(dim.openEnd);
    }
  }
  const after = fixSheetTail(parsed.after, occ, mapRow);
  return `${before}${parsed.sdOpen}${body}</sheetData>${after}`;
}

function emitCell(cell, row, sheet, sheetMappers, ownMapper) {
  let open = setAttr(cell.openTag, 'r', `${cell.col}${row.newRow}`);
  let inner = cell.inner;

  if (cell.formula !== null) {
    // A reference from inside a repeated row to another row of the same copy has
    // to stay inside that copy; anything else follows the row it pointed at.
    const resolveLocal = (oldRow, which) => {
      for (let g = row.group; g; g = g.parent) {
        const span = g.map.get(oldRow);
        if (span) return which === 'end' ? span[1] : span[0];
      }
      return null;
    };
    const formula = rewriteFormula(cell.formula, (oldRow, which, sheetName) => {
      if (sheetName && sheetName.toLowerCase() !== sheet.name.toLowerCase()) {
        const other = sheetMappers.get(sheetName.toLowerCase());
        return other ? other(oldRow, which) : null;
      }
      const local = resolveLocal(oldRow, which);
      if (local !== null) return local;
      return ownMapper(oldRow, which);
    });
    let fOpen = cell.formulaOpen;
    const arrayRef = attr(fOpen, 'ref');
    if (arrayRef) fOpen = setAttr(fOpen, 'ref', mapRange(arrayRef, new Map(), ownMapper).slice(-1)[0]);
    // The cached <v> is dropped: after moving rows around it is stale, and Excel
    // and LibreOffice both recalculate a formula cell that has no cached value.
    inner = `${fOpen}${escapeXml(formula)}</f>`;
    open = removeAttr(open, 't');
  }

  if (cell.selfClosing && inner === '') {
    return open.endsWith('/>') ? open : `${open.slice(0, -1)}/>`;
  }
  if (open.endsWith('/>')) open = `${open.slice(0, -2)}>`;
  return `${open}${inner}</c>`;
}

// ---------------------------------------------------------------------------
// Drawings (text in shapes and text boxes)
// ---------------------------------------------------------------------------

function drawingPartsFor(zip, sheet) {
  const rels = readRels(zip, sheet.path);
  const out = [];
  const entry = zip.byName.get(sheet.path);
  if (!entry) return out;
  const xml = readText(entry);
  for (const el of findElements(xml, 'drawing')) {
    const rid = attr(el.openTag, 'r:id') || attr(el.openTag, 'id');
    const rel = rels.get(rid);
    if (rel) out.push(resolveRelTarget(sheet.path, rel.target));
  }
  return out;
}

/**
 * Shape text is DrawingML, so it splits into runs exactly the way Word does and
 * needs the same flatten-scan-splice treatment. Sections are not supported here:
 * repeating a shape is a layout decision, not a text one.
 */
function renderDrawing(zip, path, sheet, state, stack, env) {
  const entry = zip.byName.get(path);
  if (!entry) return false;
  let xml = readText(entry);
  let changed = false;

  const paras = findElements(xml, 'a:p');
  const edits = [];
  paras.forEach((p, idx) => {
    const inner = textOf(xml, p);
    const flat = flatten(inner, 'a:t');
    if (!flat.text) return;
    const tags = scan(flat.text);
    if (!tags.length) return;
    env.stats.tags += tags.length;
    const cellEdits = [];
    for (const tag of tags) {
      if (tag.kind === KIND.COMMENT) { cellEdits.push({ start: tag.start, end: tag.end, text: '' }); continue; }
      if (tag.kind !== KIND.VALUE && tag.kind !== KIND.RAW) {
        throw new TemplateError('section_in_shape',
          `{${tag.raw.replace(/^\{+|\}+$/g, '')}} is inside a shape on sheet "${sheet.name}". Loops and images work in cells, not in shapes.`, {
            field: tag.path || null,
            location: `${sheet.name}, shape text ${idx + 1}`,
            hint: 'Move the loop into the worksheet grid, or replace the shape text with a plain {placeholder}.',
          });
      }
      env.ctx.location = `${sheet.name}, shape text ${idx + 1}`;
      const text = resolveValue({ ...tag, kind: KIND.VALUE }, stack, env.ctx);
      env.stats.resolved += 1;
      cellEdits.push({
        start: tag.start,
        end: tag.end,
        text: tag.kind === KIND.RAW ? stripInvalidXmlChars(text) : escapeXml(stripInvalidXmlChars(text)),
      });
    }
    edits.push({ start: p.contentStart, end: p.contentEnd, text: splice(inner, flat, cellEdits) });
    changed = true;
  });
  if (edits.length) xml = applyEdits(xml, edits);

  // An anchor names a row, so a shape below a loop has to move down with it.
  if (state) {
    const mapRow = makeRowMapper(state.occ, state.sortedSrc, state.tailDelta);
    const rowEls = findElements(xml, 'xdr:row');
    if (rowEls.length) {
      const rowEdits = rowEls.map((el) => {
        const oldRow = Number(decodeXml(textOf(xml, el))) + 1;   // anchors are 0-based
        if (!Number.isFinite(oldRow)) return null;
        const next = mapRow(oldRow, 'single') - 1;
        return { start: el.contentStart, end: el.contentEnd, text: String(Math.max(0, next)) };
      }).filter(Boolean);
      if (rowEdits.length) { xml = applyEdits(xml, rowEdits); changed = true; }
    }
  }

  if (changed) writeEntry(entry, xml);
  return changed;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

const IMAGE_TYPES = {
  png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp',
};

/** Reads an intrinsic pixel size so an image without one still lands sanely sized. */
function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), ext: 'png' };
  }
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p += 1; continue; }
      const marker = buf[p + 1];
      const len = buf.readUInt16BE(p + 2);
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(p + 7), height: buf.readUInt16BE(p + 5), ext: 'jpeg' };
      }
      p += 2 + len;
    }
    return { width: 0, height: 0, ext: 'jpeg' };
  }
  if (buf.length > 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), ext: 'gif' };
  }
  return null;
}

function decodeImage(value, tag, ctx) {
  let data = value;
  let width = null;
  let height = null;
  if (data && typeof data === 'object' && !Buffer.isBuffer(data)) {
    width = Number(data.width) || null;
    height = Number(data.height) || null;
    data = data.data ?? data.base64 ?? data.buffer ?? data.content;
  }
  let buf = null;
  if (Buffer.isBuffer(data)) buf = data;
  else if (data instanceof Uint8Array) buf = Buffer.from(data);
  else if (typeof data === 'string') {
    const m = /^data:([^;,]+);base64,(.*)$/s.exec(data.trim());
    const b64 = m ? m[2] : data.trim();
    if (/^https?:/i.test(b64)) {
      throw new TemplateError('image_url_unsupported',
        `{%${tag.path}} is a URL. DocMint does not fetch images over the network.`, {
          field: tag.path,
          location: ctx.location,
          hint: 'Send the image inline as base64 or a data: URI.',
        });
    }
    if (!/^[A-Za-z0-9+/=\s]+$/.test(b64)) {
      throw new TemplateError('image_bad_data', `{%${tag.path}} is not image data.`, {
        field: tag.path, location: ctx.location, hint: 'Send base64 or a data: URI.',
      });
    }
    buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  }
  if (!buf || !buf.length) {
    throw new TemplateError('image_bad_data', `{%${tag.path}} did not resolve to any image data.`, {
      field: tag.path, location: ctx.location, hint: 'Send base64, a data: URI, or a Buffer.',
    });
  }
  const size = imageSize(buf);
  if (!size) {
    throw new TemplateError('image_bad_data',
      `{%${tag.path}} is not a PNG, JPEG, GIF or BMP.`, {
        field: tag.path, location: ctx.location, hint: 'Convert the image to PNG or JPEG first.',
      });
  }
  return {
    buf,
    ext: size.ext,
    width: width || size.width || 96,
    height: height || size.height || 96,
  };
}

/**
 * Wires images into the package: one media part each, one drawing per sheet, the
 * relationships both need, and the content-type defaults. Everything is built
 * from scratch for sheets that had no drawing, and appended for sheets that did.
 */
function attachImages(zip, sheet, requests, touched) {
  if (!requests.length) return;
  const sheetEntry = zip.byName.get(sheet.path);
  let sheetXml = readText(sheetEntry);
  const relsPath = relsPathFor(sheet.path);
  let relsXml = zip.byName.get(relsPath)
    ? readText(zip.byName.get(relsPath))
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  const existing = drawingPartsFor(zip, sheet);
  let drawingPath = existing[0] || null;
  let drawingXml;
  if (drawingPath && zip.byName.get(drawingPath)) {
    drawingXml = readText(zip.byName.get(drawingPath));
  } else {
    let n = 1;
    while (zip.byName.get(`xl/drawings/drawing${n}.xml`)) n += 1;
    drawingPath = `xl/drawings/drawing${n}.xml`;
    drawingXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
      + '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"'
      + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
      + ' xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"></xdr:wsDr>';
    const rid = nextRelId(relsXml);
    relsXml = addRel(relsXml, rid,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing',
      relativeTarget(sheet.path, drawingPath));
    sheetXml = insertDrawingRef(sheetXml, rid);
    writeEntry(sheetEntry, sheetXml);
  }

  const dRelsPath = relsPathFor(drawingPath);
  let dRelsXml = zip.byName.get(dRelsPath)
    ? readText(zip.byName.get(dRelsPath))
    : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';

  let anchors = '';
  let shapeId = 1000 + findElements(drawingXml, 'xdr:pic').length;
  const exts = new Set();
  for (const req of requests) {
    let n = 1;
    while (zip.byName.get(`xl/media/image${n}.${req.image.ext}`)) n += 1;
    const mediaPath = `xl/media/image${n}.${req.image.ext}`;
    addEntry(zip, mediaPath, req.image.buf, { method: 0 });
    touched.add(mediaPath);
    exts.add(req.image.ext);

    const rid = nextRelId(dRelsXml);
    dRelsXml = addRel(dRelsXml, rid,
      'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
      relativeTarget(drawingPath, mediaPath));

    shapeId += 1;
    anchors += oneCellAnchor(req, rid, shapeId);
  }

  drawingXml = drawingXml.replace(/<\/xdr:wsDr>\s*$/, `${anchors}</xdr:wsDr>`);
  const dEntry = zip.byName.get(drawingPath);
  if (dEntry) writeEntry(dEntry, drawingXml); else addEntry(zip, drawingPath, drawingXml);
  touched.add(drawingPath);

  const relsEntry = zip.byName.get(relsPath);
  if (relsEntry) writeEntry(relsEntry, relsXml); else addEntry(zip, relsPath, relsXml);
  touched.add(relsPath);

  const dRelsEntry = zip.byName.get(dRelsPath);
  if (dRelsEntry) writeEntry(dRelsEntry, dRelsXml); else addEntry(zip, dRelsPath, dRelsXml);
  touched.add(dRelsPath);

  ensureContentTypes(zip, exts, drawingPath, touched);
}

function oneCellAnchor(req, rid, shapeId) {
  const col = colToNum(req.col) - 1;
  const row = req.newRow - 1;
  const cx = Math.max(1, Math.round(req.image.width * EMU_PER_PX));
  const cy = Math.max(1, Math.round(req.image.height * EMU_PER_PX));
  const name = escapeXml(req.tag.path);
  return '<xdr:oneCellAnchor>'
    + `<xdr:from><xdr:col>${col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
    + `<xdr:ext cx="${cx}" cy="${cy}"/>`
    + '<xdr:pic>'
    + `<xdr:nvPicPr><xdr:cNvPr id="${shapeId}" name="${name}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
    + `<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
    + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>`
    + '</xdr:pic><xdr:clientData/></xdr:oneCellAnchor>';
}

function nextRelId(relsXml) {
  let max = 0;
  for (const el of findElements(relsXml, 'Relationship')) {
    const m = /^rId(\d+)$/.exec(attr(el.openTag, 'Id') || '');
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `rId${max + 1}`;
}

const addRel = (relsXml, id, type, target) => relsXml.replace(/<\/Relationships>\s*$/,
  `<Relationship Id="${id}" Type="${type}" Target="${escapeXml(target)}"/></Relationships>`);

function relativeTarget(fromPart, toPart) {
  const from = fromPart.split('/').slice(0, -1);
  const to = toPart.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i += 1;
  return [...Array(from.length - i).fill('..'), ...to.slice(i)].join('/');
}

/**
 * <drawing> has a fixed place near the end of CT_Worksheet. Putting it anywhere
 * else — after <extLst>, say — is a schema violation Excel refuses to open.
 */
function insertDrawingRef(sheetXml, rid) {
  if (/<drawing\s/.test(sheetXml)) return sheetXml;
  const tag = `<drawing r:id="${rid}"/>`;
  for (const after of ['<legacyDrawing', '<legacyDrawingHF', '<picture', '<oleObjects', '<controls', '<extLst']) {
    const i = sheetXml.indexOf(after);
    if (i !== -1) return sheetXml.slice(0, i) + tag + sheetXml.slice(i);
  }
  return sheetXml.replace(/<\/worksheet>\s*$/, `${tag}</worksheet>`);
}

function ensureContentTypes(zip, exts, drawingPath, touched) {
  const entry = zip.byName.get('[Content_Types].xml');
  if (!entry) return;
  let xml = readText(entry);
  let changed = false;
  for (const ext of exts) {
    if (new RegExp(`Extension="${ext}"`, 'i').test(xml)) continue;
    xml = xml.replace('<Default', `<Default Extension="${ext}" ContentType="${IMAGE_TYPES[ext]}"/><Default`);
    changed = true;
  }
  if (!xml.includes(`PartName="/${drawingPath}"`)) {
    xml = xml.replace(/<\/Types>\s*$/,
      `<Override PartName="/${drawingPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
    changed = true;
  }
  if (changed) { writeEntry(entry, xml); touched.add('[Content_Types].xml'); }
}

// ---------------------------------------------------------------------------
// Workbook part: defined names and recalculation
// ---------------------------------------------------------------------------

/**
 * Defined names and print areas move with the rows they point at.
 *
 * Unlike a formula, these are written absolute ($A$1:$D$11) as a matter of
 * course, so the "never touch an absolute row" rule that protects a deliberate
 * anchor in a formula would here mean every print area silently stops covering
 * the table it was drawn around.
 */
function fixWorkbook(zip, workbookPath, sheets, mappers, touched, opts) {
  const entry = zip.byName.get(workbookPath);
  if (!entry) return;
  let xml = readText(entry);
  let changed = false;

  const names = findElements(xml, 'definedName');
  if (names.length) {
    const edits = [];
    for (const el of names) {
      if (el.selfClosing) continue;
      const body = decodeXml(textOf(xml, el));
      const next = body.replace(/((?:'[^']*'|[A-Za-z_][A-Za-z0-9_.]*)!)?(\$?[A-Za-z]{1,3}\$?\d{1,7})(?::(\$?[A-Za-z]{1,3}\$?\d{1,7}))?/g,
        (match, sheetQ, a, b) => {
          if (!sheetQ) return match;
          const sheetName = sheetQ.slice(0, -1).replace(/^'|'$/g, '').replace(/''/g, "'");
          const mapper = mappers.get(sheetName.toLowerCase());
          if (!mapper) return match;
          const bump = (ref, which) => {
            const r = splitRef(ref);
            if (!r) return ref;
            const row = mapper(r.row, which);
            return `${r.colAbs ? '$' : ''}${r.col}${r.rowAbs ? '$' : ''}${row}`;
          };
          return b ? `${sheetQ}${bump(a, 'start')}:${bump(b, 'end')}` : `${sheetQ}${bump(a, 'single')}`;
        });
      if (next !== body) edits.push({ start: el.contentStart, end: el.contentEnd, text: escapeXml(next) });
    }
    if (edits.length) { xml = applyEdits(xml, edits); changed = true; }
  }

  // Cached formula results were dropped when the formulas moved, so the workbook
  // has to ask for a full recalculation or a viewer that trusts the cache shows
  // stale totals.
  if (opts.recalc !== false) {
    const calc = findElements(xml, 'calcPr')[0];
    if (calc) {
      xml = xml.slice(0, calc.start) + setAttr(calc.openTag, 'fullCalcOnLoad', '1') + xml.slice(calc.openEnd);
    } else {
      const ext = xml.indexOf('<extLst');
      const tag = '<calcPr calcId="0" fullCalcOnLoad="1"/>';
      xml = ext !== -1 ? xml.slice(0, ext) + tag + xml.slice(ext) : xml.replace(/<\/workbook>\s*$/, `${tag}</workbook>`);
    }
    changed = true;
  }

  if (changed) { writeEntry(entry, xml); touched.add(workbookPath); }
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

async function render(buffer, data, opts = {}) {
  const zip = readZip(buffer);
  const ctx = makeContext(opts);
  const workbookPath = findWorkbookPath(zip);
  const sheets = listSheets(zip, workbookPath);
  const shared = readSharedStrings(zip);
  const styles = readStyles(zip);
  const touched = new Set();
  const stats = { tags: 0, resolved: 0, sections: 0, images: 0, parts: [] };
  const env = { ctx, stats, images: [], sheetName: '', referenced: null };

  const preps = [];
  for (const sheet of sheets) {
    const prep = prepareSheet(zip, sheet, shared, styles);
    if (prep) preps.push({ sheet, prep });
  }
  const referenced = collectFormulaRanges(preps);

  // Pass one: expand every sheet and number its rows. Formulas are left until
  // pass two because a summary sheet may reference a row on another sheet that
  // has not been expanded yet.
  const states = new Map();
  for (const { sheet, prep } of preps) {
    stats.tags += prep.tagCount;
    env.images = [];
    env.referenced = referenced.get(sheet.name.toLowerCase()) || null;
    const stack = [{ value: data, meta: {} }];
    const state = renderSheet(prep, sheet, stack, env);
    state.prep = prep;
    state.imageRequests = env.images;
    states.set(sheet.path, { sheet, state });
  }

  const mappers = new Map();
  for (const { sheet, state } of states.values()) {
    mappers.set(sheet.name.toLowerCase(), makeRowMapper(state.occ, state.sortedSrc, state.tailDelta));
  }

  // Pass two: write the sheets out, now that every row mapping exists.
  for (const { sheet, state } of states.values()) {
    const xml = emitSheet(state, sheet, mappers);
    if (xml !== state.prep.xml) {
      writeEntry(state.prep.entry, xml);
      touched.add(sheet.path);
    }
    for (const path of drawingPartsFor(zip, sheet)) {
      const stack = [{ value: data, meta: {} }];
      if (renderDrawing(zip, path, sheet, state, stack, env)) touched.add(path);
    }
    fixTableParts(zip, sheet, state.occ, makeRowMapper(state.occ, state.sortedSrc, state.tailDelta), touched);
  }

  // Images last: they add parts, and the anchors need the final row numbers.
  for (const { sheet, state } of states.values()) {
    const requests = [];
    for (const req of state.imageRequests) {
      ctx.location = `${sheet.name}!${req.cell.col}${req.srcRow}`;
      const { found, value } = lookup(req.tag.path, [...req.stack]);
      if (!found) {
        if (ctx.onMissing === 'empty' || ctx.onMissing === 'keep') continue;
        throw new TemplateError('placeholder_unresolved',
          `The template uses {%${req.tag.path}} but the data has no "${req.tag.path}".`, {
            field: req.tag.path,
            location: ctx.location,
            hint: `Add "${req.tag.path}" to the data as base64 image data, or remove the {%${req.tag.path}} placeholder.`,
          });
      }
      if (value === null || value === undefined || value === '') continue;
      const outRow = state.outRows.find((r) => r.cells.includes(req.out));
      requests.push({
        col: req.cell.col,
        newRow: outRow ? outRow.newRow : req.srcRow,
        tag: req.tag,
        image: decodeImage(value, req.tag, ctx),
      });
    }
    if (requests.length) {
      attachImages(zip, sheet, requests, touched);
      touched.add(sheet.path);
      stats.images += requests.length;
    }
  }

  fixWorkbook(zip, workbookPath, sheets, mappers, touched, opts);

  stats.parts = [...touched].sort();
  return { buffer: writeZip(zip), stats };
}

/**
 * Lists what a template asks for, without any data and without ever throwing on
 * something it cannot resolve — it is what powers the "fields" endpoint people
 * call before they have built their payload.
 */
async function inspect(buffer) {
  const zip = readZip(buffer);
  const workbookPath = findWorkbookPath(zip);
  const sheets = listSheets(zip, workbookPath);
  const shared = readSharedStrings(zip);
  const styles = readStyles(zip);
  const tags = [];
  const fields = new Set();
  const parts = new Set();

  const note = (tag, location) => {
    if (tag.kind === KIND.COMMENT || tag.kind === KIND.CLOSE) return;
    tags.push({ expr: tag.expr, kind: tag.kind, location });
    const path = String(tag.path || '').replace(/^(\.\.\/)+/, '');
    if (path && path !== '.' && !path.startsWith('$')) fields.add(path);
  };

  for (const sheet of sheets) {
    const prep = prepareSheet(zip, sheet, shared, styles);
    if (!prep) continue;
    let any = false;
    for (const row of prep.parsed.rows) {
      for (const cell of row.cells) {
        if (!cell.tags || !cell.tags.length) continue;
        any = true;
        for (const tag of cell.tags) note(tag, `${sheet.name}!${cell.col}${row.r}`);
      }
    }
    if (any) parts.add(sheet.path);

    for (const path of drawingPartsFor(zip, sheet)) {
      const entry = zip.byName.get(path);
      if (!entry) continue;
      const xml = readText(entry);
      findElements(xml, 'a:p').forEach((p, idx) => {
        const flat = flatten(textOf(xml, p), 'a:t');
        for (const tag of scan(flat.text)) {
          note(tag, `${sheet.name}, shape text ${idx + 1}`);
          parts.add(path);
        }
      });
    }
  }

  return { format: 'xlsx', parts: [...parts].sort(), tags, fields: [...fields].sort() };
}

module.exports = { render, inspect, toExcelSerial, colToNum, numToCol, rewriteFormula, translateFormula };
