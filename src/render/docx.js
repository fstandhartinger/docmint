'use strict';

const {
  readZip, readText, writeEntry, addEntry, writeZip,
} = require('../ooxml/zip');
const {
  findTagEnd, setAttr, applyEdits, escapeXml, stripInvalidXmlChars,
} = require('../ooxml/xml');
const { flatten, splice } = require('../ooxml/runs');
const { scan } = require('../template/scan');
const {
  makeContext, resolveValue, resolveSection, resolveInverted, lookup, visibleKeys,
} = require('../template/resolve');
const { TemplateError, didYouMean } = require('../template/errors');

/**
 * The WordprocessingML renderer.
 *
 * Two phases, deliberately separated.
 *
 *   Phase A (parse)  turns a part into a tree of nodes without ever looking at the
 *                    data: literal XML, paragraphs, tables, and sections whose
 *                    body is a list of sibling nodes.
 *   Phase B (render) walks that tree with a scope stack and emits XML.
 *
 * The separation is what makes nesting work. The obvious implementation — find
 * `{#items}`, find `{/items}`, duplicate the text in between, repeat — collapses
 * the first time a loop contains another loop, because the second `{/}` it finds
 * belongs to the inner section. It also collapses on the case this product exists
 * for: a `{#items}` in the first cell of a table row and `{/items}` in the last,
 * where the thing that must repeat is the whole `<w:tr>`, not the text between the
 * two tags. Matching open to close with a stack, at the right structural level,
 * and only then expanding, handles both.
 *
 * It also gives `inspect()` for free: phase A alone answers "what does this
 * template need", with locations, without any data and without any risk of
 * throwing on a field the caller has not supplied yet.
 *
 * The structural levels, and what "repeat" means at each:
 *
 *   body / table cell   children are <w:p> and <w:tbl>. A section spanning several
 *                       children repeats the children strictly between the markers;
 *                       a marker paragraph that holds nothing else is deleted, so a
 *                       loop leaves no blank lines behind.
 *   table               children are <w:tr>. A section whose two markers are not
 *                       inside the same <w:tc> repeats whole rows, markers included
 *                       — this is the invoice line-item case.
 *   paragraph           runs are split at the marker positions so a section body is
 *                       always a whole number of runs, then those runs repeat.
 */

const EMU_PER_PX = 9525;          // 1 px at 96 DPI
const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

/** Elements whose children are block content and which we pass straight through. */
const TRANSPARENT = new Set([
  'w:body', 'w:hdr', 'w:ftr', 'w:footnote', 'w:endnote', 'w:footnotes', 'w:endnotes',
  'w:comment', 'w:comments', 'w:sdt', 'w:sdtContent', 'w:txbxContent', 'w:customXml',
]);

// ---------------------------------------------------------------------------
// XML structure walking
//
// xml.js deliberately has no parser, and findElements() searches a whole string,
// so it would happily return the paragraphs inside a table when asked for the
// paragraphs of a body. Everything here needs *direct children*, so this walks
// one level at a time.
// ---------------------------------------------------------------------------

/** Index just past `</tag>` matching an element already opened at `from`. */
function findClose(xml, tag, from, limit) {
  const closeStr = `</${tag}>`;
  const openRe = new RegExp(`<${tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=[\\s/>])`, 'g');
  let depth = 1;
  let p = from;
  while (p < limit) {
    const nextClose = xml.indexOf(closeStr, p);
    if (nextClose === -1 || nextClose >= limit) return -1;
    openRe.lastIndex = p;
    let m;
    while ((m = openRe.exec(xml)) && m.index < nextClose) {
      const te = findTagEnd(xml, m.index);
      if (te === -1) break;
      if (xml[te - 2] !== '/') depth += 1;
      openRe.lastIndex = te;
    }
    depth -= 1;
    if (depth === 0) return nextClose + closeStr.length;
    p = nextClose + closeStr.length;
  }
  return -1;
}

/**
 * Direct children of the range `from`..`to`, covering it completely: elements,
 * comments, processing instructions and the text between them. Nothing is
 * dropped, because anything dropped is fidelity lost from a file someone spent
 * an afternoon formatting.
 */
function children(xml, from, to) {
  const out = [];
  let p = from;
  while (p < to) {
    const lt = xml.indexOf('<', p);
    if (lt === -1 || lt >= to) break;
    if (lt > p) out.push({ tag: null, start: p, end: lt });

    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      const end = e === -1 ? to : e + 3;
      out.push({ tag: '#comment', start: lt, end });
      p = end;
      continue;
    }
    if (xml.startsWith('<?', lt) || xml.startsWith('<!', lt)) {
      const e = xml.indexOf('>', lt);
      const end = e === -1 ? to : e + 1;
      out.push({ tag: '#pi', start: lt, end });
      p = end;
      continue;
    }

    const nameM = /^<([^\s/>]+)/.exec(xml.slice(lt, Math.min(lt + 200, to)));
    const openEnd = findTagEnd(xml, lt);
    if (!nameM || openEnd === -1) { p = lt + 1; continue; }
    const name = nameM[1];

    if (xml[openEnd - 2] === '/') {
      out.push({
        tag: name, start: lt, end: openEnd, openEnd, openTag: xml.slice(lt, openEnd),
        contentStart: openEnd, contentEnd: openEnd, selfClosing: true,
      });
      p = openEnd;
      continue;
    }
    const end = findClose(xml, name, openEnd, to);
    if (end === -1) {
      // Truncated or malformed: take the rest rather than losing it.
      out.push({
        tag: name, start: lt, end: to, openEnd, openTag: xml.slice(lt, openEnd),
        contentStart: openEnd, contentEnd: to, selfClosing: false,
      });
      p = to;
      continue;
    }
    out.push({
      tag: name, start: lt, end, openEnd, openTag: xml.slice(lt, openEnd),
      contentStart: openEnd, contentEnd: end - name.length - 3, selfClosing: false,
    });
    p = end;
  }
  if (p < to) out.push({ tag: null, start: p, end: to });
  return out;
}

