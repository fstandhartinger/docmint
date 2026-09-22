'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { req, serverUp, BASE } = require('./helpers');
const codes = require('../src/render/codes');
const { imageCapabilities, pdfPasswordCapability } = require('../src/capabilities');
const input = require('../src/input');

/**
 * AT-P2/AT-P5 honest-claims parity harness. Proves, on a running server, that
 * the published capability readback (GET /v1/capabilities) and the public
 * claims agree in BOTH directions: every formatter/code/image capability the
 * docs or README claim appears in the live readback, and every capability the
 * readback lists traces to a docs claim or to a DECISIONS.md row. The AT14
 * image-code placeholders are asserted to come from the very same canonical
 * list the render path draws with (src/render/codes.js), imported here
 * directly — so the endpoint cannot carry a second, drifting handwritten list.
 *
 * Needs a running server (TEST_BASE_URL) like api.test.js; skips when there is
 * none. The docs, README and DECISIONS are read as files, like
 * public-copy-honesty.test.js does.
 */
const DOCS = fs.readFileSync(path.join(__dirname, '..', 'public', 'docs.html'), 'utf8');
const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');
const DECISIONS = fs.readFileSync(path.join(__dirname, '..', 'DECISIONS.md'), 'utf8');

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function section(id) {
  const m = DOCS.match(new RegExp(`<section id="${id}">([\\s\\S]*?)</section>`));
  assert.ok(m, `the docs page has no section #${id}`);
  return m[1];
}

/** An h3 anchor (like #pdf-password) inside a section, up to the next h3 or the section end. */
function subsection(id) {
  const m = DOCS.match(new RegExp(`<h3 id="${id}">([\\s\\S]*?)(?=<h3 id=|</section>)`));
  assert.ok(m, `the docs page has no subsection #${id}`);
  return m[1];
}

const DOCS_IMAGES = visibleText(section('images'));
const DOCS_ALL = visibleText(DOCS);
// The formatter tables only — the error-code table at the end of the section
// names codes like unknown_formatter, which are not formatters.
const FORMATTER_TABLE = section('formatters').split('<h3>Formatter errors</h3>')[0];
const DOCS_FORMATTERS = [...FORMATTER_TABLE.matchAll(/<tr><td><code>([A-Za-z]+)<\/code><\/td>/g)].map((m) => m[1]);

// The code placeholders as the docs claim them, mapped to readback entry ids.
const DOCS_CODE_CLAIMS = [
  ['{"qr"', 'qr'],
  ['"barcode": "code128"', 'barcode:code128'],
  ['"barcode": "ean13"', 'barcode:ean13'],
  ['{"epc"', 'epc'],
];

const entryId = (e) => (e.key === 'barcode' ? `${e.key}:${e.barcode}` : e.key);

let up = null;
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

test('the canonical code list has exactly the four placeholders the render path accepts', () => {
  const list = codes.codePlaceholders();
  assert.deepEqual(list.map(entryId), ['qr', 'barcode:code128', 'barcode:ean13', 'epc']);
  for (const entry of list) {
    assert.ok(entry.spec[entry.key] !== undefined, `the ${entryId(entry)} entry carries no such spec`);
    // The gate the DOCX/XLSX/PPTX renderers call accepts every published spec.
    assert.equal(codes.isCodeSpec(entry.spec), true, `the render path does not accept ${entryId(entry)}`);
  }
  // Both directions against the constants the validators accept: every code
  // key and barcode kind the drawing code implements is listed, nothing else,
  // and every listed spec actually draws.
  const kinds = list.filter((e) => e.key === 'barcode').map((e) => e.barcode).sort();
  assert.deepEqual(kinds, [...codes.BARCODE_KINDS].sort());
  assert.deepEqual([...new Set(list.map((e) => e.key))].sort(), [...codes.CODE_KEYS].sort());
  for (const entry of list) {
    const out = codes.codeImage(entry.spec, 'parity');
    assert.ok(Buffer.isBuffer(out.png) && out.png.length > 0, `${entryId(entry)} does not draw`);
  }
});

test('the published images capability is composed only from the render module', () => {
  const published = imageCapabilities();
  assert.deepEqual(published.codes, codes.codePlaceholders());
  for (const alias of ['data', 'base64', 'bytes', 'content']) {
    assert.ok(published.bytes.keys.includes(alias), `the readback carries no docs-claimed alias "${alias}"`);
  }
  assert.ok(published.bytes.keys.includes('url'));
  assert.equal(published.bytes.url_not_fetched, true);
});

