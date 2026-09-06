'use strict';

/**
 * /v1/render/batch and /v1/jobs over HTTP, against a running server.
 *
 * These two endpoints are the whole of the bulk product and, until 2026-09-06,
 * had no test of any kind: every row here was first executed by hand against the
 * deployed image, and is written down so it does not have to be again. As with
 * api.test.js, they skip rather than fail when there is no server, and the PDF
 * rows skip when the build has no LibreOffice, because a red suite that only
 * means "your machine is missing something" trains people to ignore red suites.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const { req, account, b64, serverUp, BASE } = require('./helpers');

let up = null;
let pdfAvailable = null;

const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

async function hasPdf() {
  if (pdfAvailable === null) {
    const { json } = await req('/v1/capabilities');
    pdfAvailable = Boolean(json?.pdf?.available);
  }
  return pdfAvailable;
}

/** The committed invoice fixture, and data that renders it cleanly. */
const TEMPLATE = () => b64('invoice.docx');

function invoiceData(no = 'INV-BATCH-1') {
  const items = [
    { description: 'Consulting, senior rate', qty: 10, unit_price: 150 },
    { description: 'Design sprint', qty: 2, unit_price: 1200 },
  ].map((i) => ({ ...i, line_total: Math.round(i.qty * i.unit_price * 100) / 100 }));
  return {
    invoice_no: no,
    company: 'DocMint GmbH',
    issued: '2026-03-14',
    customer: { name: 'Acme Corporation', address: '12 Example Street' },
    items,
    paid: false,
    terms_days: 14,
    notes: ['Bank transfer only.'],
    logo: null,
  };
}

const creditsUsed = async (key) => (await req('/v1/usage', { key })).json.credits.used;

/** Entry names of a zip, read without a dependency: the central directory is enough. */
function zipEntries(buffer) {
  const names = [];
  for (let i = 0; i < buffer.length - 4; i += 1) {
    if (buffer.readUInt32LE(i) === 0x02014b50) {
      const n = buffer.readUInt16LE(i + 28);
      names.push(buffer.subarray(i + 46, i + 46 + n).toString('utf8'));
    }
  }
  return names;
}

/** The bytes of one entry, inflated. Enough to read errors.json back out. */
function zipRead(buffer, name) {
  for (let i = 0; i < buffer.length - 4; i += 1) {
    if (buffer.readUInt32LE(i) === 0x02014b50) {
      const nlen = buffer.readUInt16LE(i + 28);
      const entry = buffer.subarray(i + 46, i + 46 + nlen).toString('utf8');
      if (entry !== name) continue;
      const method = buffer.readUInt16LE(i + 10);
      const size = buffer.readUInt32LE(i + 20);
      const at = buffer.readUInt32LE(i + 42);
      const lnlen = buffer.readUInt16LE(at + 26);
      const lxlen = buffer.readUInt16LE(at + 28);
      const data = buffer.subarray(at + 30 + lnlen + lxlen, at + 30 + lnlen + lxlen + size);
      return method === 0 ? data : zlib.inflateRawSync(data);
    }
  }
  throw new Error(`no entry ${name}`);
}

/* ------------------------------------------------------------------- batch */

when('a batch renders one document per item and charges one credit each', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'document',
      items: [{ data: invoiceData('A') }, { data: invoiceData('B') }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(json.ok, 2);
  assert.equal(json.failed, 0);
  assert.equal(json.credits.used, 2);
  assert.equal(json.credits.refunded, 0);
  assert.equal(await creditsUsed(key) - before, 2);
  assert.equal(res.headers.get('x-docmint-batch-ok'), '2');

  // Every item is its own document, not the first one twice.
  const a = Buffer.from(json.results[0].document.base64, 'base64');
  const b = Buffer.from(json.results[1].document.base64, 'base64');
  assert.equal(a.subarray(0, 2).toString(), 'PK');
  assert.notEqual(a.toString('base64'), b.toString('base64'));
});

when('a batch item that cannot render is refused before anything is charged', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'document',
      on_error: 'fail',
      items: [{ data: invoiceData('A') }, { data: {} }],
    },
  });
  assert.equal(res.status, 422);
  assert.equal(json.error.details.item, 1, 'the failing item is named');
  assert.equal(await creditsUsed(key), before, 'nothing was charged for the item that did render');
});

when('on_error "continue" charges for the items that produced a document and refunds the rest', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'document',
      on_error: 'continue',
      items: [{ data: invoiceData('A') }, { data: {} }, { data: invoiceData('C') }],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(json.ok, 2);
  assert.equal(json.failed, 1);
  assert.deepEqual(
    { used: json.credits.used, refunded: json.credits.refunded },
    { used: 2, refunded: 1 },
  );
  assert.equal(await creditsUsed(key) - before, 2);
  assert.equal(json.results[1].ok, false);
  assert.ok(json.results[1].error.code, 'the failed item carries its own error');
});

