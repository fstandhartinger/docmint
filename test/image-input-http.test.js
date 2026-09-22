'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { req, account, serverUp, BASE } = require('./helpers');
const H = require('./helpers/docx-fixtures');
const PX = require('./helpers/pptx-fixtures');
const XX = require('./helpers/xlsx-fixtures');
const { readZip, readEntry } = require('../src/ooxml/zip');

/**
 * AT-I7 over HTTP: the one image-input contract reaches POST /v1/render the way
 * a caller sends it — a PPTX and an XLSX whose {%logo} placeholder is satisfied
 * by a URL through the request's images option, by bytes in the data, and
 * refused with 422 image_url_unsupported when a URL arrives without any.
 * Needs a running server (TEST_BASE_URL); skips when there is none, like
 * codes-http.test.js.
 */
let up = null;
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

const PNG_B64 = H.PNG_8x4; // a real 8x4 PNG, as a base64 string
const PNG = Buffer.from(PNG_B64, 'base64');
const URL = 'https://example.com/logo.png';

const FORMATS = [
  {
    id: 'pptx',
    template: () => PX.fixture('report'),
    mediaPrefix: 'ppt/media/',
    // Everything the 'report' fixture's other placeholders read, so only {%logo} is under test.
    data: () => ({
      title: 'Q3 Review',
      subtitle: 'Quarterly numbers',
      client: { name: 'Acme GmbH' },
      notes: 'Open with the churn number.',
      rows: [{ sku: 'A-1', qty: 2, amount: 150 }],
      findings: [{ label: 'Churn', detail: 'down 2pt', owner: 'Ada' }],
    }),
  },
  {
    id: 'xlsx',
    template: () => XX.fixture('images.xlsx'),
    mediaPrefix: 'xl/media/',
    data: () => ({ company: 'Acme GmbH' }),
  },
];

/** The embedded media parts of a rendered package, as plain buffers. */
function mediaImages(buffer, prefix) {
  const zip = readZip(buffer);
  return [...zip.byName.keys()].filter((n) => n.startsWith(prefix))
    .map((n) => readEntry(zip.byName.get(n)));
}

for (const f of FORMATS) {
  when(`AT-I7 ${f.id}: {"logo":{"url":…}} with the bytes supplied through the request images option renders the supplied PNG`, async () => {
    const { key } = await account();
    const data = f.data();
    data.logo = { url: URL };
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      headers: { Accept: 'application/json' },
      body: {
        template_base64: f.template().toString('base64'), data, currency: 'EUR', output: 'document',
        images: { [URL]: PNG_B64 },
      },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    const media = mediaImages(Buffer.from(json.document.base64, 'base64'), f.mediaPrefix);
    assert.equal(media.length, 1);
    assert.ok(media[0].equals(PNG), 'the embedded image bytes equal the supplied PNG');
  });

  when(`AT-I7 ${f.id}: {"logo":{"bytes":…}} in the data renders the PNG without the images option`, async () => {
    const { key } = await account();
    const data = f.data();
    data.logo = { bytes: PNG_B64 };
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      headers: { Accept: 'application/json' },
      body: { template_base64: f.template().toString('base64'), data, currency: 'EUR', output: 'document' },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    const media = mediaImages(Buffer.from(json.document.base64, 'base64'), f.mediaPrefix);
    assert.equal(media.length, 1);
    assert.ok(media[0].equals(PNG), 'the embedded image bytes equal the supplied PNG');
  });

  when(`AT-I7 ${f.id}: {"logo":{"url":…}} without the images option is a 422 image_url_unsupported`, async () => {
    const { key } = await account();
    const data = f.data();
    data.logo = { url: URL };
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      body: { template_base64: f.template().toString('base64'), data, currency: 'EUR', output: 'document' },
    });
    assert.equal(res.status, 422, JSON.stringify(json));
    assert.equal(json.error.code, 'image_url_unsupported');
    assert.equal(json.error.details.field, 'logo');
  });
}