/* ------------------------------------------------------------------------- *
 * AT-P6, file-only: the pdf_password readback is built from the validator's
 * constants and the docs #pdf-password section claims exactly what is
 * enforced — the field, the limits, the refusing endpoints and the measured
 * encryption. Needs no server; the live probe below asserts the endpoint
 * serves the same object.
 * ------------------------------------------------------------------------- */
const DOCS_PDF_PASSWORD = visibleText(subsection('pdf-password'));

test('AT-P6 the pdf_password capability is the validator constants, and the docs claim them', () => {
  const cap = pdfPasswordCapability();
  assert.deepEqual(cap, {
    field: 'pdf_password',
    min_length: input.PDF_PASSWORD_MIN_LENGTH,
    max_length: input.PDF_PASSWORD_MAX_LENGTH,
    endpoints: ['/v1/render'],
    encryption: 'RC4-128 (PDF standard security handler revision 3, as applied by LibreOffice 7.4)',
  });
  // The docs section names the field, the limits and the refusing endpoints.
  assert.ok(DOCS_PDF_PASSWORD.includes(cap.field), 'the docs #pdf-password section stopped naming the field');
  assert.ok(
    DOCS_PDF_PASSWORD.includes(`${cap.min_length} to ${cap.max_length}`),
    'the docs #pdf-password section stopped stating the length limits',
  );
  for (const refusing of ['/v1/render/batch', '/v1/jobs']) {
    assert.ok(DOCS_PDF_PASSWORD.includes(refusing), `the docs #pdf-password section stopped naming the refusing ${refusing}`);
  }
  for (const code of ['bad_pdf_password', 'pdf_password_needs_pdf', 'pdf_password_unsupported_here']) {
    assert.ok(DOCS_PDF_PASSWORD.includes(code), `the docs #pdf-password section stopped naming ${code}`);
  }
  // The published encryption is the measured one, and the docs state it too.
  assert.ok(DOCS_PDF_PASSWORD.includes('rc4'), 'the docs #pdf-password section stopped stating the measured encryption');
});

when('AT-P6 the live readback serves the same pdf.password_protection object the code publishes', async () => {
  const { res, json } = await req('/v1/capabilities');
  assert.equal(res.status, 200);
  assert.deepEqual(json.pdf.password_protection, pdfPasswordCapability());
});

/* ------------------------------------------------------------------------- *
 * AT-I4, file-only: the #images alias sentence must claim exactly the byte
 * keys the readback publishes as data_keys (data itself excepted), and the
 * URL keys must be named in the same section — both directions. Needs no
 * server: the docs are read as a file, like the stale-copy tests below.
 * ------------------------------------------------------------------------- */

// The #images section up to the next heading: the alias table, the URL row and
// the images-option example — the section where the image contract is claimed.
const IMAGES_SECTION = section('images').split('<h3')[0];

/**
 * The alias claim, as the docs write it: every <code>name</code> in the table
 * cell that carries "accepted as aliases for", before that phrase.
 */
function claimedAliases(html) {
  const at = html.indexOf('accepted as aliases for');
  if (at === -1) return null;
  const cellStart = html.lastIndexOf('<td', at);
  const cellEnd = html.indexOf('</td>', at);
  if (cellStart === -1 || cellEnd === -1) return null;
  return [...html.slice(cellStart, at).matchAll(/<code>([^<]+)<\/code>/g)].map((m) => m[1]);
}

function aliasParity(html) {
  const published = imageCapabilities().bytes.data_keys.filter((k) => k !== 'data');
  const claimed = claimedAliases(html) || [];
  return {
    missing: published.filter((k) => !claimed.includes(k)),
    extra: claimed.filter((k) => !published.includes(k)),
  };
}

