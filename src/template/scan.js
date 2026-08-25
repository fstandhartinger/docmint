'use strict';

/**
 * The tag scanner.
 *
 * Two delimiter styles are accepted at once, deliberately:
 *
 *   {name}     docxtemplater / Carbone style — what people who have used a
 *              document generator before will type.
 *   {{name}}   mustache / handlebars style — what people coming from n8n
 *              expressions will type.
 *
 * They cannot collide: a run beginning `{{` is always read as a double tag, so
 * `{{x}}` never parses as `{` + `{x}` + `}`. Supporting both costs one branch
 * here and removes the single most common first-five-minutes failure, which is
 * typing the other one.
 *
 * Anything between delimiters that does not look like a tag is left alone as
 * literal text. Real documents contain JSON samples, CSS and code, and turning
 * `{ "a": 1 }` into an error would make the product unusable for them. What
 * *does* parse as a tag is then held to a strict standard: it must resolve.
 */

const OPEN_SECTION = 'section';
const OPEN_INVERTED = 'inverted';
const CLOSE = 'close';
const VALUE = 'value';
const IMAGE = 'image';
const RAW = 'raw';
const COMMENT = 'comment';

// A tag body is short, single-line, and made of identifier-ish characters. The
// character class is deliberately tight: it is what keeps `{ "total": 12 }` and
// `${x}` in a code sample from being mistaken for tags.
const BODY_OK = /^[A-Za-z0-9_$.\[\]\-|:,'"%@#^/! ]*$/;
// A bracketed key may contain almost anything, so it is validated by PATH_RE
// rather than by the character class above.
const MAX_BODY = 200;

/**
 * @returns {Array<{kind,expr,raw,start,end}>} tags in source order.
 *   `start`/`end` are indices into `text`; end is exclusive.
 */
function scan(text) {
  const tags = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const open = text.indexOf('{', i);
    if (open === -1) break;

    // `${x}` is a shell/CSS/JS interpolation, not one of ours. Skipping it keeps
    // code samples pasted into a document intact.
    if (open > 0 && text[open - 1] === '$') { i = open + 1; continue; }

    const isDouble = text[open + 1] === '{';
    const openLen = isDouble ? 2 : 1;
    const closeStr = isDouble ? '}}' : '}';

    // Find the matching close. For a single tag, the first `}`. For a double
    // tag, the first `}}` — which lets `{{a}}` work while `{{a}` is left alone.
    const close = text.indexOf(closeStr, open + openLen);
    if (close === -1) { i = open + 1; continue; }

    const body = text.slice(open + openLen, close);
    if (body.length > MAX_BODY || body.includes('\n') || !BODY_OK.test(body)) {
      i = open + 1;
      continue;
    }

    const tag = parseBody(body.trim());
    if (!tag) { i = open + 1; continue; }

    const end = close + closeStr.length;
    tags.push({ ...tag, raw: text.slice(open, end), start: open, end, delimiters: isDouble ? 2 : 1 });
    i = end;
  }
  return tags;
}

/** Turns a trimmed tag body into a tag, or returns null if it is not a tag. */
function parseBody(body) {
  if (body === '') return null;

  const sigil = body[0];
  const rest = body.slice(1).trim();

  if (sigil === '!') return { kind: COMMENT, expr: rest, path: null, formatters: [] };
  // Sections take a formatter pipeline too, so a template can say
  // {#items|filter:active|sort:due_date} rather than making the caller pre-sort
  // the array in the workflow before it ever reaches us.
  if (sigil === '#') { const p = splitPipes(rest); return p ? { kind: OPEN_SECTION, expr: rest, ...p } : null; }
  if (sigil === '^') { const p = splitPipes(rest); return p ? { kind: OPEN_INVERTED, expr: rest, ...p } : null; }
  if (sigil === '/') {
    // `{/}` closes whatever is open — convenient inside table cells where
    // repeating the name is noise.
    if (rest === '') return { kind: CLOSE, expr: '', path: null, formatters: [] };
    const p = splitPipes(rest);
    return p ? { kind: CLOSE, expr: p.path, path: p.path, formatters: [] } : null;
  }
  if (sigil === '%') return isPath(rest) ? { kind: IMAGE, expr: rest, ...splitPipes(rest) } : null;
  if (sigil === '@') return isPath(rest) ? { kind: RAW, expr: rest, path: rest, formatters: [] } : null;

  const parts = splitPipes(body);
  if (!parts) return null;
  return { kind: VALUE, expr: body, ...parts };
}

/** `price | currency:EUR | pad:10` -> { path, formatters:[{name,args}] } */
function splitPipes(body) {
  const segs = splitTop(body, '|');
  const path = segs[0].trim();
  if (!isPath(path)) return null;
  const formatters = [];
  for (const seg of segs.slice(1)) {
    const s = seg.trim();
    if (!s) return null;
    const colon = s.indexOf(':');
    const name = (colon === -1 ? s : s.slice(0, colon)).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return null;
    const args = colon === -1 ? [] : splitTop(s.slice(colon + 1), ':').map(unquote);
    formatters.push({ name, args });
  }
  return { path, formatters };
}

/** Split on `sep` but not inside quotes, so `default:'a|b'` survives. */
function splitTop(s, sep) {
  const out = [];
  let cur = '';
  let quote = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null; else cur += ch;
      if (ch === quote) cur += ''; // closing quote is dropped
      continue;
    }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === sep) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

const unquote = (s) => s.trim();

/**
 * `a`, `a.b`, `a.0.b`, `a[0].b`, `.`, `$index`, `$first`, `../a`.
 * Anything else is not a path and therefore not a tag.
 */
const SEG = String.raw`(\$?[A-Za-z_][A-Za-z0-9_]*|\d+|\[[^\[\]]+\])`;
const PATH_RE = new RegExp(`^(\\.|(\\.\\./)*${SEG}(${SEG}|\\.${SEG})*)$`);

function isPath(s) {
  const t = String(s).trim();
  return PATH_RE.test(t);
}

module.exports = {
  scan, parseBody, isPath, splitPipes,
  KIND: { OPEN_SECTION, OPEN_INVERTED, CLOSE, VALUE, IMAGE, RAW, COMMENT },
};
