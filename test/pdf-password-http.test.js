'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { req, account, serverUp, BASE } = require('./helpers');
const H = require('./helpers/docx-fixtures');
const PX = require('./helpers/pptx-fixtures');
const XX = require('./helpers/xlsx-fixtures');
const { isPdf, hasEncrypt, assertQpdfProtected, assertPdfTextContains, qpdfAvailable, qpdfRequiresPassword, fakeServer } = require('./helpers/pdf-probe');
const { readZip } = require('../src/ooxml/zip');

/**
 * AT-P1..P5 and AT-P9 over HTTP: pdf_password end to end against a running
 * server. Needs TEST_BASE_URL; skips when there is none, like
 * codes-http.test.js. The qpdf assertions run only when qpdf is on the
 * machine that runs the suite (it is in the Docker build, not on every
 * workstation), and the text-extraction assertion only when python3 with
 * pypdf is; when neither tool is installed the password-opening assertions
 * skip cleanly and the tool-free /Encrypt trailer check still stands. Against
 * a server running the committed fake soffice (DOCMINT_FAKE_CTRL set, see
 * test/helpers/fake-soffice.sh) the trailer check is what stands; the deep
 * real-encryption assertions are for the real LibreOffice runs.
 */
const PW = 's3cret-Ä1';

let up = null;
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

const FORMATS = [
  {
    id: 'docx',
    template: () => H.fixture('invoice'),
    data: () => H.invoiceData(),
    zipPart: '[Content_Types].xml',
    // AT-P1's filled value: invoice_no, a value only the fill could have put
    // into the document, asserted in the decrypted text layer with pypdf.
    textNeedle: 'INV-2026-0042',
  },
  {
    id: 'xlsx',
    template: () => XX.fixture('invoice.xlsx'),
    data: () => ({
      invoice: { number: 'INV-2026-0007', date: '2026-02-14' },
      customer: { name: 'Acme GmbH' },
      user: { name: 'Flo' },
      items: [
        { description: 'Consulting', qty: 10, price: 150, note: 'On site' },
        { description: 'Licence', qty: 2, price: 99.5, note: 'Annual' },
      ],
    }),
    zipPart: 'xl/workbook.xml',
  },
  {
    id: 'pptx',
    template: () => PX.fixture('report'),
    data: () => ({
      title: 'Q3 Review',
      subtitle: 'Quarterly numbers',
      client: { name: 'Acme GmbH' },
      notes: 'Open with the churn number.',
      rows: [{ sku: 'A-1', qty: 2, amount: 150 }],
      findings: [{ label: 'Churn', detail: 'down 2pt', owner: 'Ada' }],
      logo: H.PNG_8x4,
    }),
    zipPart: 'ppt/presentation.xml',
  },
];

/* ------------------------------------------------- AT-P1/AT-P2: encrypted */

for (const f of FORMATS) {
  when(`AT-P1 ${f.id}: output pdf with pdf_password comes back encrypted`, async (t) => {
    const { key } = await account();
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      headers: { Accept: 'application/json' },
      body: { template_base64: f.template().toString('base64'), data: f.data(), output: 'pdf', pdf_password: PW },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    const pdf = Buffer.from(json.pdf.base64, 'base64');
    assert.ok(isPdf(pdf), 'no PDF came back');
    assert.ok(hasEncrypt(pdf), 'the PDF trailer has no /Encrypt entry');
    assertQpdfProtected(t, pdf, PW);
    if (f.textNeedle) assertPdfTextContains(t, pdf, PW, f.textNeedle);
  });

  when(`AT-P2 ${f.id}: output both encrypts the PDF part and leaves the Office part a valid zip`, async (t) => {
    const { key } = await account();
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      headers: { Accept: 'application/json' },
      body: { template_base64: f.template().toString('base64'), data: f.data(), output: 'both', pdf_password: PW },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    const pdf = Buffer.from(json.pdf.base64, 'base64');
    assert.ok(isPdf(pdf), 'no PDF came back');
    assert.ok(hasEncrypt(pdf), 'the PDF part of "both" has no /Encrypt entry');
    assertQpdfProtected(t, pdf, PW);
    const doc = Buffer.from(json.document.base64, 'base64');
    const zip = readZip(doc);
    assert.ok(zip.byName.has(f.zipPart), `the Office part is not a readable ${f.id} package`);
  });
}

/* --------------------------------------------------- AT-P3: regression */

