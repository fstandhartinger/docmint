'use strict';

/**
 * Just enough XML to do surgery on OOXML parts.
 *
 * Deliberately not a parser. OOXML parts are large, and the round trip through a
 * DOM and back out again is where fidelity goes to die: attribute order changes,
 * namespace prefixes get rewritten, `xml:space` gets normalised away, and
 * self-closing tags come back expanded. Word forgives some of that. Excel and
 * PowerPoint forgive less. So we work on the source text and only rewrite the byte
 * ranges we actually changed; everything we did not touch is bit-identical.
 */

const ENTITIES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

function decodeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g, (m) => {
    if (ENTITIES[m]) return ENTITIES[m];
    const body = m.slice(2, -1);
    const code = body[0] === 'x' || body[0] === 'X' ? parseInt(body.slice(1), 16) : parseInt(body, 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  });
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * XML 1.0 forbids most control characters outright. A value arriving from a
 * workflow — a database column, a scraped page — routinely contains one, and a
 * single 0x0b in the middle of a document is the difference between a file that
 * opens and the "unreadable content" dialog.
 */
function stripInvalidXmlChars(s) {
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f￾￿]/g, '');
}

/**
 * Finds top-level `<tag>…</tag>` elements, counting nesting so a `w:tbl` inside a
 * `w:tbl` does not close the outer one. Handles `<tag/>`.
 *
 * @returns {Array<{start,end,openEnd,contentStart,contentEnd,selfClosing,openTag}>}
 *   `start`..`end` is the whole element; `contentStart`..`contentEnd` its children.
 */
function findElements(xml, tag, opts = {}) {
  const out = [];
  const open = new RegExp(`<${escapeRe(tag)}(?=[\\s/>])`, 'g');
  const closeStr = `</${tag}>`;
  let m;
  let searchFrom = 0;
  while ((m = nextFrom(open, xml, searchFrom))) {
    const start = m.index;
    const openEnd = findTagEnd(xml, start);
    if (openEnd === -1) break;
    const selfClosing = xml[openEnd - 2] === '/';
    const openTag = xml.slice(start, openEnd);

    if (selfClosing) {
      out.push({ start, end: openEnd, openEnd, contentStart: openEnd, contentEnd: openEnd, selfClosing: true, openTag });
      searchFrom = openEnd;
      continue;
    }

    // Walk forward counting our own opens and closes to find the matching close.
    let depth = 1;
    let p = openEnd;
    let end = -1;
    while (p < xml.length) {
      const nextClose = xml.indexOf(closeStr, p);
      if (nextClose === -1) break;
      const nestedOpen = nextOpenBetween(xml, tag, p, nextClose);
      if (nestedOpen !== -1) { depth += 1; p = nestedOpen + tag.length + 1; continue; }
      depth -= 1;
      if (depth === 0) { end = nextClose + closeStr.length; break; }
      p = nextClose + closeStr.length;
    }
    if (end === -1) break;

    out.push({ start, end, openEnd, contentStart: openEnd, contentEnd: end - closeStr.length, selfClosing: false, openTag });
    searchFrom = opts.nested ? openEnd : end;
  }
  return out;
}

function nextOpenBetween(xml, tag, from, before) {
  const re = new RegExp(`<${escapeRe(tag)}(?=[\\s/>])`, 'g');
  re.lastIndex = from;
  const m = re.exec(xml);
  if (!m || m.index >= before) return -1;
  // A self-closing nested element does not add depth.
  const tagEnd = findTagEnd(xml, m.index);
  if (tagEnd !== -1 && xml[tagEnd - 2] === '/') return nextOpenBetween(xml, tag, tagEnd, before);
  return m.index;
}

function nextFrom(re, xml, from) {
  re.lastIndex = from;
  return re.exec(xml);
}

/** Index just past the `>` of the tag starting at `start`, quote-aware. */
function findTagEnd(xml, start) {
  let quote = null;
  for (let i = start; i < xml.length; i += 1) {
    const c = xml[i];
    if (quote) { if (c === quote) quote = null; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '>') return i + 1;
  }
  return -1;
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads an attribute off an opening tag, decoded. Returns null when absent. */
function attr(openTag, name) {
  const re = new RegExp(`\\s${escapeRe(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`);
  const m = re.exec(openTag);
  if (!m) return null;
  return decodeXml(m[2] !== undefined ? m[2] : m[3]);
}

/** Sets or replaces an attribute on an opening tag, returning the new tag text. */
function setAttr(openTag, name, value) {
  const escaped = escapeXml(value);
  const re = new RegExp(`(\\s${escapeRe(name)}\\s*=\\s*)("[^"]*"|'[^']*')`);
  if (re.test(openTag)) return openTag.replace(re, `$1"${escaped}"`);
  const selfClosing = openTag.endsWith('/>');
  return `${openTag.slice(0, selfClosing ? -2 : -1)} ${name}="${escaped}"${selfClosing ? '/>' : '>'}`;
}

/**
 * Applies non-overlapping `{start,end,text}` edits to a string, right to left so
 * earlier offsets stay valid.
 */
function applyEdits(xml, edits) {
  const sorted = [...edits].sort((a, b) => b.start - a.start);
  let out = xml;
  let lastStart = Infinity;
  for (const e of sorted) {
    if (e.end > lastStart) throw new Error(`overlapping XML edits at ${e.start}..${e.end}`);
    out = out.slice(0, e.start) + e.text + out.slice(e.end);
    lastStart = e.start;
  }
  return out;
}

module.exports = { decodeXml, escapeXml, stripInvalidXmlChars, findElements, findTagEnd, attr, setAttr, applyEdits };