/** The first real element in a fragment (skipping the XML declaration and space). */
function firstElement(xml) {
  for (const s of children(xml, 0, xml.length)) {
    if (s.tag && s.tag[0] !== '#') return s;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Text encoding
// ---------------------------------------------------------------------------

// A replacement is written inside a <w:t>, and <w:br/> is not allowed there. So a
// newline closes the text element, emits the break, and opens a new one — which
// lands inside the same run and therefore keeps the placeholder's formatting.
// Without this a multi-line address arrives in Word as one long line, or, worse,
// as a literal newline that Word normalises to a space.
const BR = '</w:t><w:br/><w:t xml:space="preserve">';
const TAB = '</w:t><w:tab/><w:t xml:space="preserve">';

function encodeDocxText(s) {
  const t = stripInvalidXmlChars(String(s)).replace(/\r\n?/g, '\n');
  return t.split('\n')
    .map((line) => line.split('\t').map(escapeXml).join(TAB))
    .join(BR);
}

// ---------------------------------------------------------------------------
// Phase A — parsing a part into a tree
// ---------------------------------------------------------------------------

const SECTION_KINDS = new Set(['section', 'inverted']);

function isMarker(t) { return SECTION_KINDS.has(t.kind) || t.kind === 'close'; }

/** Builds the per-unit records a level works on: XML, its flat text, its tags. */
function makeUnits(xml, segs, cx) {
  const units = [];
  let base = 0;
  for (const seg of segs) {
    const sx = xml.slice(seg.start, seg.end);
    const text = seg.tag ? flatten(sx, 'w:t').text : '';
    const tags = text ? scan(text) : [];
    for (const t of tags) t.id = cx.tagSeq++;
    units.push({ seg, xml: sx, text, tags, base });
    base += text.length;
  }
  return units;
}

/** Deletes the given tags' text, leaving the runs and their formatting behind. */
function blankTags(xml, tags) {
  if (!tags.length) return xml;
  const flat = flatten(xml, 'w:t');
  return splice(xml, flat, tags.map((t) => ({ start: t.start, end: t.end, text: '' })));
}

/**
 * Is this unit nothing but section markers? Such a paragraph or row exists only to
 * carry the marker and must vanish, otherwise every loop leaves a blank line (or a
 * blank table row) where its opening tag used to be, which reads as a bug.
 */
function markerOnly(unit, tags) {
  if (/<w:drawing[\s>]|<w:pict[\s>]|<w:object[\s>]/.test(unit.xml)) return false;
  let t = unit.text;
  for (const m of [...tags].sort((a, b) => b.start - a.start)) t = t.slice(0, m.start) + t.slice(m.end);
  return t.trim() === '';
}

function sectionError(code, message, tag, cx, hint) {
  return new TemplateError(code, message, {
    field: tag ? tag.path : null,
    location: cx.locPrefix ? `${cx.part}, ${cx.locPrefix}` : cx.part,
    hint,
  });
}

/**
 * The heart of phase A: match section markers across the units of one level and
 * build the sibling tree.
 *
 * @param {(pair)=>boolean} ownedTest  true when this level is the one that has to
 *   expand the pair — i.e. no deeper level can, because the two markers do not sit
 *   inside a single child that we are going to recurse into.
 * @param {boolean} repeatBoundary  whether the units holding the markers are part
 *   of what repeats. True for table rows (the row with `{#items}` in it *is* the
 *   line item), false for paragraphs (the paragraph holding `{#items}` is a
 *   heading that must not be repeated).
 */
function buildLevel(units, ownedTest, repeatBoundary, parseUnit, cx) {
  const markers = [];
  units.forEach((u, i) => {
    for (const t of u.tags) if (isMarker(t)) markers.push({ unit: i, tag: t, pos: u.base + t.start });
  });

  const openStack = [];
  const pairs = [];
  for (const m of markers) {
    if (m.tag.kind === 'close') {
      const o = openStack.pop();
      if (!o) {
        throw sectionError('section_unbalanced',
          `The template has a closing {${m.tag.raw.replace(/^\{+|\}+$/g, '')}} with no matching {#...} before it.`,
          m.tag, cx, 'Every {/name} needs a {#name} or {^name} that opens it earlier in the document.');
      }
      if (m.tag.path && o.tag.path !== m.tag.path) {
        throw sectionError('section_mismatch',
          `{/${m.tag.path}} closes a section, but the section still open here is {#${o.tag.path}}.`,
          m.tag, cx, `Close them in order: {/${o.tag.path}} first, or write {/} to close whichever is innermost.`);
      }
      pairs.push({ o, c: m });
    } else {
      openStack.push(m);
    }
  }
  if (openStack.length) {
    const m = openStack[openStack.length - 1];
    throw sectionError('section_unclosed',
      `The section {${m.tag.kind === 'inverted' ? '^' : '#'}${m.tag.path}} is opened but never closed.`,
      m.tag, cx, `Add {/${m.tag.path}} where the section should end.`);
  }

  const owned = new Map();
  for (const p of pairs) {
    if (!ownedTest(p)) continue;
    p.o.pair = p;
    p.c.pair = p;
    if (!owned.has(p.o.unit)) owned.set(p.o.unit, []);
    if (!owned.has(p.c.unit)) owned.set(p.c.unit, []);
    owned.get(p.o.unit).push(p.o);
    owned.get(p.c.unit).push(p.c);
  }

  const root = [];
  let cur = root;
  const stack = [];

  for (let i = 0; i < units.length; i += 1) {
    const u = units[i];
    const ms = (owned.get(i) || []).sort((a, b) => a.tag.start - b.tag.start);
    // Parsed even when it is about to be dropped, so the paragraph and table
    // counters in the location strings stay in step with the template.
    const node = parseUnit(ms.length ? blankTags(u.xml, ms.map((m) => m.tag)) : u.xml, i);
    if (!ms.length) { cur.push(node); continue; }

    const contentful = !markerOnly(u, ms.map((m) => m.tag));
    const firstOpen = ms.findIndex((m) => m.tag.kind !== 'close');
    const firstClose = ms.findIndex((m) => m.tag.kind === 'close');
    let emitAt;
    if (repeatBoundary) emitAt = firstOpen !== -1 ? firstOpen + 1 : (firstClose !== -1 ? firstClose : ms.length);
    else emitAt = firstOpen !== -1 ? firstOpen : ms.length;

    for (let j = 0; j <= ms.length; j += 1) {
      if (j === emitAt && contentful) cur.push(node);
      if (j === ms.length) break;
      const m = ms[j];
      if (m.tag.kind === 'close') {
        const frame = stack.pop();
        frame.list.push({
          k: 'sect', tag: frame.tag, kind: frame.kind, items: cur, loc: frame.loc, id: frame.tag.id,
        });
        cur = frame.list;
      } else {
        stack.push({ tag: m.tag, kind: m.tag.kind, list: cur, loc: node.loc || locHere(cx) });
        cur = [];
      }
    }
  }
  return root;
}

const locHere = (cx) => (cx.locPrefix ? `${cx.part}, ${cx.locPrefix}` : cx.part);

/** Body, header, footer, footnote or table-cell content. */
function parseBlocks(xml, from, to, cx) {
  const units = makeUnits(xml, children(xml, from, to), cx);
  return buildLevel(
    units,
    (p) => p.o.unit !== p.c.unit,
    false,
    (unitXml) => parseBlockUnit(unitXml, cx),
    cx,
  );
}

function parseBlockUnit(unitXml, cx) {
  const el = firstElement(unitXml);
  if (!el || el.selfClosing) return { k: 'xml', xml: unitXml };
  if (el.tag === 'w:p') return parseParagraph(unitXml, cx);
  if (el.tag === 'w:tbl') return parseTable(unitXml, cx);
  if (TRANSPARENT.has(el.tag)) {
    return {
      k: 'wrap',
      open: unitXml.slice(0, el.contentStart),
      close: unitXml.slice(el.contentEnd),
      items: parseBlocks(unitXml, el.contentStart, el.contentEnd, cx),
    };
  }
  return { k: 'xml', xml: unitXml };
}

/** The flat-text range each `<w:tc>` of a row occupies, in the table's coordinates. */
function cellRangesOf(rowXml, base) {
  const el = firstElement(rowXml);
  if (!el) return [];
  const out = [];
  let pos = base;
  for (const s of children(rowXml, el.contentStart, el.contentEnd)) {
    const len = s.tag ? flatten(rowXml.slice(s.start, s.end), 'w:t').text.length : 0;
    if (s.tag === 'w:tc') out.push({ from: pos, to: pos + len });
    pos += len;
  }
  return out;
}

function parseTable(tblXml, cx) {
  const tno = cx.tableNo += 1;
  const el = firstElement(tblXml);
  const units = makeUnits(tblXml, children(tblXml, el.contentStart, el.contentEnd), cx);

  // A pair whose markers sit in one cell can be handled inside that cell; anything
  // wider than a cell can only be expressed by repeating rows.
  const cells = [];
  const rowNumbers = [];
  let rowNo = 0;
  for (const u of units) {
    if (u.seg.tag === 'w:tr') {
      rowNo += 1;
      rowNumbers.push(rowNo);
      cells.push(...cellRangesOf(u.xml, u.base));
    } else {
      rowNumbers.push(0);
    }
  }
  const inSameCell = (a, b) => cells.some((c) => a >= c.from && a < c.to && b >= c.from && b < c.to);

  const items = buildLevel(
    units,
    (p) => !inSameCell(p.o.pos, p.c.pos),
    true,
    (unitXml, i) => (units[i].seg.tag === 'w:tr'
      ? parseRow(unitXml, cx, tno, rowNumbers[i])
      : { k: 'xml', xml: unitXml }),
    cx,
  );

  return {
    k: 'wrap',
    open: tblXml.slice(0, el.contentStart),
    close: tblXml.slice(el.contentEnd),
    items,
  };
}

function parseRow(rowXml, cx, tno, rno) {
  const el = firstElement(rowXml);
  const prefix = `table ${tno} row ${rno}`;
  const saved = cx.locPrefix;
  const items = [];
  for (const s of children(rowXml, el.contentStart, el.contentEnd)) {
    const sx = rowXml.slice(s.start, s.end);
    if (s.tag !== 'w:tc') { items.push({ k: 'xml', xml: sx }); continue; }
    const ce = firstElement(sx);
    cx.locPrefix = prefix;
    items.push({
      k: 'wrap',
      open: sx.slice(0, ce.contentStart),
      close: sx.slice(ce.contentEnd),
      items: parseBlocks(sx, ce.contentStart, ce.contentEnd, cx),
    });
    cx.locPrefix = saved;
  }
  return {
    k: 'wrap',
    open: rowXml.slice(0, el.contentStart),
    close: rowXml.slice(el.contentEnd),
    items,
    loc: `${cx.part}, ${prefix}`,
  };
}

// --- paragraphs -------------------------------------------------------------

/**
 * Splits one run so that every offset in `cuts` (in the paragraph's flat-text
 * coordinates) falls on a run boundary. The rPr is copied into each piece, so the
 * text keeps its bold/italic/colour on both sides of the cut.
 */
function splitOneRun(runXml, base, cuts) {
  const el = firstElement(runXml);
  const segs = children(runXml, el.contentStart, el.contentEnd);
  let rPr = '';
  let startIdx = 0;
  for (let i = 0; i < segs.length; i += 1) {
    if (!segs[i].tag) continue;
    if (segs[i].tag === 'w:rPr') { rPr = runXml.slice(segs[i].start, segs[i].end); startIdx = i + 1; }
    break;
  }

  const pieces = [];
  let cur = '';
  let pos = base;
  let ci = 0;
  const flush = () => { pieces.push(cur); cur = ''; ci += 1; };

  for (let i = startIdx; i < segs.length; i += 1) {
    const s = segs[i];
    const sx = runXml.slice(s.start, s.end);
    if (s.tag !== 'w:t') {
      // A <w:br/>, <w:tab/> or a drawing: no text, so it just belongs to whichever
      // side of the cut it is written on.
      while (ci < cuts.length && cuts[ci] <= pos) flush();
      cur += sx;
      continue;
    }
    const node = flatten(sx, 'w:t').nodes[0];
    const decoded = node ? node.decoded : '';
    const openTag = node ? node.openTag : '<w:t>';
    let from = 0;
    while (ci < cuts.length && cuts[ci] <= pos + decoded.length) {
      const c = cuts[ci];
      if (c <= pos) { flush(); continue; }
      cur += makeTextEl(openTag, decoded.slice(from, c - pos));
      from = c - pos;
      flush();
    }
    if (from < decoded.length) cur += makeTextEl(openTag, decoded.slice(from));
    pos += decoded.length;
  }
  pieces.push(cur);

  const open = runXml.slice(el.start, el.openEnd);
  return pieces.map((p) => `${open}${rPr}${p}</w:r>`).join('');
}

function makeTextEl(openTag, text) {
  if (text === '') return '';
  let open = openTag.endsWith('/>') ? `${openTag.slice(0, -2)}>` : openTag;
  if (/^\s|\s$/.test(text)) open = setAttr(open, 'xml:space', 'preserve');
  return `${open}${escapeXml(text)}</w:t>`;
}

function splitRuns(pXml, cuts) {
  if (!cuts.length) return pXml;
  const el = firstElement(pXml);
  const edits = [];
  let pos = 0;
  for (const s of children(pXml, el.contentStart, el.contentEnd)) {
    const sx = pXml.slice(s.start, s.end);
    const len = s.tag ? flatten(sx, 'w:t').text.length : 0;
    const from = pos;
    pos += len;
    if (s.tag !== 'w:r' || !len) continue;
    const inner = cuts.filter((c) => c > from && c < pos);
    if (inner.length) edits.push({ start: s.start, end: s.end, text: splitOneRun(sx, from, inner) });
  }
  return applyEdits(pXml, edits);
}

function parseParagraph(pXml, cx) {
  const paraNo = cx.paraNo += 1;
  const loc = cx.locPrefix
    ? `${cx.part}, ${cx.locPrefix}, paragraph ${paraNo}`
    : `${cx.part}, paragraph ${paraNo}`;

  const el = firstElement(pXml);
  if (!el || el.selfClosing) return { k: 'xml', xml: pXml };

  const flat = flatten(pXml, 'w:t');
  const tags = flat.text ? scan(flat.text) : [];
  for (const t of tags) t.id = cx.tagSeq++;

  // Image and raw tags need the same treatment as section markers: what replaces
  // them is an element (<w:drawing>, arbitrary OOXML) which cannot live inside the
  // <w:t> the tag was written in, so the run has to be cut at that point.
  const cutTags = tags.filter((t) => isMarker(t) || t.kind === 'image' || t.kind === 'raw');

  if (!cutTags.length) {
    const chunkXml = pXml.slice(el.contentStart, el.contentEnd);
    return {
      k: 'para',
      prefix: pXml.slice(0, el.contentStart),
      close: pXml.slice(el.contentEnd),
      items: [makeChunk(chunkXml, loc, cx)],
      loc,
    };
  }

  // A paragraph that is nothing but {@raw} replaces itself, so a caller can inject
  // whole paragraphs or a table without ending up with a <w:p> inside a <w:p>.
  if (cutTags.length === 1 && cutTags[0].kind === 'raw'
      && flat.text.slice(0, cutTags[0].start).trim() === ''
      && flat.text.slice(cutTags[0].end).trim() === '') {
    return { k: 'raw', tag: cutTags[0], loc, id: cutTags[0].id, block: true };
  }

  const blanked = blankTags(pXml, cutTags);
  // Where each cut lands once the tag text itself is gone.
  let removed = 0;
  const cuts = [];
  for (const t of cutTags) {
    cuts.push({ offset: t.start - removed, tag: t });
    removed += t.end - t.start;
  }

  const split = splitRuns(blanked, cuts.map((c) => c.offset));
  return buildParagraphNode(split, cuts, loc, cx);
}

function makeChunk(chunkXml, loc, cx) {
  const text = flatten(chunkXml, 'w:t').text;
  const tags = text ? scan(text).filter((t) => !isMarker(t)) : [];
  for (const t of tags) if (t.id === undefined) t.id = cx.tagSeq++;
  return { k: 'chunk', xml: chunkXml, tags, loc };
}

function buildParagraphNode(pXml, cuts, loc, cx) {
  const el = firstElement(pXml);
  const segs = children(pXml, el.contentStart, el.contentEnd);

  // <w:pPr> must stay the first child of the paragraph, so it never becomes part
  // of anything that repeats.
  let prefixEnd = el.contentStart;
  let first = 0;
  while (first < segs.length && !segs[first].tag) { prefixEnd = segs[first].end; first += 1; }
  if (first < segs.length && segs[first].tag === 'w:pPr') { prefixEnd = segs[first].end; first += 1; }
  const content = segs.slice(first);

  const ranges = [];
  let pos = 0;
  for (const s of content) {
    const len = s.tag ? flatten(pXml.slice(s.start, s.end), 'w:t').text.length : 0;
    ranges.push({ from: pos, to: pos + len });
    pos += len;
  }

  const root = [];
  let cur = root;
  const stack = [];
  let si = 0;
  let chunkStart = 0;

  const pushChunk = (a, b) => {
    if (b <= a) return;
    const xml = pXml.slice(content[a].start, content[b - 1].end);
    cur.push(makeChunk(xml, loc, cx));
  };

  for (const cut of cuts) {
    while (si < content.length && ranges[si].from < cut.offset) si += 1;
    pushChunk(chunkStart, si);
    chunkStart = si;

    const t = cut.tag;
    if (t.kind === 'close') {
      const frame = stack.pop();
      if (!frame) {
        throw sectionError('section_unbalanced',
          `The template has a closing {${t.raw.replace(/^\{+|\}+$/g, '')}} with no matching {#...} before it.`,
          t, cx, 'Every {/name} needs a {#name} or {^name} that opens it earlier.');
      }
      frame.list.push({ k: 'sect', tag: frame.tag, kind: frame.kind, items: cur, loc, id: frame.tag.id });
      cur = frame.list;
    } else if (SECTION_KINDS.has(t.kind)) {
      stack.push({ tag: t, kind: t.kind, list: cur });
      cur = [];
    } else if (t.kind === 'image') {
      cur.push({ k: 'image', tag: t, loc, id: t.id });
    } else {
      cur.push({ k: 'raw', tag: t, loc, id: t.id });
    }
  }
  pushChunk(chunkStart, content.length);

  if (stack.length) {
    const frame = stack[stack.length - 1];
    throw sectionError('section_unclosed',
      `The section {${frame.kind === 'inverted' ? '^' : '#'}${frame.tag.path}} is opened but never closed.`,
      frame.tag, cx, `Add {/${frame.tag.path}} where the section should end.`);
  }

  return {
    k: 'para',
    prefix: pXml.slice(0, prefixEnd),
    close: pXml.slice(el.contentEnd),
    items: root,
    loc,
  };
}

function parsePart(xml, partName, seq) {
  // The tag ids must be unique across the whole package, not just this part, or a
  // header tag and a body tag collide and the "resolved" count silently under-reports.
  const cx = {
    part: partName, paraNo: 0, tableNo: 0, locPrefix: null,
    get tagSeq() { return seq.n; },
    set tagSeq(v) { seq.n = v; },
  };
  const el = firstElement(xml);
  if (!el) return { items: [{ k: 'xml', xml }], head: '', tail: '', cx };
  return {
    head: xml.slice(0, el.contentStart),
    tail: xml.slice(el.contentEnd),
    items: parseBlocks(xml, el.contentStart, el.contentEnd, cx),
    cx,
  };
}

// ---------------------------------------------------------------------------
// Phase B — rendering
// ---------------------------------------------------------------------------

function renderItems(items, stack, job) {
  let out = '';
  for (const it of items) out += renderItem(it, stack, job);
  return out;
}

function renderItem(it, stack, job) {
  switch (it.k) {
    case 'xml': return it.xml;
    case 'wrap': return it.open + renderItems(it.items, stack, job) + it.close;
    case 'para': return it.prefix + renderItems(it.items, stack, job) + it.close;
    case 'chunk': return renderChunk(it, stack, job);
    case 'sect': return renderSection(it, stack, job);
    case 'image': return renderImage(it, stack, job);
    case 'raw': return renderRaw(it, stack, job);
    default: return '';
  }
}

function renderChunk(node, stack, job) {
  if (!node.tags.length) return node.xml;
  const flat = flatten(node.xml, 'w:t');
  const edits = [];
  for (const t of node.tags) {
    job.ctx.location = node.loc;
    const text = t.kind === 'comment' ? '' : resolveValue(t, stack, job.ctx);
    edits.push({ start: t.start, end: t.end, text: encodeDocxText(text) });
    job.st.resolved.add(t.id);
  }
  return splice(node.xml, flat, edits);
}

function renderSection(node, stack, job) {
  job.ctx.location = node.loc;
  const res = node.kind === 'inverted'
    ? resolveInverted(node.tag, stack, job.ctx)
    : resolveSection(node.tag, stack, job.ctx);
  job.st.resolved.add(node.id);
  let out = '';
  for (const pass of res.passes) {
    out += renderItems(node.items, stack.concat([{ value: pass.value, meta: pass.meta }]), job);
  }
  return out;
}

function renderRaw(node, stack, job) {
  job.ctx.location = node.loc;
  const { found, value } = lookup(node.tag.path, stack);
  if (!found) {
    if (job.ctx.onMissing === 'empty') return '';
    if (job.ctx.onMissing === 'keep') return '';
    const available = visibleKeys(stack);
    throw new TemplateError('placeholder_unresolved',
      `The template inserts raw OOXML with {@${node.tag.path}} but the data has no "${node.tag.path}".`, {
        field: node.tag.path,
        location: node.loc,
        available: available.slice(0, 40),
        hint: hintFor(node.tag.path, available),
      });
  }
  job.st.resolved.add(node.id);
  if (value === null || value === undefined) return '';
  return stripInvalidXmlChars(String(value));
}

const hintFor = (path, available) => {
  const guess = didYouMean(path.split('.').pop(), available);
  return guess
    ? `Did you mean "${guess}"? Otherwise add "${path}" to the data.`
    : `Add "${path}" to the data.`;
};

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/**
 * Intrinsic pixel size from the file's own header. Reading it here rather than
 * asking the caller for width and height is the difference between "the logo is
 * the right shape" and "the logo is a square regardless of what you sent".
 * The format is taken from the magic bytes: the name a caller gives a file, or
 * the mime type they claim in a data URI, is wrong often enough to matter.
 */
function imageInfo(buf) {
  if (buf.length >= 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) { i += 1; continue; }
      const marker = buf[i + 1];
      if (marker === 0xff) { i += 1; continue; }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
      if (marker === 0xd9) break;
      const len = buf.readUInt16BE(i + 2);
      // SOF0..SOF15 carry the frame size; DHT/DAC/DNL share the range and do not.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpeg', mime: 'image/jpeg', height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
      }
      if (len < 2) break;
      i += 2 + len;
    }
    return { ext: 'jpeg', mime: 'image/jpeg', width: 0, height: 0 };
  }
  if (buf.length >= 10 && buf.toString('latin1', 0, 3) === 'GIF') {
    return { ext: 'gif', mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) {
    return { ext: 'bmp', mime: 'image/bmp', width: buf.readInt32LE(18), height: Math.abs(buf.readInt32LE(22)) };
  }
  throw new TemplateError('image_unsupported_format',
    'That image is not a PNG, JPEG, GIF or BMP — its first bytes match no format DocMint can embed.', {
      hint: 'Send a PNG or JPEG, either as a data URI ("data:image/png;base64,...") or as plain base64.',
    });
}