test('AT-I4 the docs alias sentence claims exactly the published data_keys minus data, and names every URL key, both directions', () => {
  const { missing, extra } = aliasParity(IMAGES_SECTION);
  assert.deepEqual(missing, [], `the docs alias sentence omits published data keys: ${missing.join(', ') || '(none)'}`);
  assert.deepEqual(extra, [], `the docs alias sentence claims keys the readback does not publish: ${extra.join(', ') || '(none)'}`);
  // Every URL key appears in the same section, as <code>name</code> or as
  // {"name" inside a code element.
  for (const key of imageCapabilities().bytes.url_keys) {
    const plain = new RegExp(`<code>${key}<\\/code>`).test(IMAGES_SECTION);
    const jsonKey = new RegExp(`<code>\\{"${key}"`).test(IMAGES_SECTION);
    assert.ok(plain || jsonKey, `the docs #images section stopped naming the URL key "${key}"`);
  }
  // Not a vacuous pass: the extractor must detect a claim removed from the
  // docs copy, so the both-directions check above cannot pass against nothing.
  const mutated = IMAGES_SECTION.replace(/<code>buffer<\/code> and\s*/, '');
  const after = aliasParity(mutated);
  assert.ok(after.missing.includes('buffer'),
    `the extractor did not notice the docs no longer claiming "buffer": ${JSON.stringify(after)}`);
});

when('the live /v1/capabilities serves the image-code placeholders from the one code list the render path uses', async () => {
  const { res, json } = await req('/v1/capabilities');
  assert.equal(res.status, 200);
  assert.deepEqual(json.images, imageCapabilities());
  assert.deepEqual(json.images.codes, codes.codePlaceholders());
});

when('every codes/images capability the docs claim appears in the live readback', async () => {
  const { json } = await req('/v1/capabilities');
  const live = json.images.codes;
  for (const [needle, id] of DOCS_CODE_CLAIMS) {
    assert.ok(DOCS_IMAGES.includes(needle), `the docs stopped claiming ${needle}`);
    assert.ok(live.some((e) => entryId(e) === id), `the docs claim ${id} but the live readback omits it`);
  }
  for (const alias of ['data', 'base64', 'bytes', 'content', 'url']) {
    assert.ok(new RegExp(`\\b${alias}\\b`).test(DOCS_IMAGES), `the docs image claim for "${alias}" vanished`);
    assert.ok(json.images.bytes.keys.includes(alias), `the live readback omits the docs-claimed key "${alias}"`);
  }
  assert.match(json.images.bytes.supplied_as, /images option/);
  // README-claimed ("One placeholder syntax across all three formats, images
  // included"): the images capability must be in the readback for it too.
  assert.match(README, /images/i);
  assert.equal(live.length, 4);
});

when('every formatter the docs claim appears in the live readback, in both directions', async () => {
  const { json } = await req('/v1/capabilities');
  const live = json.formatters.map((f) => f.name);
  assert.ok(DOCS_FORMATTERS.length >= 40, `only ${DOCS_FORMATTERS.length} formatters extracted from the docs table`);
  for (const n of DOCS_FORMATTERS) assert.ok(live.includes(n), `the docs claim formatter ${n} but the readback omits it`);
  for (const n of live) assert.ok(DOCS_FORMATTERS.includes(n), `the readback lists ${n} but the docs formatter table does not claim it`);
  const countClaim = (section('formatters').match(/(\d+) of them/) || [])[1];
  assert.equal(live.length, Number(countClaim), 'the docs formatter count claim and the live readback disagree');
});

when('every capability the readback lists traces to a docs claim or a DECISIONS row', async () => {
  const { json } = await req('/v1/capabilities');
  // The keys whose capability the docs page claims in text. Everything else
  // has to trace to a DECISIONS.md row (added this round for the image-code
  // readback and the async/jobs and batch limits readback).
  const docsTraced = ['formats', 'outputs', 'pdf', 'formatters', 'limits', 'credits', 'images'];
  for (const key of Object.keys(json)) {
    if (docsTraced.includes(key)) {
      assert.ok(DOCS_ALL.includes(key), `readback capability "${key}" is claimed nowhere on the docs page`);
    } else {
      assert.ok(DECISIONS.includes(key), `readback capability "${key}" traces neither to a docs claim nor to a DECISIONS.md row`);
    }
  }
  for (const key of Object.keys(json.limits)) {
    assert.ok(DOCS_ALL.includes(key) || DECISIONS.includes(key), `limit "${key}" traces neither to the docs page nor to a DECISIONS.md row`);
  }
  // The async/jobs capability is claimed positively on the docs page since the
  // stale "Not available yet" section was replaced with real reference sections
  // (2026-09-21), so each key of its readback may trace to the docs OR to the
  // DECISIONS rows that carried the claim while the page was stale. Both traces
  // stay real: at least one must name the key.
  for (const key of Object.keys(json.async)) {
    assert.ok(
      DOCS_ALL.includes(key) || DECISIONS.includes(key),
      `async readback key "${key}" traces neither to the docs page nor to a DECISIONS.md row`,
    );
  }
  // The image-code entries trace back to the docs claims they surface.
  for (const entry of json.images.codes) {
    const needle = entry.key === 'barcode' ? `"barcode": "${entry.barcode}"` : `"${entry.key}"`;
    assert.ok(DOCS_IMAGES.includes(needle), `the readback lists ${needle} but the docs page does not claim it`);
  }
});

