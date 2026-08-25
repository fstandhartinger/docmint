'use strict';

const { bad, ApiError } = require('./errors');
const { config } = require('./config');
const { scan } = require('./template/scan');
const { makeContext, resolveValue } = require('./template/resolve');
const { TemplateError } = require('./template/errors');

/**
 * Turning what the caller sent into bytes, and refusing typos.
 *
 * The API accepts unknown fields nowhere. That sounds unfriendly until you have
 * spent an hour working out why `{"fileName": "x.docx"}` did nothing, because the
 * field is `filename` and the service silently ignored the other one. A refusal
 * that names the closest real field costs the caller ten seconds.
 */

function decodeBase64(value, what) {
  const s = String(value).trim().replace(/^data:[^;]+;base64,/, '');
  if (!/^[A-Za-z0-9+/\r\n=_-]*$/.test(s) || s.length === 0) {
    throw bad('bad_base64', `"${what}" is not valid base64.`, {
      hint: 'Send the file base64-encoded. In n8n the node does this for you; from curl, use base64 -w0 yourfile.docx.',
      docs: '/docs#input',
    });
  }
  const buf = Buffer.from(s.replace(/[\r\n]/g, ''), 'base64');
  if (buf.length === 0) {
    throw bad('bad_base64', `"${what}" decoded to zero bytes.`, { docs: '/docs#input' });
  }
  return buf;
}

/** Damerau-Levenshtein again, kept local so errors.js stays about template errors. */
function distance(a, b) {
  const m = a.length; const n = b.length;
  const d = Array.from({ length: m + 1 }, (_, i) => { const r = new Array(n + 1).fill(0); r[0] = i; return r; });
  for (let j = 0; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const c = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[m][n];
}

/** Confusions edit distance will never catch, because they are different words. */
/**
 * Everything a filename may not contain: the path separators, the characters
 * Windows forbids, and the control characters. Stripping the separators is not
 * cosmetic - without it a caller could choose where the file appears to come
 * from by putting one in the data.
 */
// eslint-disable-next-line no-control-regex
const FILENAME_UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]+/g;

const ALIASES = {
  fileName: 'filename', file_name: 'filename', name: 'filename', reportName: 'filename',
  convertTo: 'output', format: 'output', outputFormat: 'output', output_format: 'output', output_type: 'output',
  context: 'data', payload: 'data', values: 'data', json: 'data', variables: 'data',
  templateId: 'template', template_id: 'template', templateName: 'template',
  file: 'template_base64', template_file: 'template_base64', document: 'template_base64',
  lang: 'locale', language: 'locale', tz: 'timezone', time_zone: 'timezone',
  on_missing: 'onMissing', missing: 'onMissing', nullGetter: 'onMissing',
  strict: 'strictScope', strict_scope: 'strictScope',
};

function rejectUnknown(body, known, docs) {
  for (const key of Object.keys(body)) {
    if (known.includes(key)) continue;
    const alias = ALIASES[key];
    if (alias && known.includes(alias)) {
      throw bad('unknown_field', `There is no field called "${key}" - did you mean "${alias}"?`, {
        hint: `Rename "${key}" to "${alias}".`,
        details: { sent: key, meant: alias, accepted: known },
        docs,
      });
    }
    let best = null; let bestD = Infinity;
    for (const k of known) {
      const dd = distance(key.toLowerCase(), k.toLowerCase());
      if (dd < bestD) { bestD = dd; best = k; }
    }
    const close = bestD <= Math.max(1, Math.floor(key.length / 3));
    throw bad('unknown_field',
      close ? `There is no field called "${key}" - did you mean "${best}"?` : `There is no field called "${key}".`, {
        hint: close ? `Rename "${key}" to "${best}".` : `Fields accepted here: ${known.join(', ')}.`,
        details: { sent: key, meant: close ? best : null, accepted: known },
        docs,
      });
  }
}

const enumOr = (value, allowed, field, docs) => {
  if (value === undefined || value === null || value === '') return allowed[0];
  const v = String(value);
  if (allowed.includes(v)) return v;
  throw bad('bad_option', `"${field}" must be one of ${allowed.map((a) => `"${a}"`).join(', ')} - got "${value}".`, { docs });
};

