'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const { req, account, b64, serverUp, BASE } = require('./helpers');
const H = require('./helpers/docx-fixtures');
const { isPdf, hasEncrypt, assertQpdfProtected } = require('./helpers/pdf-probe');
const { readZip, readEntry } = require('../src/ooxml/zip');

/**
 * pdf_password on POST /v1/render/batch and POST /v1/jobs over HTTP: the
 * AT-B-LIVE rehearsal. Needs a running server (TEST_BASE_URL); skips when
 * there is none, like batch-jobs.test.js. The deep "opens with exactly this
 * password" assertions run only against a real LibreOffice server with qpdf
 * installed; against a server running the committed fake soffice
 * (DOCMINT_FAKE_CTRL set, see test/helpers/fake-soffice.sh — which also arms
 * the AT-B-P6 failure-path tests) the tool-free /Encrypt trailer check is
 * what stands. Never pointed at production: the live run belongs to the
 * supervisor's acceptance, after deploy.
 */
const PW = 's3cret-Ä1';

const TEMPLATE = () => b64('invoice.docx');

function invoiceData(no = 'INV-BJ-1') {
  const d = H.invoiceData();
  return { ...d, invoice_no: no };
}

let up = null;
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

/* ------------------------------------------------------------------- zip */

/** Entry names of a downloaded zip, without a dependency. */
function zipEntries(buffer) {
  return readZip(buffer).entries.map((e) => e.name);
}

const entryBytes = (buffer, name) => readEntry(readZip(buffer).byName.get(name));

/* ------------------------------------------------------- AT-B-P1: batch */

when('AT-B-P1 a batch with pdf_password returns a zip whose every PDF carries /Encrypt', async (t) => {
  const { key } = await account();
  const { res, buffer, json } = await req('/v1/render/batch', {
    method: 'POST', key, raw: true,
    body: {
      template_base64: TEMPLATE(), output: 'pdf', response: 'zip', pdf_password: PW,
      items: [
        { data: invoiceData('B1'), filename: 'inv-{invoice_no}' },
        { data: invoiceData('B2'), filename: 'inv-{invoice_no}' },
      ],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  const names = zipEntries(buffer);
  const pdfs = names.filter((n) => n.endsWith('.pdf'));
  assert.equal(pdfs.length, 2, `expected both items as PDFs, got ${names.join(', ')}`);
  for (const name of pdfs) {
    const pdf = entryBytes(buffer, name);
    assert.ok(isPdf(pdf), `${name} is not a PDF`);
    assert.ok(hasEncrypt(pdf), `${name} has no /Encrypt entry`);
    assertQpdfProtected(t, pdf, PW);
  }
});

when('AT-B-P1 a batch with pdf_password returns every PDF encrypted in the JSON response too', async (t) => {
  const { key } = await account();
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: {
      template_base64: TEMPLATE(), output: 'pdf', pdf_password: PW,
      items: [{ data: invoiceData('B3') }, { data: invoiceData('B4') }],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.ok, 2);
  assert.equal(json.failed, 0);
  for (const item of json.results) {
    const pdf = Buffer.from(item.pdf.base64, 'base64');
    assert.ok(isPdf(pdf), `item ${item.index} is not a PDF`);
    assert.ok(hasEncrypt(pdf), `item ${item.index} has no /Encrypt entry`);
    assertQpdfProtected(t, pdf, PW);
  }
});

/* -------------------------------------------------------- AT-B-P2: jobs */

/** Polls a job to a terminal state, or gives up with what it last saw. */
async function settle(id, key, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await req(`/v1/jobs/${id}`, { key });
    last = json;
    if (['succeeded', 'failed', 'cancelled'].includes(json.status)) return json;
    await new Promise((r) => { setTimeout(r, 1500); });
  }
  return last;
}

when('AT-B-P2 a job with pdf_password completes, its download is encrypted, and no job body ever carries the password', async (t) => {
  const { key } = await account();
  const submit = await req('/v1/jobs', {
    method: 'POST', key,
    body: { template_base64: TEMPLATE(), data: invoiceData('JOB-PW'), output: 'pdf', pdf_password: PW },
  });
  assert.equal(submit.res.status, 202, JSON.stringify(submit.json));
  assert.ok(!JSON.stringify(submit.json).includes(PW), 'the 202 body carries the password');

  const done = await settle(submit.json.id, key);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error || done));

  // The status body, the list and the polled bodies: none may echo the password.
  const listed = await req('/v1/jobs?limit=100', { key });
  assert.equal(listed.res.status, 200);
  for (const body of [done, listed.json]) {
    assert.ok(!JSON.stringify(body).includes(PW), 'a job response body carries the password');
  }

  const file = done.result.files[0];
  assert.equal(file.content_type, 'application/pdf');
  const { res: dl, buffer } = await req(file.url.replace(BASE, ''), { raw: true });
  assert.equal(dl.status, 200);
  assert.ok(isPdf(buffer), 'the job result is not a PDF');
  assert.ok(hasEncrypt(buffer), 'the job result has no /Encrypt entry');
  assertQpdfProtected(t, buffer, PW);
});

