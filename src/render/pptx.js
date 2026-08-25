'use strict';

const {
  readZip, readText, writeEntry, addEntry, removeEntry, writeZip, crc32,
} = require('../ooxml/zip');
const {
  findElements, attr, applyEdits, escapeXml, stripInvalidXmlChars,
} = require('../ooxml/xml');
const { flatten, splice } = require('../ooxml/runs');
const { scan, KIND } = require('../template/scan');
const {
  lookup, resolveValue, resolveSection, resolveInverted, makeContext,
} = require('../template/resolve');
const { TemplateError } = require('../template/errors');

/**
 * PPTX rendering.
 *
 * PowerPoint splits runs exactly as badly as Word does, so all text work goes
 * through `runs.flatten` / `runs.splice` — see src/ooxml/runs.js for why.
 *
 * What makes a deck different from a document is the package. A .docx is one
 * body part; a .pptx is a part per slide plus a presentation part that lists
 * them, a relationship file that names them, and a content-type override for
 * each. Duplicating a slide means touching all four in step, and PowerPoint —
 * unlike Word, and unlike LibreOffice which will happily open the wreckage —
 * refuses the whole file if any one of them is inconsistent. The user sees
 * "PowerPoint found a problem with content" and no clue which of our five
 * mistakes caused it. So `selfCheck()` at the bottom re-derives the invariants
 * from the finished package and throws before we ever hand the bytes back.
 */

const PRESENTATION = 'ppt/presentation.xml';
const CONTENT_TYPES = '[Content_Types].xml';

const CT_SLIDE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';
const CT_NOTES = 'application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml';

const REL_SLIDE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const REL_NOTES = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide';
const REL_IMAGE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image';

// PowerPoint requires sldId values in [256, 2147483648).
const SLD_ID_MIN = 256;
const SLD_ID_MAX = 2147483648;

const EMU_PER_PX = 9525; // 914400 EMU/inch at 96 DPI

/**
 * Three private-use characters used as in-band markers.
 *
 * A replacement value is written into an `<a:t>`, but a line break in DrawingML
 * is an `<a:br/>` that must sit *between* runs, and `{@rawXml}` is markup that
 * must not be escaped. Neither can live inside the text node. So the value goes
 * in carrying a marker, and `expandSpecials()` re-splits the enclosing run
 * afterwards, copying the run's `<a:rPr>` onto every piece so the second line of
 * a two-line value keeps the formatting the author gave the placeholder.
 *
 * They are stripped out of literal template text by `encodeLiteral` so a
 * template that somehow contains one cannot forge markup, and `selfCheck()`
 * refuses to emit a part that still has one in it.
 */
const BR = '\uE000';
const RAW_OPEN = '\uE001';
const RAW_CLOSE = '\uE002';
const MARKERS_RE = /[\uE000-\uE002]/g;
const HAS_MARKER_RE = /[\uE000-\uE002]/;

const encodeLiteral = (s) => escapeXml(stripInvalidXmlChars(s).replace(MARKERS_RE, ''));

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------------------
// package helpers
// ---------------------------------------------------------------------------

function relsPathFor(partName) {
  const i = partName.lastIndexOf('/');
  return `${partName.slice(0, i)}/_rels${partName.slice(i)}.rels`;
}

/** `ppt/slides/slide1.xml` + `../media/x.png` -> `ppt/media/x.png`. */
function resolveRelTarget(fromPart, target) {
  if (target.startsWith('/')) return target.slice(1);
  const segs = fromPart.split('/').slice(0, -1);
  for (const seg of target.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') segs.pop();
    else segs.push(seg);
  }
  return segs.join('/');
}

/** `ppt/slides/slide1.xml` -> `ppt/media/x.png` as `../media/x.png`. */
function relativeTarget(fromPart, toPart) {
  const from = fromPart.split('/').slice(0, -1);
  const to = toPart.split('/');
  let i = 0;
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i += 1;
  return [...from.slice(i).map(() => '..'), ...to.slice(i)].join('/');
}

function readRels(zip, path) {
  const entry = zip.byName.get(path);
  if (!entry) return [];
  const xml = readText(entry);
  return findElements(xml, 'Relationship').map((el) => ({
    id: attr(el.openTag, 'Id'),
    type: attr(el.openTag, 'Type'),
    target: attr(el.openTag, 'Target'),
    mode: attr(el.openTag, 'TargetMode'),
  }));
}

