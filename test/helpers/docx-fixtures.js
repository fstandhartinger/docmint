'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readZip, readText, writeEntry, writeZip } = require('../../src/ooxml/zip');

/**
 * Fixture loading and LibreOffice round-tripping for the DOCX tests.
 *
 * The .docx files under fixtures/ are produced by LibreOffice from the .fodt
 * sources next to them — see fixtures/make-docx-fixtures.sh. They are committed
 * because a test suite that regenerates its own inputs from the code under test
 * proves nothing, and because LibreOffice is not on every machine that runs
 * `npm test`.
 */

const ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const OUT = path.join(ROOT, 'out');

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, `${name}.docx`));
}

function partText(buffer, partName) {
  const zip = readZip(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer));
  const entry = zip.byName.get(partName);
  if (!entry) throw new Error(`no part "${partName}" in the package`);
  return readText(entry);
}

function partNames(buffer) {
  return readZip(buffer).entries.map((e) => e.name);
}

const TOKEN = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:(br|tab|cr)\/>|<\/w:(p|tc)>/g;

/**
 * The visible text of a part, in document order. Not a substitute for converting
 * with LibreOffice — it cannot tell a valid document from an unopenable one — but
 * it makes an assertion about *what the reader sees* cheap enough to write for
 * every case.
 */
function visibleText(buffer, partName = 'word/document.xml') {
  const xml = partText(buffer, partName);
  let out = '';
  for (const m of xml.matchAll(TOKEN)) {
    if (m[1] !== undefined) out += decode(m[1]);
    else if (m[2] === 'tab') out += '\t';
    else if (m[2] === 'br' || m[2] === 'cr') out += '\n';
    else if (m[3]) out += '\n';
  }
  return out;
}

const decode = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

const count = (xml, re) => (xml.match(re) || []).length;

/** Strips Default entries from [Content_Types].xml, to test that we re-add them. */
function withoutContentTypeDefaults(buffer, exts) {
  const zip = readZip(buffer);
  const ct = zip.byName.get('[Content_Types].xml');
  let xml = readText(ct);
  for (const ext of exts) {
    xml = xml.replace(new RegExp(`<Default Extension="${ext}"[^>]*/>`, 'g'), '');
  }
  writeEntry(ct, xml);
  return writeZip(zip);
}

/** Rewrites one part of a package, for building deliberately broken templates. */
function patchPart(buffer, partName, fn) {
  const zip = readZip(buffer);
  const entry = zip.byName.get(partName);
  writeEntry(entry, fn(readText(entry)));
  return writeZip(zip);
}

/** The compressed bytes of an entry, to prove an untouched part stayed untouched. */
function rawEntry(buffer, name) {
  const e = readZip(buffer).byName.get(name);
  return e ? Buffer.from(e.raw) : null;
}

// --- LibreOffice ------------------------------------------------------------

let loChecked = null;

/**
 * LibreOffice lives in the docmint-lo-probe image rather than on the host, so the
 * conversion tests need docker. They are skipped, loudly, when it is absent —
 * asserting on XML alone would let a file that no word processor can open pass.
 */
function libreOfficeAvailable() {
  if (loChecked !== null) return loChecked;
  if (process.env.DOCMINT_SKIP_LO === '1') { loChecked = false; return loChecked; }
  try {
    execFileSync('sudo', ['-n', 'docker', 'image', 'inspect', 'docmint-lo-probe'], { stdio: 'ignore' });
    loChecked = true;
  } catch {
    loChecked = false;
  }
  return loChecked;
}

/** Writes the buffer to out/, converts it with LibreOffice, returns the plain text. */
function toPlainText(buffer, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const docx = path.join(OUT, `${name}.docx`);
  fs.writeFileSync(docx, buffer);
  const txt = execFileSync(path.join(ROOT, 'scripts', 'lo.sh'), ['txt', docx], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  // The conversion runs as root inside the container; read it back before it is
  // overwritten by the next test.
  const out = fs.readFileSync(txt, 'utf8').replace(/^﻿/, '');
  return out;
}

function toPdf(buffer, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const docx = path.join(OUT, `${name}.docx`);
  fs.writeFileSync(docx, buffer);
  const pdf = execFileSync(path.join(ROOT, 'scripts', 'lo.sh'), ['pdf', docx], {
    encoding: 'utf8', timeout: 120000,
  }).trim();
  return fs.readFileSync(pdf);
}

// --- images -----------------------------------------------------------------

// Real files, not made-up bytes: the renderer reads the intrinsic size out of the
// header, so a fake header would test the renderer against itself.
const PNG_8x4 = 'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAECAYAAACzzX7wAAAAFElEQVR4nGP8z8DAwMDAxAADRDIA'
  + 'j+wCBB2Y8+wAAAAASUVORK5CYII=';

const GIF_1x1 = 'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

const JPEG_39x24 = ''
  + '/9j/4AAQSkZJRgABAQEASQBLAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a'
  + 'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAAYACcBAREA/8QAHwAAAQUBAQEB'
  + 'AQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1Fh'
  + 'ByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZ'
  + 'WmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXG'
  + 'x8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/9oACAEBAAA/APWtV8Uy6J4nsNP1Czgg'
  + '0y+VxFqTXJAWRV3eWy7MKSASDu5we/Faeh6heapp4vLqxS0WQkwqJS7NHn5WYFV2kjBx1GecHitK'
  + 'iiuP8U6WPGzz+G5Eurayij86W7Nuy7pefLEbMMHafmJB/ujkFsXvBms6hq2iKur2Vza6nbMYbgy2'
  + 'zxJMynHmRllGVYc8dM4roqKKKKKKK//Z';

// --- the invoice's data -----------------------------------------------------

/**
 * The line totals are computed here from qty and unit_price, and the tests then
 * assert that the grand total the *template* computes (with sumProduct) equals
 * the sum of them. An example invoice whose numbers do not add up is worse than
 * no example at all.
 */
function invoiceData(overrides = {}) {
  const items = [
    { description: 'Consulting, senior rate', qty: 10, unit_price: 150 },
    { description: 'Design sprint', qty: 2, unit_price: 1200 },
    { description: 'Hosting (monthly)', qty: 12, unit_price: 29.5 },
  ].map((i) => ({ ...i, line_total: Math.round(i.qty * i.unit_price * 100) / 100 }));

  return {
    invoice_no: 'INV-2026-0042',
    company: 'DocMint GmbH',
    issued: '2026-03-14',
    customer: { name: 'Acme Corporation', address: '12 Example Street\nBerlin\nGermany' },
    items,
    paid: false,
    terms_days: 14,
    notes: ['Bank transfer only, no cheques.', 'Late payment attracts 8% interest.'],
    logo: PNG_8x4,
    ...overrides,
  };
}

const invoiceTotal = (data) => data.items.reduce((a, i) => a + i.qty * i.unit_price, 0);

const eur = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(n);

module.exports = {
  ROOT, FIXTURES, OUT,
  fixture, partText, partNames, visibleText, count, withoutContentTypeDefaults,
  patchPart, rawEntry,
  libreOfficeAvailable, toPlainText, toPdf,
  PNG_8x4, GIF_1x1, JPEG_39x24,
  invoiceData, invoiceTotal, eur,
};
