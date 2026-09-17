'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { req, account, serverUp, BASE } = require('./helpers');
const H = require('./helpers/docx-fixtures');
const codes = require('../src/render/codes');
const { readZip, readEntry } = require('../src/ooxml/zip');

/**
 * AT14 over HTTP: QR codes and barcodes go through /v1/render the way a caller
 * sends them, not only through the render function. Needs a running server
 * (TEST_BASE_URL); skips when there is none, like api.test.js.
 */
let up = null;
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

function codesTemplate() {
  return H.patchPart(H.fixture('invoice'), 'word/document.xml',
    (xml) => xml.replace('{%logo}', '{%qr} {%bar}'));
}

function codesData() {
  const data = H.invoiceData();
  data.qr = { qr: 'https://docmint.app.mintapis.com', width: 120 };
  data.bar = { barcode: 'code128', value: 'INV-2026-0042', width: 300 };
  data.logo = null;
  return data;
}

when('a QR code and a Code 128 come back as the exact generated images in the DOCX', async () => {
  const { key } = await account();
  const data = codesData();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: { template_base64: codesTemplate().toString('base64'), data, currency: 'EUR' },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  const doc = Buffer.from(json.document.base64, 'base64');
  const zip = readZip(doc);
  const media = [...zip.byName.keys()].filter((n) => n.startsWith('word/media/'));
  assert.equal(media.length, 2);
  const got = media.map((n) => readEntry(zip.byName.get(n)));
  const want = [codes.codeImage(data.qr, 'qr').png, codes.codeImage(data.bar, 'bar').png];
  for (const png of want) {
    assert.ok(got.some((b) => b.equals(png)), 'each generated PNG is embedded byte for byte');
  }
});

when('a QR code and a Code 128 convert to a PDF over HTTP with both images in it', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: { template_base64: codesTemplate().toString('base64'), data: codesData(), currency: 'EUR', output: 'pdf' },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  const pdf = Buffer.from(json.pdf.base64, 'base64');
  assert.ok(pdf.length > 1000 && pdf.subarray(0, 5).equals(Buffer.from('%PDF-')), 'no PDF came back');
  assert.ok(json.pdf.pages >= 1);
  const images = (pdf.toString('latin1').match(/\/Subtype\s*\/Image/g) || []).length;
  assert.ok(images >= 2, `expected both code images in the PDF, found ${images}`);
});

when('an EAN-13 and an EPC payment QR render over HTTP', async () => {
  const { key } = await account();
  for (const spec of [
    { barcode: 'ean13', value: '400638133393' },
    { epc: { name: 'Musterfirma GmbH', iban: 'DE02 1001 0010 9307 1186 03', bic: 'BFSWDE33XXX', amount: 12.34, text: 'Rechnung 2026-0042' } },
  ]) {
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      headers: { Accept: 'application/json' },
      body: { template_base64: H.fixture('invoice').toString('base64'), data: H.invoiceData({ logo: spec }), currency: 'EUR' },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    const media = [...readZip(Buffer.from(json.document.base64, 'base64')).byName.keys()].filter((n) => n.startsWith('word/media/'));
    assert.equal(media.length, 1);
  }
});

when('a QR value that cannot fit is a 422 naming the field, never a 500', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    body: { template_base64: H.fixture('invoice').toString('base64'), data: H.invoiceData({ logo: { qr: 'x'.repeat(3000), ecc: 'H' } }), currency: 'EUR' },
  });
  assert.equal(res.status, 422, JSON.stringify(json));
  assert.equal(json.error.code, 'qr_too_long');
  assert.equal(json.error.details.field, 'logo');
});