/* ---------------------------------------------------- AT-B-P3: regression */

when('AT-B-P3 without pdf_password the batch and job PDFs stay unencrypted', async (t) => {
  const { key } = await account();
  const { res, buffer, json } = await req('/v1/render/batch', {
    method: 'POST', key, raw: true,
    body: {
      template_base64: TEMPLATE(), output: 'pdf', response: 'zip',
      items: [{ data: invoiceData('P1') }, { data: invoiceData('P2') }],
    },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  for (const name of zipEntries(buffer).filter((n) => n.endsWith('.pdf'))) {
    assert.ok(!hasEncrypt(entryBytes(buffer, name)), `${name} is encrypted although no password was sent`);
  }

  const job = await req('/v1/jobs', {
    method: 'POST', key,
    body: { template_base64: TEMPLATE(), data: invoiceData('JOB-PLAIN'), output: 'pdf' },
  });
  assert.equal(job.res.status, 202);
  const done = await settle(job.json.id, key);
  assert.equal(done.status, 'succeeded', JSON.stringify(done.error || done));
  const { res: dl, buffer: pdf } = await req(done.result.files[0].url.replace(BASE, ''), { raw: true });
  assert.equal(dl.status, 200);
  assert.ok(isPdf(pdf), 'the plain job result is not a PDF');
  assert.ok(!hasEncrypt(pdf), 'the plain job result is encrypted although no password was sent');
});

/* -------------------------------------------------- AT-B-P4: validation */

async function expect400(t, pathName, body, code) {
  const { key } = await account();
  const { res, json, text } = await req(pathName, { method: 'POST', key, body });
  assert.equal(res.status, 400, `${pathName} ${code}: ${res.status} ${text}`);
  assert.equal(json?.error?.code, code, `${pathName}: ${JSON.stringify(json?.error)}`);
  assert.ok(!text.includes(PW), `${pathName}: the password appears in the error response`);
}

const BATCH_BODY = () => ({
  template_base64: TEMPLATE(), output: 'pdf', items: [{ data: invoiceData('V1') }],
});
const JOB_BODY = () => ({ template_base64: TEMPLATE(), data: invoiceData('V2'), output: 'pdf' });

when('AT-B-P4 bad pdf_password values are 400 bad_pdf_password on both bulk endpoints', async (t) => {
  for (const [pathName, body] of [['/v1/render/batch', BATCH_BODY], ['/v1/jobs', JOB_BODY]]) {
    for (const [what, value] of [
      ['empty string', ''],
      ['129 characters', 'x'.repeat(129)],
      ['a number', 42],
      ['a control character', 'a\u0000b'],
    ]) {
      // eslint-disable-next-line no-await-in-loop
      await expect400(t, pathName, { ...body(), pdf_password: value }, 'bad_pdf_password');
    }
  }
});

when('AT-B-P4 pdf_password without a PDF output is 400 pdf_password_needs_pdf on both bulk endpoints', async (t) => {
  const batchBody = BATCH_BODY();
  delete batchBody.output; // the default is "document"
  await expect400(t, '/v1/render/batch', { ...batchBody, pdf_password: PW }, 'pdf_password_needs_pdf');
  const jobBody = JOB_BODY();
  delete jobBody.output;
  await expect400(t, '/v1/jobs', { ...jobBody, pdf_password: PW }, 'pdf_password_needs_pdf');
});

when('AT-B-P4 a per-item pdf_password stays an unknown field on both bulk endpoints', async (t) => {
  {
    const { key } = await account();
    const { res, json } = await req('/v1/render/batch', {
      method: 'POST', key,
      body: { ...BATCH_BODY(), items: [{ data: invoiceData('V3'), pdf_password: PW }] },
    });
    assert.equal(res.status, 400);
    assert.equal(json?.error?.code, 'unknown_field');
    assert.equal(json?.error?.details?.item, 0);
    assert.ok(!JSON.stringify(json).includes(PW), 'the password appears in the error response');
  }
  await expect400(t, '/v1/jobs',
    { template_base64: TEMPLATE(), output: 'pdf', items: [{ data: invoiceData('V4'), pdf_password: PW }] },
    'unknown_field');
});

/* ------------------------------- AT-B-P5: refused requests cost nothing */

async function balance(key) {
  const { res, json } = await req('/v1/usage', { key });
  assert.equal(res.status, 200, 'GET /v1/usage failed');
  assert.ok(json?.credits, 'usage response has no credits');
  return { used: json.credits.used, remaining: json.credits.remaining };
}

when('AT-B-P5 refused batch and job requests do not reduce the credit balance', async () => {
  const { key } = await account();
  const before = await balance(key);
  await expect400(null, '/v1/render/batch', { ...BATCH_BODY(), pdf_password: '' }, 'bad_pdf_password');
  await expect400(null, '/v1/jobs', { ...JOB_BODY(), pdf_password: 42 }, 'bad_pdf_password');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'a refused bulk request charged credits');
  assert.equal(after.remaining, before.remaining, 'a refused bulk request reduced the balance');
});

/* ----------------- AT-B-P6: the fail-closed 502 path, with a fake soffice */

/**
 * These are the carried change-review items: the 502 pdf_encryption_failed
 * refund path at HTTP level. They need a disposable server running the
 * committed fake soffice (test/helpers/fake-soffice.sh) with a shared
 * control file, e.g.:
 *
 *   DOCMINT_FAKE_CTRL=/tmp/docmint-fake-ctrl \
 *   SOFFICE_BIN="$PWD/test/helpers/fake-soffice.sh" \
 *   DATABASE_URL=... PORT=3100 node src/server.js
 *
 * and the suite run with the same DOCMINT_FAKE_CTRL. Without that env the
 * tests skip; against a real server the probe refuses to inject anything.
 */
const FAKE_CTRL = process.env.DOCMINT_FAKE_CTRL || null;
const setFakeMode = (mode) => { if (FAKE_CTRL) fs.writeFileSync(FAKE_CTRL, `${mode}\n`); };

let fakeVerified = null;

/** One cheap conversion that must fail under the fake, succeed on a real server. */
async function serverRunsFake(key) {
  if (fakeVerified !== null) return fakeVerified;
  if (!FAKE_CTRL) { fakeVerified = false; return false; }
  setFakeMode('noencrypt');
  const { res } = await req('/v1/render', {
    method: 'POST', key,
    body: { template_base64: TEMPLATE(), data: invoiceData('PROBE'), output: 'pdf', pdf_password: PW },
  });
  fakeVerified = res.status === 502;
  setFakeMode('ok');
  return fakeVerified;
}

when('AT-B-P6 a render whose encryption is not verifiable answers 502 pdf_encryption_failed and refunds the credit', async (t) => {
  const { key } = await account();
  if (!(await serverRunsFake(key))) { t.skip('needs the disposable fake-soffice server (DOCMINT_FAKE_CTRL, see the file header)'); return; }
  const before = await balance(key);
  setFakeMode('noencrypt');
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    body: { template_base64: TEMPLATE(), data: invoiceData('E1'), output: 'pdf', pdf_password: PW },
  });
  assert.equal(res.status, 502, JSON.stringify(json));
  assert.equal(json?.error?.code, 'pdf_encryption_failed');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'the failed encryption charged a credit');
  assert.equal(after.remaining, before.remaining, 'the failed encryption reduced the balance');
});