function toBytes(src, tag) {
  if (Buffer.isBuffer(src)) return src;
  if (src instanceof Uint8Array) return Buffer.from(src);
  if (typeof src !== 'string') {
    throw new TemplateError('image_invalid', `{%${tag.path}} is not something DocMint can read as an image.`, {
      field: tag.path,
      hint: 'Send base64, a data URI, or an object like {"data": "<base64>", "width": 120}.',
    });
  }
  const m = /^data:([^;,]*)(;base64)?,/i.exec(src.trim());
  const body = m ? src.trim().slice(m[0].length) : src;
  if (m && !m[2]) {
    throw new TemplateError('image_invalid', `{%${tag.path}} is a data URI that is not base64-encoded.`, {
      field: tag.path, hint: 'Use "data:image/png;base64,...".',
    });
  }
  const cleaned = body.replace(/\s+/g, '');
  if (!cleaned || !/^[A-Za-z0-9+/=_-]+$/.test(cleaned)) {
    throw new TemplateError('image_invalid', `{%${tag.path}} does not look like base64 image data.`, {
      field: tag.path,
      hint: 'Send the image as base64, a data URI, or bytes.',
    });
  }
  const buf = Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!buf.length) {
    throw new TemplateError('image_invalid', `{%${tag.path}} decoded to zero bytes.`, { field: tag.path });
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    throw new TemplateError('image_too_large',
      `The image for {%${tag.path}} is ${Math.round(buf.length / 1048576)} MB, over the ${MAX_IMAGE_BYTES / 1048576} MB limit.`,
      { field: tag.path });
  }
  return buf;
}

