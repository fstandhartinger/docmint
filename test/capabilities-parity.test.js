'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { req, serverUp, BASE } = require('./helpers');
const codes = require('../src/render/codes');
const { imageCapabilities } = require('../src/capabilities');

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
  // The async/jobs capability is not claimed positively on the docs page (its
  // "Not available yet" section predates the jobs feature), so every key of
  // its readback traces to the DECISIONS rows added this round.
  for (const key of Object.keys(json.async)) {
    assert.ok(DECISIONS.includes(key), `async readback key "${key}" has no DECISIONS.md row`);
  }
  // The image-code entries trace back to the docs claims they surface.
  for (const entry of json.images.codes) {
    const needle = entry.key === 'barcode' ? `"barcode": "${entry.barcode}"` : `"${entry.key}"`;
    assert.ok(DOCS_IMAGES.includes(needle), `the readback lists ${needle} but the docs page does not claim it`);
  }
});