when('a zip response names every file and says which items failed', async () => {
  const { key } = await account();
  const { res, buffer } = await req('/v1/render/batch', {
    method: 'POST',
    key,
    raw: true,
    body: {
      template_base64: TEMPLATE(),
      output: 'document',
      response: 'zip',
      on_error: 'continue',
      items: [
        { data: invoiceData('A'), filename: 'inv-{invoice_no}' },
        { data: invoiceData('A'), filename: 'inv-{invoice_no}' },
        { data: {} },
      ],
    },
  });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/zip');
  const names = zipEntries(buffer);
  // Two items resolve to the same filename; both must survive.
  assert.deepEqual(names, ['inv-A.docx', 'inv-A-2.docx', 'errors.json']);
  const errors = JSON.parse(zipRead(buffer, 'errors.json').toString());
  assert.equal(errors.failed, 1);
  assert.equal(errors.items[0].index, 2);
});

when('a batch bigger than the quota is refused whole, with the number that would have fitted', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  const { json: usage } = await req('/v1/usage', { key });
  const tooMany = usage.credits.remaining + 5;
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'document',
      items: Array.from({ length: tooMany }, () => ({ data: invoiceData() })),
    },
  });
  assert.equal(res.status, 402);
  assert.equal(json.error.code, 'batch_exceeds_quota');
  assert.equal(json.error.details.affordable_items, usage.credits.remaining);
  assert.equal(await creditsUsed(key), before, 'a refused batch renders nothing and charges nothing');
});

when('a synchronous PDF batch beyond the limit points at the endpoint that does fit', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/render/batch', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'pdf',
      items: Array.from({ length: 21 }, () => ({ data: invoiceData() })),
    },
  });
  assert.equal(res.status, 413);
  assert.equal(json.error.code, 'batch_pdf_too_large');
  assert.match(json.error.hint, /\/v1\/jobs/);
});

/* -------------------------------------------------------------------- jobs */

/** Polls a job to a terminal state, or gives up with what it last saw. */
async function settle(id, key, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const { json } = await req(`/v1/jobs/${id}`, { key });
    last = json;
    if (['succeeded', 'failed', 'cancelled'].includes(json.status)) return json;
    await new Promise((r) => { setTimeout(r, 750); });
  }
  return last;
}

when('a job renders in the background and hands back a downloadable file', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  const { res, json } = await req('/v1/jobs', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      data: invoiceData('JOB-1'),
      output: 'document',
      filename: 'job-{invoice_no}',
    },
  });
  assert.equal(res.status, 202);
  assert.equal(json.kind, 'render');
  assert.equal(json.credits.reserved, 1);
  assert.equal(json.status_url, `${BASE}/v1/jobs/${json.id}`);

  const done = await settle(json.id, key);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.result.ok, 1);
  assert.deepEqual(done.result.credits, { used: 1, refunded: 0 });
  assert.equal(await creditsUsed(key) - before, 1);

  const file = done.result.files[0];
  assert.equal(file.filename, 'job-JOB-1.docx');
  // The URL is the capability: it carries no API key and needs none.
  const { res: dl, buffer } = await req(file.url.replace(BASE, ''), { raw: true });
  assert.equal(dl.status, 200);
  assert.equal(buffer.length, file.size);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  // And the work is recorded where the usage breakdown can see it.
  const { json: usage } = await req('/v1/usage', { key });
  assert.ok(usage.breakdown.some((r) => r.kind === 'job' && r.credits >= 1),
    'an asynchronous job must appear in usage_events, not only in the balance');
});

when('a batch job returns one archive holding every document it produced', async (t) => {
  if (!(await hasPdf())) { t.skip('this build has no LibreOffice'); return; }
  const { key } = await account();
  const before = await creditsUsed(key);
  const { res, json } = await req('/v1/jobs', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'both',
      items: [{ data: invoiceData('Z1') }, { data: invoiceData('Z2') }],
    },
  });
  assert.equal(res.status, 202);
  assert.equal(json.kind, 'batch');
  assert.equal(json.credits.reserved, 4, 'a PDF costs one credit more than the document');

  const done = await settle(json.id, key, 240000);
  assert.equal(done.status, 'succeeded');
  assert.equal(await creditsUsed(key) - before, 4);
  const file = done.result.files[0];
  assert.equal(file.content_type, 'application/zip');
  const { buffer } = await req(file.url.replace(BASE, ''), { raw: true });
  const names = zipEntries(buffer);
  assert.equal(names.filter((n) => n.endsWith('.pdf')).length, 2);
  assert.equal(names.filter((n) => n.endsWith('.docx')).length, 2);
  // The base64 of every document is deliberately NOT in the job result.
  assert.ok(!JSON.stringify(done.result.items).includes('base64'));
});