const isUrl = (s) => typeof s === 'string' && /^(https?:|file:)\/\//i.test(s.trim());

function urlUnsupported(tag, url) {
  return new TemplateError('image_url_unsupported',
    `{%${tag.path}} points at a URL (${String(url).slice(0, 120)}), and this renderer does not fetch images.`, {
      field: tag.path,
      hint: 'Pass the image itself: base64 or a data URI in the data, or supply the bytes through the "images" option keyed by the URL.',
    });
}

/** Turns whatever the caller put in the data into bytes plus a size in pixels. */
function imagePayload(tag, value, job) {
  let spec = value;
  if (Buffer.isBuffer(value) || value instanceof Uint8Array || typeof value === 'string') spec = { data: value };
  if (!spec || typeof spec !== 'object') {
    throw new TemplateError('image_invalid',
      `{%${tag.path}} is a ${typeof value}, which is not an image.`, {
        field: tag.path,
        hint: 'Send base64, a data URI, or {"data": "<base64>", "width": 120, "height": 40}.',
      });
  }

  let src = spec.data ?? spec.base64 ?? spec.bytes ?? spec.content ?? null;
  const url = spec.url ?? spec.href ?? (isUrl(src) ? src : null);
  if (url) {
    const supplied = job.images.get(url) ?? job.images.get(tag.path);
    if (supplied === undefined || supplied === null) throw urlUnsupported(tag, url);
    src = (typeof supplied === 'object' && !Buffer.isBuffer(supplied) && !(supplied instanceof Uint8Array))
      ? (supplied.data ?? supplied.base64 ?? supplied.bytes)
      : supplied;
  }
  if (src === null || src === undefined) {
    throw new TemplateError('image_invalid',
      `{%${tag.path}} has no image data — expected "data", "base64" or "url".`, {
        field: tag.path,
        hint: 'e.g. {"logo": {"data": "<base64 png>", "width": 120}}.',
      });
  }

  const bytes = toBytes(src, tag);
  const info = imageInfo(bytes);
  const px = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    const n = typeof v === 'number' ? v : Number(String(v).replace(/px$/i, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
  };
  let w = px(spec.width);
  let h = px(spec.height);
  const iw = info.width || 0;
  const ih = info.height || 0;
  if (!w && !h) { w = iw || 96; h = ih || 96; } else if (w && !h) {
    h = iw ? Math.max(1, Math.round((w * ih) / iw)) : w;
  } else if (!w && h) {
    w = ih ? Math.max(1, Math.round((h * iw) / ih)) : h;
  }
  return { bytes, info, width: w, height: h, alt: spec.alt || spec.title || tag.path };
}

function drawingXml({ rId, width, height, alt, id, name }) {
  const cx = width * EMU_PER_PX;
  const cy = height * EMU_PER_PX;
  const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
  const WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
  const a = escapeXml(alt);
  const n = escapeXml(name);
  // The namespaces are declared on the elements that use them rather than assumed
  // to be on the part root: a header written by LibreOffice does not always
  // declare wp:, and a missing prefix is an unopenable file.
  return `<w:drawing><wp:inline xmlns:wp="${WP}" distT="0" distB="0" distL="0" distR="0">`
    + `<wp:extent cx="${cx}" cy="${cy}"/>`
    + '<wp:effectExtent l="0" t="0" r="0" b="0"/>'
    + `<wp:docPr id="${id}" name="${n}" descr="${a}"/>`
    + `<wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${A}" noChangeAspect="1"/></wp:cNvGraphicFramePr>`
    + `<a:graphic xmlns:a="${A}"><a:graphicData uri="${PIC}">`
    + `<pic:pic xmlns:pic="${PIC}">`
    + `<pic:nvPicPr><pic:cNvPr id="${id}" name="${n}" descr="${a}"/><pic:cNvPicPr/></pic:nvPicPr>`
    + `<pic:blipFill><a:blip xmlns:r="${R}" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>`
    + `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>'
    + '</pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing>';
}

function renderImage(node, stack, job) {
  job.ctx.location = node.loc;
  const { found, value } = lookup(node.tag.path, stack);
  if (!found) {
    if (job.ctx.onMissing === 'empty' || job.ctx.onMissing === 'keep') return '';
    const available = visibleKeys(stack);
    throw new TemplateError('image_unresolved',
      `The template places an image with {%${node.tag.path}} but the data has no "${node.tag.path}".`, {
        field: node.tag.path,
        location: node.loc,
        available: available.slice(0, 40),
        hint: hintFor(node.tag.path, available),
      });
  }
  if (value === null || value === undefined || value === '') { job.st.resolved.add(node.id); return ''; }

  let payload;
  try {
    payload = imagePayload(node.tag, value, job);
  } catch (e) {
    if (e instanceof TemplateError && !e.location) e.location = node.loc;
    throw e;
  }

  const rId = job.res.addImage(job.part, payload.bytes, payload.info);
  job.st.images += 1;
  job.st.resolved.add(node.id);
  const id = job.res.nextDrawingId();
  return `<w:r>${drawingXml({
    rId, width: payload.width, height: payload.height, alt: payload.alt, id, name: `docmint_${id}`,
  })}</w:r>`;
}

// ---------------------------------------------------------------------------
// Package resources: media parts, relationships, content types
// ---------------------------------------------------------------------------

const IMAGE_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

class Resources {
  constructor(zip) {
    this.zip = zip;
    this.rels = new Map();       // rels part name -> { xml, next }
    this.mediaSeq = 0;
    this.drawingSeq = 1000;
    this.exts = new Set();
    this.byDigest = new Map();   // part -> (digest -> rId), so one logo in a loop is stored once
  }

  nextDrawingId() { this.drawingSeq += 1; return this.drawingSeq; }

  relsNameFor(partName) {
    const slash = partName.lastIndexOf('/');
    return `${partName.slice(0, slash)}/_rels/${partName.slice(slash + 1)}.rels`;
  }

  relsFor(partName) {
    const name = this.relsNameFor(partName);
    if (this.rels.has(name)) return this.rels.get(name);
    const entry = this.zip.byName.get(name);
    const xml = entry
      ? readText(entry)
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>';
    let next = 1;
    for (const m of xml.matchAll(/Id="rId(\d+)"/g)) next = Math.max(next, Number(m[1]) + 1);
    const rec = { name, xml, next, dirty: false };
    this.rels.set(name, rec);
    return rec;
  }

  addImage(partName, bytes, info) {
    const rels = this.relsFor(partName);
    // Identical bytes used by every row of a loop should be one media part, not
    // one per row; a 200-line invoice with a per-line icon otherwise gets huge.
    const digest = `${bytes.length}:${bytes.toString('base64', 0, Math.min(64, bytes.length))}`;
    let perPart = this.byDigest.get(rels.name);
    if (!perPart) { perPart = new Map(); this.byDigest.set(rels.name, perPart); }
    if (perPart.has(digest)) return perPart.get(digest);

    this.mediaSeq += 1;
    const media = `word/media/docmint_${this.mediaSeq}.${info.ext}`;
    addEntry(this.zip, media, bytes);
    this.exts.add(info.ext);

    const rId = `rId${rels.next}`;
    rels.next += 1;
    rels.xml = rels.xml.replace(/<\/Relationships>\s*$/,
      `<Relationship Id="${rId}" Type="${IMAGE_REL}" Target="media/docmint_${this.mediaSeq}.${info.ext}"/></Relationships>`);
    rels.dirty = true;
    perPart.set(digest, rId);
    return rId;
  }

  flush() {
    for (const rec of this.rels.values()) {
      if (!rec.dirty) continue;
      const entry = this.zip.byName.get(rec.name);
      if (entry) writeEntry(entry, rec.xml); else addEntry(this.zip, rec.name, rec.xml);
    }
    if (!this.exts.size) return;
    const ct = this.zip.byName.get('[Content_Types].xml');
    if (!ct) return;
    let xml = readText(ct);
    let changed = false;
    const MIME = { png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp' };
    for (const ext of this.exts) {
      if (new RegExp(`Extension="${ext}"`, 'i').test(xml)) continue;
      xml = xml.replace(/<Types([^>]*)>/, `<Types$1><Default Extension="${ext}" ContentType="${MIME[ext]}"/>`);
      changed = true;
    }
    if (changed) writeEntry(ct, xml);
  }
}

// ---------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------

/**
 * Every part that can hold a placeholder, not just the body.
 *
 * Headers and footers are where the invoice number and the customer name usually
 * live. A renderer that only fills word/document.xml produces a document that
 * looks right in the middle of the page and still says "{invoice_no}" at the top
 * of every page, which is the single most visible way to fail at this job.
 */
function listParts(zip) {
  const names = zip.entries.map((e) => e.name);
  const out = [];
  if (names.includes('word/document.xml')) out.push('word/document.xml');
  const numbered = (re) => names.filter((n) => re.test(n))
    .sort((a, b) => (Number((/(\d+)/.exec(a) || [0, 0])[1]) - Number((/(\d+)/.exec(b) || [0, 0])[1])));
  out.push(...numbered(/^word\/header\d*\.xml$/));
  out.push(...numbered(/^word\/footer\d*\.xml$/));
  for (const n of ['word/footnotes.xml', 'word/endnotes.xml', 'word/comments.xml']) {
    if (names.includes(n)) out.push(n);
  }
  return out;
}

function normalizeImagesOpt(images) {
  const map = new Map();
  if (!images) return map;
  if (images instanceof Map) { for (const [k, v] of images) map.set(String(k), v); return map; }
  for (const [k, v] of Object.entries(images)) map.set(String(k), v);
  return map;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function render(buffer, data, opts = {}) {
  const zip = readZip(buffer);
  const ctx = opts.ctx || makeContext(opts);
  const res = new Resources(zip);
  const st = { tags: 0, sections: 0, images: 0, resolved: new Set(), parts: [] };
  const seq = { n: 0 };
  const images = normalizeImagesOpt(opts.images);
  const root = [{ value: data === null || data === undefined ? {} : data, meta: {} }];

  for (const partName of listParts(zip)) {
    const entry = zip.byName.get(partName);
    const xml = readText(entry);
    // Cheap reject: a part with no brace cannot hold a tag, and not rewriting it
    // keeps its bytes identical to the template's.
    if (xml.indexOf('{') === -1) continue;

    const tree = parsePart(xml, partName, seq);
    const counts = countTree(tree.items);
    if (!counts.tags && !counts.sections) continue;
    st.tags += counts.tags;
    st.sections += counts.sections;

    const job = { ctx, st, res, part: partName, images };
    const out = tree.head + renderItems(tree.items, root, job) + tree.tail;
    if (out !== xml) {
      writeEntry(entry, out);
      st.parts.push(partName);
    }
  }
  res.flush();

  return {
    buffer: writeZip(zip),
    stats: {
      tags: st.tags,
      resolved: st.resolved.size,
      sections: st.sections,
      images: st.images,
      parts: st.parts,
    },
  };
}

function countTree(items, acc = { tags: 0, sections: 0 }) {
  for (const it of items) {
    if (it.k === 'chunk') acc.tags += it.tags.length;
    else if (it.k === 'sect') { acc.tags += 1; acc.sections += 1; countTree(it.items, acc); }
    else if (it.k === 'image' || it.k === 'raw') acc.tags += 1;
    else if (it.items) countTree(it.items, acc);
  }
  return acc;
}

const SPECIAL_PATH = /^(\.|\$[A-Za-z_][A-Za-z0-9_]*)$/;

function collectTags(items, out) {
  for (const it of items) {
    if (it.k === 'chunk') {
      for (const t of it.tags) out.push({ expr: t.expr, kind: t.kind, path: t.path, location: it.loc });
    } else if (it.k === 'sect') {
      out.push({ expr: it.tag.expr, kind: it.kind, path: it.tag.path, location: it.loc });
      collectTags(it.items, out);
    } else if (it.k === 'image' || it.k === 'raw') {
      out.push({ expr: it.tag.expr, kind: it.tag.kind, path: it.tag.path, location: it.loc });
    } else if (it.items) {
      collectTags(it.items, out);
    }
  }
  return out;
}

/**
 * What does this template need? Never touches data, so it cannot fail on a field
 * the caller has not sent yet — that is the whole point of the endpoint it backs.
 */
async function inspect(buffer) {
  const zip = readZip(buffer);
  const parts = [];
  const tags = [];
  const seq = { n: 0 };
  for (const partName of listParts(zip)) {
    const entry = zip.byName.get(partName);
    const xml = readText(entry);
    if (xml.indexOf('{') === -1) continue;
    const tree = parsePart(xml, partName, seq);
    const found = collectTags(tree.items, []);
    if (!found.length) continue;
    parts.push(partName);
    tags.push(...found);
  }
  const fields = [];
  const seen = new Set();
  for (const t of tags) {
    if (t.kind === 'comment' || !t.path) continue;
    const p = t.path.replace(/^(\.\.\/)+/, '');
    if (SPECIAL_PATH.test(p) || seen.has(p)) continue;
    seen.add(p);
    fields.push(p);
  }
  return {
    format: 'docx',
    parts,
    tags: tags.map((t) => ({ expr: t.expr, kind: t.kind, location: t.location })),
    fields,
  };
}

module.exports = { render, inspect, listParts, imageInfo, encodeDocxText };