function writeRels(zip, path, rels) {
  const body = rels.map((r) => `<Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}" Target="${escapeXml(r.target)}"${r.mode ? ` TargetMode="${escapeXml(r.mode)}"` : ''}/>`).join('');
  addEntry(zip, path,
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\r\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${body}</Relationships>`);
}

/** An rId that no relationship in `rels` is using. */
function freeRelId(rels) {
  const used = new Set(rels.map((r) => r.id));
  let n = rels.length + 1;
  while (used.has(`rId${n}`)) n += 1;
  return `rId${n}`;
}

function ctAddOverride(ct, partName, type) {
  if (ct.includes(`PartName="/${partName}"`)) return ct;
  return ct.replace('</Types>', `<Override PartName="/${partName}" ContentType="${type}"/></Types>`);
}

function ctRemoveOverride(ct, partName) {
  return ct.replace(new RegExp(`<Override[^>]*PartName="/${escapeRe(partName)}"[^>]*/>`, 'g'), '');
}

function ctEnsureDefault(ct, ext, type) {
  if (new RegExp(`<Default[^>]*Extension="${escapeRe(ext)}"`, 'i').test(ct)) return ct;
  return ct.replace(/(<Types[^>]*>)/, `$1<Default Extension="${ext}" ContentType="${type}"/>`);
}

// ---------------------------------------------------------------------------
// image decoding
// ---------------------------------------------------------------------------

/**
 * Intrinsic pixel size straight out of the file header.
 *
 * Forty lines instead of an image library, because the only thing we need is
 * width and height, and a dependency here would be a dependency in the n8n node
 * too. Sniffing the bytes rather than trusting a `data:image/png` label also
 * means a JPEG mislabelled as PNG still lands in the deck with the right
 * content type instead of producing a slide PowerPoint cannot draw.
 */
function probeImage(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47 && buf.readUInt32BE(4) === 0x0d0a1a0a) {
    return { ext: 'png', mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf.length > 10 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) {
    return { ext: 'gif', mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let p = 2;
    while (p + 9 < buf.length) {
      if (buf[p] !== 0xff) { p += 1; continue; }
      const marker = buf[p + 1];
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { p += 2; continue; }
      const len = buf.readUInt16BE(p + 2);
      // SOF0..SOF15 carry the frame size; C4/C8/CC are Huffman/arithmetic tables.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { ext: 'jpeg', mime: 'image/jpeg', height: buf.readUInt16BE(p + 5), width: buf.readUInt16BE(p + 7) };
      }
      p += 2 + len;
    }
    return { ext: 'jpeg', mime: 'image/jpeg', width: 0, height: 0 };
  }
  return null;
}

function decodeBase64Image(str, tag, ctx) {
  let b64 = String(str).trim();
  const m = /^data:([^;,]*)?(;base64)?,/i.exec(b64);
  if (m) {
    if (!m[2]) {
      throw new TemplateError('image_not_base64',
        `{%${tag.expr}} was given a data: URI that is not base64-encoded.`,
        { field: tag.path, location: ctx.location, hint: 'Use a "data:image/png;base64,..." URI, or send the bare base64 string.' });
    }
    b64 = b64.slice(m[0].length);
  }
  if (/^https?:\/\//i.test(b64)) {
    throw new TemplateError('image_url_unsupported',
      `{%${tag.expr}} was given a URL. DocMint does not fetch images over the network.`,
      {
        field: tag.path,
        location: ctx.location,
        hint: 'Download the image in your workflow and pass it as base64, e.g. {"data": "<base64>"} or a "data:image/png;base64,..." string.',
      });
  }
  const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
  if (!buf.length) {
    throw new TemplateError('image_empty', `{%${tag.expr}} resolved to an empty image.`,
      { field: tag.path, location: ctx.location });
  }
  return buf;
}

/**
 * @returns {null|{buf,ext,mime,width,height,wantW,wantH}} null means "the caller
 * said null", which per the missing-field contract renders as nothing.
 */
function decodeImageValue(value, tag, ctx) {
  if (value === null || value === undefined || value === '') return null;

  let raw = value;
  let wantW = null;
  let wantH = null;

  if (typeof value === 'object' && !Buffer.isBuffer(value)) {
    if (value.url || value.href || value.uri) {
      throw new TemplateError('image_url_unsupported',
        `{%${tag.expr}} was given a URL. DocMint does not fetch images over the network.`,
        {
          field: tag.path,
          location: ctx.location,
          hint: 'Download the image in your workflow and pass it as base64, e.g. {"data": "<base64>"} or a "data:image/png;base64,..." string.',
        });
    }
    raw = value.data ?? value.base64 ?? value.src ?? value.content;
    if (raw === null || raw === undefined || raw === '') return null;
    if (value.width !== undefined && value.width !== null) wantW = Number(value.width);
    if (value.height !== undefined && value.height !== null) wantH = Number(value.height);
    if ((wantW !== null && !Number.isFinite(wantW)) || (wantH !== null && !Number.isFinite(wantH))) {
      throw new TemplateError('image_bad_size',
        `{%${tag.expr}} was given a non-numeric width or height.`, { field: tag.path, location: ctx.location });
    }
  }

  const buf = Buffer.isBuffer(raw) ? raw : decodeBase64Image(raw, tag, ctx);
  const probe = probeImage(buf);
  if (!probe) {
    throw new TemplateError('image_unsupported_format',
      `{%${tag.expr}} is not a PNG, JPEG or GIF. Those are the formats PowerPoint embeds without conversion.`,
      { field: tag.path, location: ctx.location, hint: 'Convert the image to PNG or JPEG before sending it.' });
  }
  const width = wantW || probe.width || 320;
  const height = wantH || probe.height || 240;
  return { buf, ext: probe.ext, mime: probe.mime, width, height, natural: probe };
}

function resolveImage(tag, stack, ctx) {
  const hit = lookup(tag.path, stack);
  let value = hit.found ? hit.value : undefined;
  if (!hit.found && ctx.imagesOpt && Object.prototype.hasOwnProperty.call(ctx.imagesOpt, tag.path)) {
    value = ctx.imagesOpt[tag.path];
  } else if (!hit.found) {
    if (ctx.onMissing === 'empty' || ctx.onMissing === 'keep') return null;
    throw new TemplateError('image_unresolved',
      `The template uses {%${tag.expr}} but the data has no "${tag.path}".`,
      {
        field: tag.path,
        location: ctx.location,
        hint: `Add "${tag.path}" to the data as base64 image bytes, or as {"data": "<base64>", "width": 400}.`,
      });
  }
  return decodeImageValue(value, tag, ctx);
}

// ---------------------------------------------------------------------------
// fragment slicing — the machinery inline sections are built on
// ---------------------------------------------------------------------------

/** Top-level child elements of a fragment, in document order. */
function childElements(xml) {
  const out = [];
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    if (lt === -1) break;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt);
      i = e === -1 ? xml.length : e + 3;
      continue;
    }
    const nameM = /^<([A-Za-z_][^\s/>]*)/.exec(xml.slice(lt, lt + 120));
    if (!nameM) { i = lt + 1; continue; }
    const el = findElements(xml.slice(lt), nameM[1])[0];
    if (!el || el.start !== 0) { i = lt + 1; continue; }
    out.push({ name: nameM[1], start: lt, end: lt + el.end });
    i = lt + el.end;
  }
  return out;
}

/** Text offset at an XML position: how much flattened text precedes it. */
function textOffsetAt(flat, xmlPos) {
  let off = 0;
  for (const n of flat.nodes) {
    if (n.end <= xmlPos) off = n.textEnd;
    else break;
  }
  return off;
}

/** Trims one element down to the part of its text inside [from, to). */
function clipAtom(atomXml, atomTextStart, from, to) {
  const flat = flatten(atomXml, 'a:t');
  if (!flat.nodes.length) return atomXml;
  const lo = Math.max(from - atomTextStart, 0);
  const hi = Math.min(to === Infinity ? flat.text.length : to - atomTextStart, flat.text.length);
  const edits = [];
  if (lo > 0) edits.push({ start: 0, end: lo, text: '' });
  if (hi < flat.text.length) edits.push({ start: hi, end: flat.text.length, text: '' });
  if (!edits.length) return atomXml;
  return splice(atomXml, flat, edits, encodeLiteral);
}

/**
 * The run XML covering flattened text range [from, to).
 *
 * This is what lets an inline `{#tags}…{/tags}` repeat *runs* rather than
 * repeating rendered plain text: the bold word inside the loop body stays bold
 * in every copy, because we duplicate the `<a:r>` that carried it rather than
 * re-emitting its characters into the run that happened to hold `{`.
 */
function sliceFragment(xml, from, to) {
  const flat = flatten(xml, 'a:t');
  const atoms = childElements(xml);
  let out = '';
  for (const a of atoms) {
    const inside = flat.nodes.filter((n) => n.start >= a.start && n.end <= a.end);
    const tStart = inside.length ? inside[0].textStart : textOffsetAt(flat, a.start);
    const tEnd = inside.length ? inside[inside.length - 1].textEnd : tStart;
    if (tStart === tEnd) {
      // Carries no text (an <a:br/>, an empty run). Belongs to the slice that
      // owns the position it sits at; the `< to` keeps a break sitting exactly
      // on a section's closing brace out of the repeated body.
      if (tStart >= from && tStart < to) out += xml.slice(a.start, a.end);
      continue;
    }
    if (tEnd <= from || tStart >= to) continue;
    if (tStart >= from && tEnd <= to) { out += xml.slice(a.start, a.end); continue; }
    out += clipAtom(xml.slice(a.start, a.end), tStart, from, to);
  }
  return out;
}

// ---------------------------------------------------------------------------
// run rebuilding for <a:br/> and {@rawXml}
// ---------------------------------------------------------------------------

function rebuildRun(runXml) {
  const tEl = findElements(runXml, 'a:t')[0];
  if (!tEl) return runXml;
  const rPrEl = findElements(runXml, 'a:rPr')[0];
  const rPr = rPrEl ? runXml.slice(rPrEl.start, rPrEl.end) : '';
  const content = tEl.selfClosing ? '' : runXml.slice(tEl.contentStart, tEl.contentEnd);

  const pieces = [];
  let text = '';
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === BR) {
      pieces.push({ t: 'text', v: text }); text = '';
      pieces.push({ t: 'br' });
      i += 1;
      continue;
    }
    if (ch === RAW_OPEN) {
      const end = content.indexOf(RAW_CLOSE, i + 1);
      pieces.push({ t: 'text', v: text }); text = '';
      pieces.push({ t: 'raw', v: content.slice(i + 1, end === -1 ? content.length : end) });
      i = end === -1 ? content.length : end + 1;
      continue;
    }
    text += ch;
    i += 1;
  }
  pieces.push({ t: 'text', v: text });

  let out = '';
  for (const p of pieces) {
    if (p.t === 'text') {
      if (p.v !== '') out += `<a:r>${rPr}<a:t xml:space="preserve">${p.v}</a:t></a:r>`;
    } else if (p.t === 'br') {
      out += rPr ? `<a:br>${rPr}</a:br>` : '<a:br/>';
    } else {
      out += p.v;
    }
  }
  // A run that rendered to nothing still has to be a run: an <a:p> whose only
  // child is an <a:rPr> is not valid DrawingML.
  return out === '' ? `<a:r>${rPr}<a:t/></a:r>` : out;
}

function expandSpecials(xml) {
  if (xml.indexOf(BR) === -1 && xml.indexOf(RAW_OPEN) === -1) return xml;
  const edits = [];
  for (const r of findElements(xml, 'a:r')) {
    const runXml = xml.slice(r.start, r.end);
    if (runXml.indexOf(BR) === -1 && runXml.indexOf(RAW_OPEN) === -1) continue;
    edits.push({ start: r.start, end: r.end, text: rebuildRun(runXml) });
  }
  return edits.length ? applyEdits(xml, edits) : xml;
}

// ---------------------------------------------------------------------------
// value / image / raw substitution inside one run sequence
// ---------------------------------------------------------------------------

function valueToRunContent(s) {
  return stripInvalidXmlChars(String(s))
    .replace(MARKERS_RE, '')
    .split(/\r\n|\r|\n/)
    .map(escapeXml)
    .join(BR);
}

function substituteValues(xml, flat, tags, stack, ctx, sink) {
  const edits = [];
  for (const tag of tags) {
    ctx.stats.tags += 1;
    if (tag.kind === KIND.COMMENT) {
      edits.push({ start: tag.start, end: tag.end, text: '' });
      continue;
    }
    if (tag.kind === KIND.IMAGE) {
      const img = resolveImage(tag, stack, ctx);
      let text = '';
      if (img) {
        // An image tag that shares its shape with other text cannot become the
        // shape itself, so it is emitted as an extra picture on the slide,
        // anchored where the shape is. The tag's own characters go away.
        sink.inlineImages.push(img);
        ctx.stats.images += 1;
      }
      ctx.stats.resolved += 1;
      edits.push({ start: tag.start, end: tag.end, text });
      continue;
    }
    if (tag.kind === KIND.RAW) {
      const out = stripInvalidXmlChars(resolveValue(tag, stack, ctx)).replace(MARKERS_RE, '');
      ctx.stats.resolved += 1;
      edits.push({ start: tag.start, end: tag.end, text: RAW_OPEN + out + RAW_CLOSE });
      continue;
    }
    if (tag.kind === KIND.VALUE) {
      const out = resolveValue(tag, stack, ctx);
      ctx.stats.resolved += 1;
      edits.push({ start: tag.start, end: tag.end, text: valueToRunContent(out) });
      continue;
    }
    // A section marker reaching here means the balancer missed it.
    throw new TemplateError('section_unbalanced',
      `{${tag.raw}} has no matching partner in this text box.`,
      { field: tag.path, location: ctx.location, hint: 'Every {#name} needs a {/name}, and every {/name} an opening {#name}, inside the same shape.' });
  }
  return splice(xml, flat, edits, encodeLiteral);
}

// ---------------------------------------------------------------------------
// inline sections
// ---------------------------------------------------------------------------

const isOpen = (t) => t.kind === KIND.OPEN_SECTION || t.kind === KIND.OPEN_INVERTED;

/** The first section that opens and closes inside this fragment, at depth 0. */
function firstInlineSection(tags, ctx) {
  let depth = 0;
  let open = null;
  for (const t of tags) {
    if (isOpen(t)) {
      if (depth === 0) open = t;
      depth += 1;
      continue;
    }
    if (t.kind === KIND.CLOSE) {
      depth -= 1;
      if (depth < 0) {
        throw new TemplateError('section_unbalanced',
          `{${t.raw}} closes a section that was never opened here.`,
          { field: t.path, location: ctx.location });
      }
      if (depth === 0) {
        if (t.path && open.path && t.path !== open.path) {
          throw new TemplateError('section_unbalanced',
            `{#${open.path}} is closed by {/${t.path}}.`,
            { field: open.path, location: ctx.location, hint: `Write {/${open.path}} or the bare {/}.` });
        }
        return { open, close: t };
      }
    }
  }
  if (depth > 0) {
    throw new TemplateError('section_unbalanced',
      `{#${open.path}} is never closed.`,
      { field: open.path, location: ctx.location, hint: `Add {/${open.path}} after the repeated text.` });
  }
  return null;
}

function frameFor(pass) {
  return { value: pass.value, meta: pass.meta };
}

/**
 * Renders a sequence of runs, expanding inline sections by duplicating the run
 * fragment between the markers. Recursive, so nesting costs nothing extra.
 */
function renderInline(xml, stack, ctx, sink) {
  if (xml === '') return '';
  const flat = flatten(xml, 'a:t');
  const tags = scan(flat.text);
  if (!tags.length) return xml;

  const sec = firstInlineSection(tags, ctx);
  if (!sec) return substituteValues(xml, flat, tags, stack, ctx, sink);

  ctx.stats.sections += 1;
  const before = sliceFragment(xml, 0, sec.open.start);
  const body = sliceFragment(xml, sec.open.end, sec.close.start);
  const after = sliceFragment(xml, sec.close.end, Infinity);

  const result = sec.open.kind === KIND.OPEN_INVERTED
    ? resolveInverted(sec.open, stack, ctx)
    : resolveSection(sec.open, stack, ctx);

  let mid = '';
  for (const pass of result.passes) {
    mid += renderInline(body, [...stack, frameFor(pass)], ctx, sink);
  }
  return renderInline(before, stack, ctx, sink) + mid + renderInline(after, stack, ctx, sink);
}

// ---------------------------------------------------------------------------
// block sections over a sequence of paragraphs or table rows
// ---------------------------------------------------------------------------

/**
 * Matches section markers across a sequence of items (paragraphs, or table
 * rows) and reports the ones whose open and close live in *different* items.
 * Those become block sections: the items between the markers repeat.
 *
 * `sameUnit` lets the table case say "same row but different cell still counts
 * as a block", which is how `{#rows}` in the first cell and `{/rows}` in the
 * last cell of one row comes to repeat that row.
 */
function planBlocks(items, ctx, sameUnit) {
  const open = [];
  const blocks = [];
  for (let i = 0; i < items.length; i += 1) {
    for (const t of items[i].tags) {
      if (isOpen(t)) { open.push({ tag: t, item: i }); continue; }
      if (t.kind !== KIND.CLOSE) continue;
      const o = open.pop();
      if (!o) {
        throw new TemplateError('section_unbalanced',
          `{${t.raw}} closes a section that was never opened.`,
          { field: t.path, location: itemLocation(items[i], ctx) });
      }
      if (t.path && o.tag.path && t.path !== o.tag.path) {
        throw new TemplateError('section_unbalanced',
          `{#${o.tag.path}} is closed by {/${t.path}}.`,
          { field: o.tag.path, location: itemLocation(items[i], ctx), hint: `Write {/${o.tag.path}} or the bare {/}.` });
      }
      if (o.item !== i || !sameUnit(o.tag, t, items[i])) {
        blocks.push({ tag: o.tag, openItem: o.item, closeItem: i, closeTag: t });
      }
    }
  }
  if (open.length) {
    const o = open[open.length - 1];
    throw new TemplateError('section_unbalanced',
      `{#${o.tag.path}} is never closed.`,
      { field: o.tag.path, location: itemLocation(items[o.item], ctx), hint: `Add {/${o.tag.path}} where the repeated block ends.` });
  }
  // Proper nesting means containment identifies the parent unambiguously.
  for (const b of blocks) {
    const holders = blocks.filter((o) => o !== b && o.openItem <= b.openItem && o.closeItem >= b.closeItem
      && !(o.openItem === b.openItem && o.closeItem === b.closeItem && blocks.indexOf(o) > blocks.indexOf(b)));
    holders.sort((x, y) => (y.openItem - x.openItem) || (x.closeItem - y.closeItem));
    b.parent = holders[0] || null;
  }
  return blocks;
}

const itemLocation = (item, ctx) => (item && item.location) || ctx.location || null;

/**
 * Strips the block markers out of each item's XML and works out which items are
 * nothing *but* markers — those are the ones that get deleted rather than
 * repeated, which is what makes `{#items}` on its own line behave the way every
 * template author expects.
 */
function stripBlockMarkers(items, blocks) {
  const byItem = new Map();
  for (const b of blocks) {
    if (!byItem.has(b.openItem)) byItem.set(b.openItem, []);
    if (!byItem.has(b.closeItem)) byItem.set(b.closeItem, []);
    byItem.get(b.openItem).push(b.tag);
    byItem.get(b.closeItem).push(b.closeTag);
  }
  for (const [idx, tags] of byItem) {
    const item = items[idx];
    const sorted = [...tags].sort((a, b) => a.start - b.start);
    let remaining = '';
    let pos = 0;
    for (const t of sorted) { remaining += item.flat.text.slice(pos, t.start); pos = t.end; }
    remaining += item.flat.text.slice(pos);
    item.markerOnly = remaining.trim() === '';
    item.xml = splice(item.xml, item.flat, sorted.map((t) => ({ start: t.start, end: t.end, text: '' })), encodeLiteral);
  }
}

function renderSequence(items, blocks, from, to, parent, stack, ctx, renderItem) {
  let out = '';
  let i = from;
  const children = blocks.filter((b) => b.parent === parent);
  while (i <= to) {
    const b = children.find((x) => x.openItem === i && x.openItem >= from && x.closeItem <= to);
    if (b) {
      ctx.stats.sections += 1;
      const grand = blocks.filter((x) => x.parent === b);
      let bf = b.openItem;
      let bt = b.closeItem;
      if (items[b.openItem].markerOnly && !grand.some((g) => g.openItem === b.openItem)) bf += 1;
      if (items[b.closeItem].markerOnly && !grand.some((g) => g.closeItem === b.closeItem)) bt -= 1;

      const result = b.tag.kind === KIND.OPEN_INVERTED
        ? resolveInverted(b.tag, stack, ctx)
        : resolveSection(b.tag, stack, ctx);
      for (const pass of result.passes) {
        out += renderSequence(items, blocks, bf, bt, b, [...stack, frameFor(pass)], ctx, renderItem);
      }
      i = b.closeItem + 1;
      continue;
    }
    if (!items[i].markerOnly) out += renderItem(items[i], stack);
    i += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// text bodies
// ---------------------------------------------------------------------------

/** Splits an `<a:p>` into the parts that must survive section slicing intact. */
function paragraphShell(paraXml) {
  const el = findElements(paraXml, 'a:p')[0];
  const openTag = el.openTag;
  if (el.selfClosing) return { openTag: `${openTag.slice(0, -2)}>`, pPr: '', body: '', endRPr: '' };
  let inner = paraXml.slice(el.contentStart, el.contentEnd);
  let pPr = '';
  let endRPr = '';
  const pPrEl = findElements(inner, 'a:pPr')[0];
  if (pPrEl && inner.slice(0, pPrEl.start).trim() === '') {
    pPr = inner.slice(pPrEl.start, pPrEl.end);
    inner = inner.slice(0, pPrEl.start) + inner.slice(pPrEl.end);
  }
  const endEl = findElements(inner, 'a:endParaRPr')[0];
  if (endEl) {
    endRPr = inner.slice(endEl.start, endEl.end);
    inner = inner.slice(0, endEl.start) + inner.slice(endEl.end);
  }
  return { openTag, pPr, body: inner, endRPr };
}

function renderParagraph(paraXml, stack, ctx, sink) {
  const shell = paragraphShell(paraXml);
  const body = renderInline(shell.body, stack, ctx, sink);
  return expandSpecials(`${shell.openTag}${shell.pPr}${body}${shell.endRPr}</a:p>`);
}

/**
 * Renders the children of a `<p:txBody>` or `<a:txBody>`: the body properties,
 * then the paragraphs, with paragraph-spanning sections expanded.
 */
function renderTextBodyInner(inner, stack, ctx, sink, locBase, paraOffset) {
  const paras = findElements(inner, 'a:p');
  if (!paras.length) return inner;
  const prefix = inner.slice(0, paras[0].start);
  const suffix = inner.slice(paras[paras.length - 1].end);

  const items = paras.map((p, idx) => {
    const xml = inner.slice(p.start, p.end);
    const flat = flatten(xml, 'a:t');
    return {
      xml,
      flat,
      tags: scan(flat.text),
      markerOnly: false,
      location: locBase || `paragraph ${paraOffset + idx + 1}`,
    };
  });

  // Within a paragraph the sub-unit is the paragraph, so an open and close in
  // the same one is an inline section and stays out of the block machinery.
  const blocks = planBlocks(items, ctx, () => true);
  stripBlockMarkers(items, blocks);

  const renderItem = (item, s) => {
    ctx.location = item.location;
    return renderParagraph(item.xml, s, ctx, sink);
  };
  let out = renderSequence(items, blocks, 0, items.length - 1, null, stack, ctx, renderItem);

  // PowerPoint will not open a text body with no paragraph in it, which is
  // exactly what an empty {#items} loop leaves behind.
  if (!findElements(out, 'a:p').length) out = '<a:p/>';
  return prefix + out + suffix;
}

function renderTextBodyElement(xml, tag, stack, ctx, sink, locBase, paraOffset) {
  const el = findElements(xml, tag)[0];
  if (!el || el.selfClosing) return xml;
  const inner = xml.slice(el.contentStart, el.contentEnd);
  const rendered = renderTextBodyInner(inner, stack, ctx, sink, locBase, paraOffset);
  return xml.slice(0, el.contentStart) + rendered + xml.slice(el.contentEnd);
}

const countParagraphs = (xml) => findElements(xml, 'a:p').length;

// ---------------------------------------------------------------------------
// tables
// ---------------------------------------------------------------------------

/**
 * Row loops. `{#rows}` in one cell and `{/rows}` in another repeats the whole
 * `<a:tr>` per array element — the shape a reporting deck's table actually
 * takes. A section that opens and closes inside a single cell stays inline.
 */
function renderTable(tblXml, stack, ctx, sink, locBase) {
  const el = findElements(tblXml, 'a:tbl')[0];
  const inner = tblXml.slice(el.contentStart, el.contentEnd);
  const rows = findElements(inner, 'a:tr');
  if (!rows.length) return tblXml;
  const prefix = inner.slice(0, rows[0].start);
  const suffix = inner.slice(rows[rows.length - 1].end);

  const items = rows.map((r, idx) => {
    const xml = inner.slice(r.start, r.end);
    const flat = flatten(xml, 'a:t');
    return {
      xml,
      flat,
      tags: scan(flat.text),
      markerOnly: false,
      location: `${locBase}, row ${idx + 1}`,
      cellRanges: findElements(xml, 'a:tc').map((c) => [c.start, c.end]),
    };
  });

  // Two markers in the same cell are an inline section; in different cells of
  // the same row they are a row loop.
  const sameCell = (openTag, closeTag, item) => {
    const cellOf = (t) => {
      const pos = item.flat.nodes.find((n) => n.textEnd > t.start);
      const xmlPos = pos ? pos.start : 0;
      return item.cellRanges.findIndex(([s, e]) => xmlPos >= s && xmlPos < e);
    };
    return cellOf(openTag) === cellOf(closeTag);
  };

  const blocks = planBlocks(items, ctx, sameCell);
  stripBlockMarkers(items, blocks);

  const renderRow = (item, s) => {
    const cells = findElements(item.xml, 'a:tc');
    const edits = [];
    cells.forEach((c, ci) => {
      const cellXml = item.xml.slice(c.start, c.end);
      ctx.location = `${item.location}, cell ${ci + 1}`;
      edits.push({
        start: c.start,
        end: c.end,
        text: renderTextBodyElement(cellXml, 'a:txBody', s, ctx, sink, ctx.location, 0),
      });
    });
    return edits.length ? applyEdits(item.xml, edits) : item.xml;
  };

  const out = renderSequence(items, blocks, 0, items.length - 1, null, stack, ctx, renderRow);
  return tblXml.slice(0, el.contentStart) + prefix + out + suffix + tblXml.slice(el.contentEnd);
}

// ---------------------------------------------------------------------------
// slide-level rendering
// ---------------------------------------------------------------------------

const shapeName = (spXml) => {
  const el = findElements(spXml, 'p:cNvPr')[0];
  return el ? (attr(el.openTag, 'name') || '') : '';
};

function shapeExtent(spXml) {
  const xfrm = findElements(spXml, 'a:xfrm')[0];
  if (!xfrm) return null;
  const frag = spXml.slice(xfrm.start, xfrm.end);
  const off = findElements(frag, 'a:off')[0];
  const ext = findElements(frag, 'a:ext')[0];
  if (!off || !ext) return null;
  return {
    x: Number(attr(off.openTag, 'x') || 0),
    y: Number(attr(off.openTag, 'y') || 0),
    cx: Number(attr(ext.openTag, 'cx') || 0),
    cy: Number(attr(ext.openTag, 'cy') || 0),
  };
}

function maxShapeId(xml) {
  let max = 1;
  for (const el of findElements(xml, 'p:cNvPr')) {
    const n = Number(attr(el.openTag, 'id'));
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max;
}

function picXml({ id, name, rid, x, y, cx, cy }) {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${escapeXml(name)}"/>`
    + '<p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr>'
    + `<p:blipFill><a:blip r:embed="${escapeXml(rid)}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill>`
    + `<p:spPr><a:xfrm><a:off x="${Math.round(x)}" y="${Math.round(y)}"/><a:ext cx="${Math.round(cx)}" cy="${Math.round(cy)}"/></a:xfrm>`
    + '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>';
}

/** Aspect-preserving fit of an image into a shape's box, centred. */
function fitInto(img, box) {
  const iw = img.width * EMU_PER_PX;
  const ih = img.height * EMU_PER_PX;
  if (!box || !box.cx || !box.cy || !iw || !ih) {
    return { x: box ? box.x : 0, y: box ? box.y : 0, cx: iw || 914400, cy: ih || 914400 };
  }
  const scale = Math.min(box.cx / iw, box.cy / ih);
  const cx = iw * scale;
  const cy = ih * scale;
  return { x: box.x + (box.cx - cx) / 2, y: box.y + (box.cy - cy) / 2, cx, cy };
}

/**
 * Registers image bytes in the package and returns the relationship id the
 * picture should point at. Identical bytes are stored once — a logo repeated on
 * twenty slides should not be twenty copies of the same PNG.
 */
function addImagePart(pkg, partName, img) {
  const key = `${img.ext}:${img.buf.length}:${crc32(img.buf)}`;
  let mediaName = pkg.mediaByKey.get(key);
  if (!mediaName) {
    let n = 1;
    while (pkg.zip.byName.has(`ppt/media/docmint${n}.${img.ext}`)) n += 1;
    mediaName = `ppt/media/docmint${n}.${img.ext}`;
    addEntry(pkg.zip, mediaName, img.buf, { method: 0 });
    pkg.mediaByKey.set(key, mediaName);
    pkg.ct = ctEnsureDefault(pkg.ct, img.ext, img.mime);
    pkg.touched.add(mediaName);
  }
  const relsPath = relsPathFor(partName);
  const rels = readRels(pkg.zip, relsPath);
  const target = relativeTarget(partName, mediaName);
  const existing = rels.find((r) => r.type === REL_IMAGE && r.target === target);
  if (existing) return existing.id;
  const id = freeRelId(rels);
  rels.push({ id, type: REL_IMAGE, target });
  writeRels(pkg.zip, relsPath, rels);
  pkg.touched.add(relsPath);
  return id;
}

/** True when the shape's whole text is exactly one image tag. */
function loneTagOf(spXml, kinds) {
  const text = flatten(spXml, 'a:t').text;
  if (!text.trim()) return null;
  const tags = scan(text);
  if (tags.length !== 1) return null;
  if (text.trim() !== tags[0].raw) return null;
  return kinds.includes(tags[0].kind) ? tags[0] : null;
}

/**
 * Renders one slide, notes slide, layout or master part.
 */
function renderPart(pkg, partName, xml, stack, ctx, locPrefix) {
  const sink = { inlineImages: [] };
  const edits = [];
  let paraNo = 0;
  const nextId = { v: maxShapeId(xml) + 1 };

  for (const sp of findElements(xml, 'p:sp')) {
    const spXml = xml.slice(sp.start, sp.end);
    const name = shapeName(spXml);
    const loc = name ? `${locPrefix}, shape "${name}"` : `${locPrefix}, paragraph ${paraNo + 1}`;
    ctx.location = loc;

    const img = loneTagOf(spXml, [KIND.IMAGE]);
    if (img) {
      // The tag owns the shape, so the picture takes the shape's own box —
      // the author drew the frame where they wanted the image.
      ctx.stats.tags += 1;
      const decoded = resolveImage(img, stack, ctx);
      if (!decoded) {
        edits.push({ start: sp.start, end: sp.end, text: '' });
      } else {
        const rid = addImagePart(pkg, partName, decoded);
        const box = fitInto(decoded, shapeExtent(spXml));
        edits.push({
          start: sp.start,
          end: sp.end,
          text: picXml({ id: nextId.v, name: name || `Image ${nextId.v}`, rid, ...box }),
        });
        nextId.v += 1;
        ctx.stats.images += 1;
      }
      ctx.stats.resolved += 1;
      paraNo += countParagraphs(spXml);
      continue;
    }

    const shapeSink = { inlineImages: [] };
    let rendered = renderTextBodyElement(spXml, 'p:txBody', stack, ctx, shapeSink, name ? loc : null, paraNo);
    paraNo += countParagraphs(spXml);
    if (shapeSink.inlineImages.length) {
      const box = shapeExtent(spXml);
      for (const image of shapeSink.inlineImages) {
        sink.inlineImages.push({ image, box, partName });
      }
    }
    edits.push({ start: sp.start, end: sp.end, text: rendered });
  }

  for (const gf of findElements(xml, 'p:graphicFrame')) {
    const gfXml = xml.slice(gf.start, gf.end);
    const name = shapeName(gfXml) || 'Table';
    const tbls = findElements(gfXml, 'a:tbl');
    if (!tbls.length) continue;
    const inner = [];
    for (const t of tbls) {
      ctx.location = `${locPrefix}, table "${name}"`;
      inner.push({
        start: t.start,
        end: t.end,
        text: renderTable(gfXml.slice(t.start, t.end), stack, ctx, sink, `${locPrefix}, table "${name}"`),
      });
    }
    edits.push({ start: gf.start, end: gf.end, text: applyEdits(gfXml, inner) });
  }

  // Anything with text that is neither a <p:sp> nor a table: a connector with a
  // label, a caption on a <p:pic>. Rare, but silently leaving a tag unrendered
  // in one is worse than the twelve lines it costs to catch them.
  for (const tb of findElements(xml, 'p:txBody')) {
    if (edits.some((e) => tb.start >= e.start && tb.end <= e.end)) continue;
    const tbXml = xml.slice(tb.start, tb.end);
    if (!scan(flatten(tbXml, 'a:t').text).length) continue;
    const loc = `${locPrefix}, paragraph ${paraNo + 1}`;
    ctx.location = loc;
    edits.push({
      start: tb.start,
      end: tb.end,
      text: renderTextBodyElement(tbXml, 'p:txBody', stack, ctx, sink, loc, paraNo),
    });
    paraNo += countParagraphs(tbXml);
  }

  let out = edits.length ? applyEdits(xml, edits) : xml;

  if (sink.inlineImages.length) {
    let pics = '';
    let id = maxShapeId(out) + 1;
    for (const rec of sink.inlineImages) {
      const rid = addImagePart(pkg, partName, rec.image);
      const box = rec.box || { x: 0, y: 0, cx: 0, cy: 0 };
      pics += picXml({
        id,
        name: `Image ${id}`,
        rid,
        x: box.x,
        y: box.y,
        cx: rec.image.width * EMU_PER_PX,
        cy: rec.image.height * EMU_PER_PX,
      });
      id += 1;
    }
    const tree = findElements(out, 'p:spTree')[0];
    if (tree) out = out.slice(0, tree.contentEnd) + pics + out.slice(tree.contentEnd);
  }

  // A generated <p:pic> uses r:embed, so the part must declare the r namespace.
  if (out.includes('r:embed=') && !/xmlns:r=/.test(out.slice(0, 2000))) {
    out = out.replace(/^(<\?xml[^>]*\?>\s*)?(<[A-Za-z:]+)/, (m, decl, open) => `${decl || ''}${open} xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// slide loops
// ---------------------------------------------------------------------------

/** Shapes whose entire text is one section marker: the slide-loop delimiters. */
function findSlideMarkers(xml) {
  const out = [];
  for (const sp of findElements(xml, 'p:sp')) {
    const spXml = xml.slice(sp.start, sp.end);
    const tag = loneTagOf(spXml, [KIND.OPEN_SECTION, KIND.OPEN_INVERTED, KIND.CLOSE]);
    if (tag) out.push({ tag, start: sp.start, end: sp.end, name: shapeName(spXml) });
  }
  return out;
}

/**
 * True when the slide carries nothing but its markers, so it is a pure
 * delimiter and should not itself be repeated. A `{#slides}` typed into a
 * corner of the first content slide, by contrast, means "this slide and the
 * following ones repeat", and that slide has to stay in the span.
 */
function slideIsPureDelimiter(xml, markers) {
  const inMarker = (pos) => markers.some((m) => pos >= m.start && pos < m.end);
  for (const sp of findElements(xml, 'p:sp')) {
    if (inMarker(sp.start)) continue;
    if (flatten(xml.slice(sp.start, sp.end), 'a:t').text.trim() !== '') return false;
  }
  if (findElements(xml, 'p:pic').length) return false;
  if (findElements(xml, 'p:graphicFrame').length) return false;
  return true;
}

/**
 * Builds the tree of slide-level loops from the markers found on each slide.
 * A slide is placed in the innermost loop that is open when it is reached; a
 * slide that both opens and closes a loop (the single-slide `{#items}` form)
 * ends up inside it, which is what makes that slide repeat.
 */
function planSlideLoops(slides, ctx) {
  const root = { children: [] };
  const stack = [root];
  slides.forEach((slide, idx) => {
    let placed = slide.pure;
    for (const m of slide.markers) {
      if (isOpen(m.tag)) {
        const node = { type: 'loop', tag: m.tag, children: [], slide: idx };
        stack[stack.length - 1].children.push(node);
        stack.push(node);
        continue;
      }
      const cur = stack[stack.length - 1];
      if (cur === root) {
        throw new TemplateError('section_unbalanced',
          `{${m.tag.raw}} on slide ${idx + 1} closes a slide loop that was never opened.`,
          { field: m.tag.path, location: `slide ${idx + 1}, shape "${m.name}"` });
      }
      if (m.tag.path && cur.tag.path && m.tag.path !== cur.tag.path) {
        throw new TemplateError('section_unbalanced',
          `{#${cur.tag.path}} is closed by {/${m.tag.path}} on slide ${idx + 1}.`,
          { field: cur.tag.path, location: `slide ${idx + 1}, shape "${m.name}"` });
      }
      if (!placed) { cur.children.push({ type: 'slide', idx }); placed = true; }
      stack.pop();
    }
    if (!placed) stack[stack.length - 1].children.push({ type: 'slide', idx });
  });
  if (stack.length > 1) {
    const open = stack[stack.length - 1];
    throw new TemplateError('section_unbalanced',
      `{#${open.tag.path}} opens a slide loop on slide ${open.slide + 1} that is never closed.`,
      {
        field: open.tag.path,
        location: `slide ${open.slide + 1}`,
        hint: `Put {/${open.tag.path}} in a text box of its own on the last slide of the repeated range.`,
      });
  }
  return root.children;
}

function expandSlidePlan(nodes, stack, ctx) {
  const out = [];
  for (const node of nodes) {
    if (node.type === 'slide') { out.push({ idx: node.idx, stack }); continue; }
    ctx.stats.sections += 1;
    ctx.location = `slide ${node.slide + 1}`;
    const result = node.tag.kind === KIND.OPEN_INVERTED
      ? resolveInverted(node.tag, stack, ctx)
      : resolveSection(node.tag, stack, ctx);
    for (const pass of result.passes) {
      out.push(...expandSlidePlan(node.children, [...stack, frameFor(pass)], ctx));
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// presentation part
// ---------------------------------------------------------------------------

function readSlideList(zip) {
  const presEntry = zip.byName.get(PRESENTATION);
  if (!presEntry) {
    throw new TemplateError('not_a_pptx',
      'This file has no ppt/presentation.xml, so it is not a PowerPoint presentation.',
      { hint: 'Send a .pptx file. A .ppt (PowerPoint 97-2003) file must be converted first.' });
  }
  const presXml = readText(presEntry);
  const rels = readRels(zip, relsPathFor(PRESENTATION));
  const byId = new Map(rels.map((r) => [r.id, r]));
  const lst = findElements(presXml, 'p:sldIdLst')[0];
  const slides = [];
  if (lst && !lst.selfClosing) {
    const inner = presXml.slice(lst.contentStart, lst.contentEnd);
    for (const s of findElements(inner, 'p:sldId')) {
      const rid = attr(s.openTag, 'r:id');
      const rel = byId.get(rid);
      if (!rel) continue;
      slides.push({ rid, part: resolveRelTarget(PRESENTATION, rel.target), id: Number(attr(s.openTag, 'id')) });
    }
  }
  return { presXml, rels, slides };
}

function setSldIdLst(presXml, entries) {
  const body = entries.map((e) => `<p:sldId id="${e.id}" r:id="${escapeXml(e.rid)}"/>`).join('');
  const lst = findElements(presXml, 'p:sldIdLst')[0];
  if (lst && !lst.selfClosing) {
    return presXml.slice(0, lst.contentStart) + body + presXml.slice(lst.contentEnd);
  }
  if (lst && lst.selfClosing) {
    return presXml.slice(0, lst.start) + `<p:sldIdLst>${body}</p:sldIdLst>` + presXml.slice(lst.end);
  }
  const master = findElements(presXml, 'p:sldMasterIdLst')[0];
  if (master) {
    return presXml.slice(0, master.end) + `<p:sldIdLst>${body}</p:sldIdLst>` + presXml.slice(master.end);
  }
  throw new TemplateError('not_a_pptx', 'ppt/presentation.xml has no slide list.', {});
}

function freeSlidePart(zip, prefix, suffix) {
  let n = 1;
  while (zip.byName.has(`${prefix}${n}${suffix}`)) n += 1;
  return `${prefix}${n}${suffix}`;
}

/**
 * Copies a slide part, its relationships and — critically — its notes slide.
 *
 * Every relationship keeps pointing at the same shared target: the layout, the
 * theme, the images. That is deliberate. Deep-copying media would double the
 * file size for every repeat of a slide and change nothing on screen. The one
 * relationship that must not be shared is the notes slide, because a notes
 * slide names its own slide back; leaving two slides pointing at one notes part
 * is precisely the dangling-reference case PowerPoint refuses to open.
 */
function duplicateSlide(pkg, srcPart, srcXml) {
  const zip = pkg.zip;
  const newPart = freeSlidePart(zip, 'ppt/slides/slide', '.xml');
  addEntry(zip, newPart, srcXml);
  pkg.ct = ctAddOverride(pkg.ct, newPart, CT_SLIDE);
  pkg.touched.add(newPart);

  const srcRels = readRels(zip, relsPathFor(srcPart));
  if (srcRels.length) {
    const copied = srcRels.map((r) => ({ ...r }));
    const notesRel = copied.find((r) => r.type === REL_NOTES);
    if (notesRel) {
      const srcNotes = resolveRelTarget(srcPart, notesRel.target);
      const notesEntry = zip.byName.get(srcNotes);
      if (notesEntry) {
        const newNotes = freeSlidePart(zip, 'ppt/notesSlides/notesSlide', '.xml');
        addEntry(zip, newNotes, readText(notesEntry));
        pkg.ct = ctAddOverride(pkg.ct, newNotes, CT_NOTES);
        pkg.touched.add(newNotes);
        const notesRels = readRels(zip, relsPathFor(srcNotes)).map((r) => (
          r.type === REL_SLIDE ? { ...r, target: relativeTarget(newNotes, newPart) } : { ...r }
        ));
        if (notesRels.length) {
          writeRels(zip, relsPathFor(newNotes), notesRels);
          pkg.touched.add(relsPathFor(newNotes));
          pkg.ct = mirrorRelsOverride(pkg.ct, relsPathFor(srcNotes), relsPathFor(newNotes));
        }
        notesRel.target = relativeTarget(newPart, newNotes);
      } else {
        // The rel points at a part that is not in the package. Dropping it is
        // the only safe move; keeping it guarantees PowerPoint refuses the file.
        copied.splice(copied.indexOf(notesRel), 1);
      }
    }
    writeRels(zip, relsPathFor(newPart), copied);
    pkg.touched.add(relsPathFor(newPart));
    pkg.ct = mirrorRelsOverride(pkg.ct, relsPathFor(srcPart), relsPathFor(newPart));
  }
  return newPart;
}

/**
 * LibreOffice writes a content-type Override for every `.rels` part as well as
 * for the part itself, even though `<Default Extension="rels">` already covers
 * them. So a slide that gets deleted has to take *both* overrides with it: an
 * Override naming a part that is no longer in the package is an OPC violation,
 * and it is exactly the sort of inconsistency PowerPoint refuses on.
 */
function dropSlide(pkg, part) {
  const zip = pkg.zip;
  for (const r of readRels(zip, relsPathFor(part))) {
    if (r.type !== REL_NOTES) continue;
    const notes = resolveRelTarget(part, r.target);
    removeEntry(zip, notes);
    removeEntry(zip, relsPathFor(notes));
    pkg.ct = ctRemoveOverride(ctRemoveOverride(pkg.ct, notes), relsPathFor(notes));
  }
  removeEntry(zip, part);
  removeEntry(zip, relsPathFor(part));
  pkg.ct = ctRemoveOverride(ctRemoveOverride(pkg.ct, part), relsPathFor(part));
}

/** Copies the source part's `.rels` Override onto the new one, if it had one. */
function mirrorRelsOverride(ct, srcRelsPath, newRelsPath) {
  const m = new RegExp(`<Override[^>]*PartName="/${escapeRe(srcRelsPath)}"[^>]*ContentType="([^"]+)"`).exec(ct);
  return m ? ctAddOverride(ct, newRelsPath, m[1]) : ct;
}

function notesPartFor(zip, slidePart) {
  const rel = readRels(zip, relsPathFor(slidePart)).find((r) => r.type === REL_NOTES);
  if (!rel) return null;
  const part = resolveRelTarget(slidePart, rel.target);
  return zip.byName.has(part) ? part : null;
}

// ---------------------------------------------------------------------------
// self-check
// ---------------------------------------------------------------------------

function invariant(cond, message, hint) {
  if (cond) return;
  throw new TemplateError('package_invariant', message, { hint: hint || null });
}

/**
 * Re-derives, from the finished package, everything PowerPoint checks before it
 * agrees to open a file. Cheap, and it turns "PowerPoint found a problem with
 * content" — a message with no diagnostic value whatsoever — into a sentence
 * naming the part we got wrong.
 */
function selfCheck(zip) {
  const presXml = readText(zip.byName.get(PRESENTATION));
  const rels = readRels(zip, relsPathFor(PRESENTATION));
  const byId = new Map(rels.map((r) => [r.id, r]));
  const ct = readText(zip.byName.get(CONTENT_TYPES));

  const lst = findElements(presXml, 'p:sldIdLst')[0];
  const seenIds = new Set();
  let count = 0;
  if (lst && !lst.selfClosing) {
    for (const s of findElements(presXml.slice(lst.contentStart, lst.contentEnd), 'p:sldId')) {
      const rid = attr(s.openTag, 'r:id');
      const id = Number(attr(s.openTag, 'id'));
      invariant(byId.has(rid), `ppt/presentation.xml references relationship "${rid}", which ppt/_rels/presentation.xml.rels does not define.`);
      invariant(Number.isInteger(id) && id >= SLD_ID_MIN && id < SLD_ID_MAX,
        `slide id ${id} is outside the range PowerPoint accepts (${SLD_ID_MIN}..${SLD_ID_MAX - 1}).`);
      invariant(!seenIds.has(id), `slide id ${id} is used twice in ppt/presentation.xml.`);
      seenIds.add(id);
      const target = resolveRelTarget(PRESENTATION, byId.get(rid).target);
      invariant(zip.byName.has(target), `ppt/presentation.xml lists slide part "${target}", which is not in the package.`);
      invariant(ct.includes(`PartName="/${target}"`), `"${target}" has no content-type override in [Content_Types].xml.`);
      count += 1;
    }
  }
  invariant(count > 0, 'the rendered deck has no slides left. An empty slide loop removed every slide.',
    'Give the slide loop at least one array element, or keep a slide outside it.');

  for (const e of zip.entries) {
    if (!/^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(e.name)) continue;
    invariant(ct.includes(`PartName="/${e.name}"`), `"${e.name}" has no content-type override in [Content_Types].xml.`);
    for (const r of readRels(zip, relsPathFor(e.name))) {
      if (r.mode === 'External') continue;
      const t = resolveRelTarget(e.name, r.target);
      invariant(zip.byName.has(t),
        `"${relsPathFor(e.name)}" points at "${r.target}", which is not in the package.`,
        'PowerPoint refuses to open a file with a dangling relationship, even though LibreOffice will.');
    }
  }

  for (const el of findElements(ct, 'Override')) {
    const name = attr(el.openTag, 'PartName');
    if (!name) continue;
    invariant(zip.byName.has(name.replace(/^\//, '')),
      `[Content_Types].xml declares "${name}", which is not in the package.`,
      'An override naming a part that does not exist is an OPC violation.');
  }

  for (const e of zip.entries) {
    if (!e.dirty || !/\.xml$/.test(e.name)) continue;
    invariant(!HAS_MARKER_RE.test(e.data.toString('utf8')),
      `"${e.name}" still contains an internal marker character, which means a line break or raw-XML insertion was not expanded.`);
  }
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------

async function render(buffer, data, opts = {}) {
  const zip = readZip(buffer);
  const ctx = makeContext(opts);
  ctx.stats = { tags: 0, resolved: 0, sections: 0, images: 0 };
  ctx.imagesOpt = opts.images && typeof opts.images === 'object' ? opts.images : null;

  const ctEntry = zip.byName.get(CONTENT_TYPES);
  if (!ctEntry) throw new TemplateError('not_a_pptx', 'This file has no [Content_Types].xml, so it is not an Office document.');

  const pkg = { zip, ct: readText(ctEntry), touched: new Set(), mediaByKey: new Map() };
  const { presXml, rels, slides } = readSlideList(zip);
  if (!slides.length) {
    throw new TemplateError('not_a_pptx', 'This presentation has no slides.', {});
  }

  const rootStack = [{ value: data === undefined || data === null ? {} : data, meta: {} }];

  // 1. Find slide-loop delimiters and strip them out before anything is copied,
  //    so every duplicate starts from a slide that no longer mentions them.
  const sourceXml = slides.map((s) => {
    const entry = zip.byName.get(s.part);
    if (!entry) {
      throw new TemplateError('not_a_pptx', `ppt/presentation.xml lists "${s.part}" but the file does not contain it.`);
    }
    return readText(entry);
  });

  const planned = slides.map((s, i) => {
    const markers = findSlideMarkers(sourceXml[i]);
    const pure = markers.length > 0 && slideIsPureDelimiter(sourceXml[i], markers);
    let xml = sourceXml[i];
    if (markers.length) {
      xml = applyEdits(xml, markers.map((m) => ({ start: m.start, end: m.end, text: '' })));
    }
    return { ...s, markers, pure, xml };
  });

  // 2. Expand the loop tree into the final ordered list of slide instances.
  const tree = planSlideLoops(planned, ctx);
  const instances = expandSlidePlan(tree, rootStack, ctx);

  // 3. Materialise parts: the first use of a source slide reuses its part, the
  //    rest are copies. Source slides nobody used are deleted outright.
  const usedSource = new Set();
  const final = [];
  for (const inst of instances) {
    const src = planned[inst.idx];
    let part = src.part;
    if (usedSource.has(inst.idx)) {
      part = duplicateSlide(pkg, src.part, src.xml);
    } else {
      usedSource.add(inst.idx);
      writeEntry(zip.byName.get(part), src.xml);
      pkg.touched.add(part);
    }
    final.push({ part, idx: inst.idx, stack: inst.stack });
  }
  for (let i = 0; i < planned.length; i += 1) {
    if (!usedSource.has(i)) dropSlide(pkg, planned[i].part);
  }

  // 4. Render each instance in its own scope.
  final.forEach((inst, i) => {
    const entry = zip.byName.get(inst.part);
    const loc = `slide ${i + 1}`;
    const out = renderPart(pkg, inst.part, readText(entry), inst.stack, ctx, loc);
    writeEntry(entry, out);
    pkg.touched.add(inst.part);

    // Speaker notes are cheap to support and nobody else does. Same engine.
    const notes = notesPartFor(zip, inst.part);
    if (notes) {
      const nEntry = zip.byName.get(notes);
      const rendered = renderPart(pkg, notes, readText(nEntry), inst.stack, ctx, `${loc} notes`);
      writeEntry(nEntry, rendered);
      pkg.touched.add(notes);
    }
  });

  // 5. Optionally the layouts and masters. Off by default: a placeholder in a
  //    layout is nearly always a genuine PowerPoint layout placeholder, and
  //    rewriting one silently changes every slide that inherits from it.
  if (opts.includeLayouts) {
    for (const e of [...zip.entries]) {
      if (!/^ppt\/(slideLayouts|slideMasters)\/[^/]+\.xml$/.test(e.name)) continue;
      const xml = readText(e);
      if (!scan(flatten(xml, 'a:t').text).length) continue;
      const out = renderPart(pkg, e.name, xml, rootStack, ctx, e.name.split('/').pop().replace('.xml', ''));
      writeEntry(e, out);
      pkg.touched.add(e.name);
    }
  }

  // 6. Rewrite the slide list. Ids are reassigned from 256 upwards so a deck
  //    that grew past whatever the template used cannot collide.
  const presRels = readRels(zip, relsPathFor(PRESENTATION));
  const relByTarget = new Map();
  for (const r of presRels) {
    if (r.type === REL_SLIDE) relByTarget.set(resolveRelTarget(PRESENTATION, r.target), r);
  }
  // Keep a slide relationship when its part is still in the package. Filtering
  // on the final list instead would strip the relationship off any slide the
  // template had in the rels but not in p:sldIdLst, leaving an orphan part.
  const kept = presRels.filter((r) => r.type !== REL_SLIDE || zip.byName.has(resolveRelTarget(PRESENTATION, r.target)));

  const entries = [];
  let sldId = SLD_ID_MIN;
  for (const inst of final) {
    let rel = relByTarget.get(inst.part);
    if (!rel) {
      rel = { id: freeRelId(kept), type: REL_SLIDE, target: relativeTarget(PRESENTATION, inst.part) };
      kept.push(rel);
      relByTarget.set(inst.part, rel);
    }
    entries.push({ id: sldId, rid: rel.id });
    sldId += 1;
  }
  writeRels(zip, relsPathFor(PRESENTATION), kept);
  pkg.touched.add(relsPathFor(PRESENTATION));
  writeEntry(zip.byName.get(PRESENTATION), setSldIdLst(presXml, entries));
  pkg.touched.add(PRESENTATION);

  writeEntry(ctEntry, pkg.ct);
  pkg.touched.add(CONTENT_TYPES);

  selfCheck(zip);

  return {
    buffer: writeZip(zip),
    stats: {
      tags: ctx.stats.tags,
      resolved: ctx.stats.resolved,
      sections: ctx.stats.sections,
      images: ctx.stats.images,
      slides: final.length,
      parts: [...pkg.touched].sort(),
    },
  };
}

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

const KIND_LABEL = {
  [KIND.VALUE]: 'value',
  [KIND.OPEN_SECTION]: 'section',
  [KIND.OPEN_INVERTED]: 'inverted',
  [KIND.CLOSE]: 'close',
  [KIND.IMAGE]: 'image',
  [KIND.RAW]: 'raw',
  [KIND.COMMENT]: 'comment',
};

function collectTags(xml, locPrefix, out) {
  let paraNo = 0;
  const covered = [];

  for (const gf of findElements(xml, 'p:graphicFrame')) {
    const gfXml = xml.slice(gf.start, gf.end);
    if (!findElements(gfXml, 'a:tbl').length) continue;
    covered.push([gf.start, gf.end]);
    const name = shapeName(gfXml) || 'Table';
    findElements(gfXml, 'a:tr').forEach((tr, ri) => {
      const trXml = gfXml.slice(tr.start, tr.end);
      findElements(trXml, 'a:tc').forEach((tc, ci) => {
        const text = flatten(trXml.slice(tc.start, tc.end), 'a:t').text;
        for (const t of scan(text)) {
          out.push({ expr: t.expr, kind: KIND_LABEL[t.kind], raw: t.raw, location: `${locPrefix}, table "${name}", row ${ri + 1}, cell ${ci + 1}` });
        }
      });
    });
  }

  for (const sp of findElements(xml, 'p:sp')) {
    if (covered.some(([s, e]) => sp.start >= s && sp.end <= e)) continue;
    const spXml = xml.slice(sp.start, sp.end);
    const name = shapeName(spXml);
    const loc = name ? `${locPrefix}, shape "${name}"` : `${locPrefix}, paragraph ${paraNo + 1}`;
    for (const p of findElements(spXml, 'a:p')) {
      const text = flatten(spXml.slice(p.start, p.end), 'a:t').text;
      for (const t of scan(text)) {
        out.push({ expr: t.expr, kind: KIND_LABEL[t.kind], raw: t.raw, location: loc });
      }
    }
    paraNo += countParagraphs(spXml);
  }
}

/**
 * Every tag in the deck with its kind and where it sits, plus the distinct data
 * paths the template needs. Never resolves anything, so it never throws on a
 * template whose data has not been supplied yet — this backs
 * GET /v1/templates/:id/fields, which runs before any data exists.
 */
async function inspect(buffer) {
  const zip = readZip(buffer);
  const tags = [];
  const parts = [];

  let slides = [];
  try {
    slides = readSlideList(zip).slides;
  } catch (err) {
    if (!(err instanceof TemplateError)) throw err;
    slides = [];
  }

  slides.forEach((s, i) => {
    const entry = zip.byName.get(s.part);
    if (!entry) return;
    parts.push(s.part);
    collectTags(readText(entry), `slide ${i + 1}`, tags);
    const notes = notesPartFor(zip, s.part);
    if (notes) {
      parts.push(notes);
      collectTags(readText(zip.byName.get(notes)), `slide ${i + 1} notes`, tags);
    }
  });

  const fields = [];
  const seen = new Set();
  for (const t of tags) {
    if (t.kind === 'close' || t.kind === 'comment') continue;
    const path = t.expr.split('|')[0].trim();
    if (!path || path === '.' || path.startsWith('$')) continue;
    if (seen.has(path)) continue;
    seen.add(path);
    fields.push(path);
  }

  return { format: 'pptx', parts, tags, fields };
}

module.exports = { render, inspect, probeImage };