for (const f of FORMATS) {
  when(`AT-P3 ${f.id}: without pdf_password the PDF has no /Encrypt`, async () => {
    const { key } = await account();
    const { res, json } = await req('/v1/render', {
      method: 'POST', key,
      headers: { Accept: 'application/json' },
      body: { template_base64: f.template().toString('base64'), data: f.data(), output: 'pdf' },
    });
    assert.equal(res.status, 200, JSON.stringify(json));
    const pdf = Buffer.from(json.pdf.base64, 'base64');
    assert.ok(isPdf(pdf), 'no PDF came back');
    assert.ok(!hasEncrypt(pdf), 'the PDF is encrypted although no password was sent');
    if (!fakeServer() && qpdfAvailable()) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docmint-pw-'));
      try {
        const file = path.join(dir, 'doc.pdf');
        fs.writeFileSync(file, pdf);
        assert.equal(qpdfRequiresPassword(file), 2, 'qpdf says the unprotected file needs a password');
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });
}

/* ------------------------------- AT-P9: the password survives punctuation */

// Colon, double quote, backslash, brace and non-ASCII — exactly the
// characters that would break a naive --convert-to option parser. The JSON
// filter options are argv, not a command line, so the password must round-trip
// unchanged: the file opens with exactly this password and with no other.
const TRICKY = 'a:b"c\\d{Ä}';

when('AT-P9 a password with : " \\ { and non-ASCII opens the PDF with exactly that password', async (t) => {
  const { key } = await account();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: { template_base64: H.fixture('invoice').toString('base64'), data: H.invoiceData(), output: 'pdf', pdf_password: TRICKY },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  const pdf = Buffer.from(json.pdf.base64, 'base64');
  assert.ok(isPdf(pdf), 'no PDF came back');
  assert.ok(hasEncrypt(pdf), 'the PDF trailer has no /Encrypt entry');
  assertQpdfProtected(t, pdf, TRICKY);
});

/* --------------------------------------------- AT-P4: validation over HTTP */

const VALID_BODY = () => ({ template_base64: H.fixture('invoice').toString('base64'), data: H.invoiceData(), output: 'pdf' });

async function expect400(t, pathName, body, code) {
  const { key } = await account();
  const { res, json, text } = await req(pathName, { method: 'POST', key, body });
  assert.equal(res.status, 400, `${pathName} ${code}: ${res.status} ${text}`);
  assert.equal(json?.error?.code, code, `${pathName}: ${JSON.stringify(json?.error)}`);
  assert.ok(!text.includes(PW), `${pathName}: the password appears in the error response`);
}

when('AT-P4 bad pdf_password values are 400 bad_pdf_password over HTTP', async (t) => {
  for (const [what, value] of [
    ['empty string', ''],
    ['129 characters', 'x'.repeat(129)],
    ['a number', 42],
    ['a control character', 'a\u0000b'],
  ]) {
    // eslint-disable-next-line no-await-in-loop
    await expect400(t, '/v1/render', { ...VALID_BODY(), pdf_password: value }, 'bad_pdf_password');
  }
});

when('AT-P4 pdf_password with output document (or unset) is 400 pdf_password_needs_pdf', async (t) => {
  await expect400(t, '/v1/render', { ...VALID_BODY(), output: 'document', pdf_password: PW }, 'pdf_password_needs_pdf');
  const body = VALID_BODY();
  delete body.output;
  // eslint-disable-next-line no-await-in-loop
  await expect400(t, '/v1/render', { ...body, pdf_password: PW }, 'pdf_password_needs_pdf');
});

when('AT-P4 pdf_password inside a batch item is an unknown field, and the top-level field validates on both bulk endpoints', async (t) => {
  const template = H.fixture('invoice').toString('base64');
  // Per-item: still an unknown field, so one call carries exactly one password.
  {
    const { key } = await account();
    const { res, json } = await req('/v1/render/batch', {
      method: 'POST', key,
      body: { template_base64: template, output: 'pdf', items: [{ data: H.invoiceData(), pdf_password: PW }] },
    });
    assert.equal(res.status, 400, JSON.stringify(json));
    assert.equal(json?.error?.code, 'unknown_field');
    assert.equal(json?.error?.details?.item, 0, 'the error does not say which item sent the field');
    assert.ok(!JSON.stringify(json).includes(PW), 'the password appears in the error response');
  }
  // The same validation errors as render, on both bulk endpoints.
  await expect400(t, '/v1/render/batch', { template_base64: template, output: 'pdf', items: [{ data: H.invoiceData() }], pdf_password: '' }, 'bad_pdf_password');
  await expect400(t, '/v1/render/batch', { template_base64: template, items: [{ data: H.invoiceData() }], pdf_password: PW }, 'pdf_password_needs_pdf');
  await expect400(t, '/v1/jobs', { template_base64: template, data: H.invoiceData(), output: 'pdf', pdf_password: '' }, 'bad_pdf_password');
  await expect400(t, '/v1/jobs', { template_base64: template, data: H.invoiceData(), pdf_password: PW }, 'pdf_password_needs_pdf');
  await expect400(t, '/v1/jobs', { template_base64: template, items: [{ data: H.invoiceData() }], output: 'pdf', pdf_password: 'x'.repeat(129) }, 'bad_pdf_password');
});

/* ------------------------------------- AT-P4: refused requests cost nothing */

async function balance(key) {
  const { res, json } = await req('/v1/usage', { key });
  assert.equal(res.status, 200, 'GET /v1/usage failed');
  assert.ok(json?.credits, 'usage response has no credits');
  return { used: json.credits.used, remaining: json.credits.remaining };
}

when('AT-P4 a refused render does not reduce the credit balance', async () => {
  const { key } = await account();
  const before = await balance(key);
  await expect400(null, '/v1/render', { ...VALID_BODY(), pdf_password: '' }, 'bad_pdf_password');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'a refused render charged a credit');
  assert.equal(after.remaining, before.remaining, 'a refused render reduced the balance');
});

when('AT-P4 a refused batch does not reduce the credit balance', async () => {
  const { key } = await account();
  const before = await balance(key);
  await expect400(null, '/v1/render/batch',
    { template_base64: H.fixture('invoice').toString('base64'), output: 'pdf', items: [{ data: H.invoiceData() }], pdf_password: '' },
    'bad_pdf_password');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'a refused batch charged a credit');
  assert.equal(after.remaining, before.remaining, 'a refused batch reduced the balance');
});

when('AT-P4 a refused job does not reduce the credit balance', async () => {
  const { key } = await account();
  const before = await balance(key);
  // No "output" means the default "document", so the password is refused.
  await expect400(null, '/v1/jobs',
    { template_base64: H.fixture('invoice').toString('base64'), data: H.invoiceData(), pdf_password: PW },
    'pdf_password_needs_pdf');
  const after = await balance(key);
  assert.equal(after.used, before.used, 'a refused job charged a credit');
  assert.equal(after.remaining, before.remaining, 'a refused job reduced the balance');
});