when('a job that fails is charged nothing and says why', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  const { res, json } = await req('/v1/jobs', {
    method: 'POST',
    key,
    body: {
      template_base64: TEMPLATE(),
      output: 'document',
      on_error: 'fail',
      items: [{ data: invoiceData('OK') }, { data: {} }],
    },
  });
  assert.equal(res.status, 202);
  const done = await settle(json.id, key);
  assert.equal(done.status, 'failed');
  assert.ok(done.error.code);
  assert.equal(await creditsUsed(key), before, 'a failed job gives every reserved credit back');
});

when('a queued job can be cancelled and its whole reservation released', async () => {
  const { key } = await account();
  const before = await creditsUsed(key);
  // Two jobs: the first occupies the single worker, the second is still queued.
  const first = await req('/v1/jobs', {
    method: 'POST',
    key,
    body: { template_base64: TEMPLATE(), output: 'document', items: Array.from({ length: 20 }, (_, i) => ({ data: invoiceData(`Q${i}`) })) },
  });
  const second = await req('/v1/jobs', {
    method: 'POST',
    key,
    body: { template_base64: TEMPLATE(), output: 'document', items: [{ data: invoiceData('C1') }, { data: invoiceData('C2') }] },
  });
  assert.equal(second.res.status, 202);
  const { res: cancelRes, json: cancelled } = await req(`/v1/jobs/${second.json.id}/cancel`, { method: 'POST', key });

  if (cancelRes.status === 409) {
    // The worker got to it first; that is a valid outcome, not a failure.
    assert.equal(cancelled.error.code, 'job_already_finished');
  } else {
    assert.equal(cancelRes.status, 200);
    assert.equal(cancelled.status, 'cancelled');
    const done = await settle(second.json.id, key);
    assert.equal(done.status, 'cancelled');
    assert.equal(done.error.code, 'job_cancelled');
  }

  const firstDone = await settle(first.json.id, key, 240000);
  assert.equal(firstDone.status, 'succeeded');
  // The cancelled job's credits are back; only the first job's 20 are spent.
  assert.equal(await creditsUsed(key) - before, 20);

  const again = await req(`/v1/jobs/${first.json.id}/cancel`, { method: 'POST', key });
  assert.equal(again.res.status, 409, 'a finished job cannot be cancelled');
  const missing = await req('/v1/jobs/job_nothing_here/cancel', { method: 'POST', key });
  assert.equal(missing.res.status, 404);
});

when('a webhook_url that points inside the network is refused', async () => {
  const { key } = await account();
  for (const url of ['http://127.0.0.1:3000/v1/usage', 'http://169.254.169.254/latest/meta-data/', 'file:///etc/passwd']) {
    const { res, json } = await req('/v1/jobs', {
      method: 'POST',
      key,
      body: { template_base64: TEMPLATE(), data: invoiceData(), webhook_url: url },
    });
    assert.equal(res.status, 400, `${url} should be refused`);
    assert.ok(['private_address_blocked', 'unsupported_url_scheme', 'invalid_url', 'blocked_hostname'].includes(json.error.code),
      `unexpected code ${json.error.code} for ${url}`);
  }
});

when('the signing secret is published so a receiver can actually verify a webhook', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/webhooks', { key });
  assert.equal(res.status, 200);
  assert.equal(json.algorithm, 'HMAC-SHA256');
  assert.equal(json.signed_value, '{X-DocMint-Timestamp}.{raw request body}');
  assert.ok(json.signing_secret && json.signing_secret.length >= 32);
});

when('a job body cannot be both a batch and a single document', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/jobs', {
    method: 'POST',
    key,
    body: { template_base64: TEMPLATE(), items: [{ data: invoiceData() }], data: invoiceData() },
  });
  assert.equal(res.status, 400);
  assert.equal(json.error.code, 'items_and_data');
});

when('a job listing summarises its items and never crosses accounts', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/jobs?limit=1', { key });
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(json.jobs));
  if (json.jobs.length && json.jobs[0].result) {
    assert.equal(typeof json.jobs[0].result.items, 'number', 'the listing carries a count, not the item detail');
  }
  const stranger = await req('/v1/jobs/job_belongs_to_nobody', { key });
  assert.equal(stranger.res.status, 404);
  assert.equal(stranger.json.error.code, 'job_not_found');
});