when('AT-B-P6 a protected batch whose encryption fails is refused whole with on_error fail and charges nothing', async (t) => {
  const { key } = await account();
  if (!(await serverRunsFake(key))) { t.skip('needs the disposable fake-soffice server (DOCMINT_FAKE_CTRL, see the file header)'); return; }
  const before = await balance(key);
  setFakeMode('noencrypt');
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST', key,
    body: { ...BATCH_BODY(), items: [{ data: invoiceData('E2') }, { data: invoiceData('E3') }], pdf_password: PW },
  });
  assert.equal(res.status, 502, JSON.stringify(json));
  assert.equal(json?.error?.code, 'pdf_encryption_failed');
  assert.ok(json?.error?.details?.item !== undefined, 'the failing item is not named');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'the failed batch charged credits');
  assert.equal(after.remaining, before.remaining, 'the failed batch reduced the balance');
});

when('AT-B-P6 with on_error continue the failing item is an error entry, no file is delivered, and nothing is charged', async (t) => {
  const { key } = await account();
  if (!(await serverRunsFake(key))) { t.skip('needs the disposable fake-soffice server (DOCMINT_FAKE_CTRL, see the file header)'); return; }
  const before = await balance(key);
  setFakeMode('noencrypt');
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST', key,
    body: {
      template_base64: TEMPLATE(), output: 'pdf', on_error: 'continue', pdf_password: PW,
      items: [{ data: invoiceData('E4') }, { data: invoiceData('E5') }],
    },
  });
  setFakeMode('ok');
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.ok, 0);
  assert.equal(json.failed, 2);
  for (const item of json.results) {
    assert.equal(item.ok, false);
    assert.equal(item.error.code, 'pdf_encryption_failed');
    assert.equal(item.pdf, undefined, 'an unencrypted file came back as a result entry');
    assert.equal(item.document, undefined, 'a document came back from a failed protected item');
  }
  assert.equal(json.credits.used, 0, 'items whose encryption failed were charged');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'the all-failed batch changed the balance');
});