/* ------------------------------------------------------------------------- *
 * AT-D2: the async/batch/webhook claims. The old "Not available yet" section
 * answered "404 unknown_endpoint" for six endpoints that had already shipped —
 * the drift this file exists to catch, in the opposite direction (claimed
 * absent when shipped). The file-only tests below keep that stale copy from
 * returning and pin the anchors that error messages in src/api.js,
 * src/batch.js, src/jobs.js and src/net.js link to; the live probe proves the
 * routes answer as authenticated endpoints, not 404s.
 * ------------------------------------------------------------------------- */
const ASYNC_PATHS = ['/v1/jobs', '/v1/render/batch', '/v1/webhooks'];

// The stale copy exactly as the old #notyet section read before it was replaced,
// so the detector below cannot pass vacuously. Copied verbatim from
// public/docs.html before it was edited.
const STALE_ASYNC_COPY = `<section id="notyet">
<h2>Not available yet</h2>
<p>Every one of these answered <code>404 unknown_endpoint</code> when this page was written, on 25 August 2026: <code>POST /v1/jobs</code>, <code>GET /v1/jobs</code>, <code>GET /v1/jobs/:id</code>, <code>POST /v1/jobs/:id/cancel</code>, <code>POST /v1/render/batch</code>, <code>GET /v1/webhooks</code>. Nothing about their behaviour is described here.</p>
<h3 id="async">Asynchronous rendering</h3>
<p>Not available yet. Every render today is synchronous: you POST, and the response body is the file.</p>
<h3 id="batch">Batch rendering</h3>
<p>Not available yet. One template, many data rows, one call.</p>
</section>`;

function staleAsyncClaims(html) {
  const hits = [];
  const text = visibleText(html);
  if (/answered 404 unknown_endpoint[\s\S]{0,200}\/v1\/jobs/.test(text)) {
    hits.push('the stale "answered 404 unknown_endpoint" sentence naming /v1/jobs');
  }
  for (const m of html.matchAll(/<section id="([^"]+)">([\s\S]*?)<\/section>/g)) {
    const s = visibleText(m[2]);
    const named = ASYNC_PATHS.filter((p) => s.includes(p));
    if (s.includes('not available yet') && named.length) {
      hits.push(`section #${m[1]} claims "not available yet" while naming ${named.join(', ')}`);
    }
  }
  return hits;
}

test('the stale-claim detector detects the old copy it is aimed at (no vacuous pass)', () => {
  const hits = staleAsyncClaims(STALE_ASYNC_COPY);
  assert.ok(hits.length >= 2, `the detector found nothing in the stale fixture: ${JSON.stringify(hits)}`);
});

test('the docs contain no stale unavailability claim for the shipped async/batch endpoints', () => {
  assert.deepEqual(staleAsyncClaims(DOCS), []);
  assert.ok(!/id="notyet"/.test(DOCS), 'the #notyet section was removed but its id remains');
});

test('the async and batch anchors survive, because error messages link to them', () => {
  for (const anchor of ['async', 'batch']) {
    assert.ok(new RegExp(`id="${anchor}"`).test(DOCS), `public/docs.html lost id="${anchor}"`);
  }
});

when('each shipped async/batch/webhook endpoint answers 401 missing_api_key, not 404', async () => {
  const probes = [
    ['POST', '/v1/jobs'],
    ['GET', '/v1/jobs'],
    ['GET', '/v1/jobs/no-such-job'],
    ['POST', '/v1/jobs/no-such-job/cancel'],
    ['POST', '/v1/render/batch'],
    ['GET', '/v1/webhooks'],
  ];
  for (const [method, path] of probes) {
    // eslint-disable-next-line no-await-in-loop
    const { res, json } = await req(path, { method });
    assert.equal(res.status, 401, `${method} ${path} did not demand a key`);
    assert.equal(json?.error?.code, 'missing_api_key', `${method} ${path}`);
    assert.notEqual(json?.error?.code, 'unknown_endpoint', `${method} ${path} is routed but claimed otherwise`);
  }
});