/** Intl throws on a bad locale or zone; a 400 naming the field beats a 500. */
function checkLocale(locale) {
  if (!locale) return 'en-US';
  try { new Intl.NumberFormat(locale); } catch {
    throw bad('bad_locale', `"${locale}" is not a language tag Intl recognises.`, {
      hint: 'Use a BCP 47 tag such as "en-US", "de-DE" or "fr-CA".', docs: '/docs#localisation',
    });
  }
  return locale;
}

function checkTimezone(tz) {
  if (!tz) return 'UTC';
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch {
    throw bad('bad_timezone', `"${tz}" is not an IANA time zone.`, {
      hint: 'Use a zone name such as "Europe/Berlin", "America/New_York" or "UTC".', docs: '/docs#localisation',
    });
  }
  return tz;
}

function checkCurrency(code) {
  if (!code) return 'USD';
  const c = String(code).toUpperCase();
  if (!/^[A-Z]{3}$/.test(c)) {
    throw bad('bad_currency', `"${code}" is not a 3-letter ISO currency code.`, {
      hint: 'Use "EUR", "USD", "GBP" and so on.', docs: '/docs#localisation',
    });
  }
  return c;
}

/**
 * The output filename may itself contain placeholders, so a workflow can produce
 * `invoice-INV-2026-0001.pdf` without a separate expression node. Carbone does the
 * same thing with `reportName` and it is the small convenience people notice.
 */
function renderFilename(pattern, data, ext, opts) {
  const fallback = `document.${ext}`;
  if (!pattern) return fallback;
  const raw = String(pattern);
  if (raw.length > 200) throw bad('filename_too_long', 'The filename pattern is longer than 200 characters.', { docs: '/docs#output' });

  const ctx = makeContext({ ...opts, onMissing: 'empty' });
  const tags = scan(raw);
  let out = '';
  let pos = 0;
  for (const tag of tags) {
    if (tag.kind !== 'value') continue;
    out += raw.slice(pos, tag.start);
    try {
      out += resolveValue(tag, [{ value: data, meta: {} }], ctx);
    } catch (e) {
      if (!(e instanceof TemplateError)) throw e;
      // A filename is cosmetic; failing the whole render over it would be absurd.
    }
    pos = tag.end;
  }
  out += raw.slice(pos);

  // Strip anything that would make the name unusable as a download, including the
  // path separators that would otherwise let a caller choose where a file lands.
  out = out.replace(FILENAME_UNSAFE, '').replace(/\s+/g, ' ').trim();
  out = out.replace(/^\.+/, '');
  if (!out) return fallback;
  if (!out.toLowerCase().endsWith(`.${ext}`)) out = `${out.replace(/\.[a-z0-9]{1,6}$/i, '')}.${ext}`;
  return out.slice(0, 180);
}

/**
 * "Render this as if it were this moment", for {#due|past} and friends. A test
 * that asserts an overdue invoice says OVERDUE has to be able to pin the day, or
 * it silently stops testing anything the moment that day arrives.
 */
function checkInstant(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    throw bad('bad_now', `"now" is not a date and time DocMint can read: ${JSON.stringify(value)}.`, {
      hint: 'Send an ISO 8601 instant such as "2026-09-25T09:00:00Z". Leave it out to use the real current time.',
      docs: '/docs#localisation',
    });
  }
  return d.toISOString();
}

function checkDataSize(data) {
  const size = Buffer.byteLength(JSON.stringify(data ?? {}));
  if (size > config.maxDataBytes) {
    throw new ApiError(413, 'data_too_large',
      `"data" is ${(size / 1048576).toFixed(1)} MB; the limit is ${(config.maxDataBytes / 1048576).toFixed(0)} MB.`, {
        hint: 'Large payloads are usually base64 images. Send fewer or smaller ones, or split the job.',
        docs: '/docs#limits',
      });
  }
  return size;
}

module.exports = { decodeBase64, rejectUnknown, enumOr, checkLocale, checkTimezone, checkCurrency, checkInstant, renderFilename, checkDataSize, ALIASES };
