'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

/**
 * AT-P4/AT-P6 (unit half) and AT-P5 (redaction): the pdf_password validator,
 * the soffice argument builder, the capabilities constants and the
 * password-redaction on the conversion failure path — all without a server.
 *
 * The failure-path tests point SOFFICE_BIN at the committed fake soffice
 * (test/helpers/fake-soffice.sh, set before the src modules are required,
 * because src/config.js reads the env at load time). The fake echoes its own
 * argv to stderr and, in "fail" mode, exits non-zero — exactly the leak
 * scenario: a failing LibreOffice can print the argv that carries the
 * password inside the filter options. The same script serves the HTTP suites,
 * where its DOCMINT_FAKE_CTRL file switches a running server between good and
 * failing conversions.
 */

const FAKE_SOFFICE = path.join(__dirname, 'helpers', 'fake-soffice.sh');
process.env.SOFFICE_BIN = FAKE_SOFFICE;

const input = require('../src/input');
const pdf = require('../src/pdf');
const batch = require('../src/batch');
const { pdfPasswordCapability, PDF_PASSWORD_ENCRYPTION } = require('../src/capabilities');

const PW = 's3cret-Ä1';

const errorBlob = (e) => JSON.stringify({ message: e.message, hint: e.hint, details: e.details });

/* ------------------------------------------------------------ the validator */

test('checkPdfPassword accepts valid passwords, including non-ASCII', () => {
  assert.equal(input.checkPdfPassword(PW), PW);
  assert.equal(input.checkPdfPassword('x'), 'x');
  assert.equal(input.checkPdfPassword('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(input.checkPdfPassword('pässwörd-Ü'), 'pässwörd-Ü');
});

test('checkPdfPassword refuses empty, over-long, non-string and control characters', () => {
  const cases = [
    ['', 'empty string'],
    ['x'.repeat(129), '129 characters'],
    [42, 'a number'],
    [null, 'null'],
    [{ pw: PW }, 'an object'],
    ['a\u0000b', 'NUL control character'],
    ['a\u001fb', 'unit separator control character'],
    ['a\u007fb', 'DEL control character'],
  ];
  for (const [value, what] of cases) {
    let threw = null;
    try { input.checkPdfPassword(value); } catch (e) { threw = e; }
    assert.ok(threw, `${what} was not refused`);
    assert.equal(threw.status, 400, `${what}: status`);
    assert.equal(threw.code, 'bad_pdf_password', `${what}: code`);
    assert.equal(threw.docs, '/docs#pdf-password', `${what}: docs anchor`);
    assert.ok(threw.hint, `${what}: hint`);
    // The value is never echoed: a 400 that repeats the password is a leak.
    if (typeof value === 'string' && value.length > 0) {
      assert.ok(!errorBlob(threw).includes(value), `${what}: the password leaked into the error`);
    }
  }
});

test('checkPdfPasswordForOutput refuses the field without a PDF and passes it through otherwise', () => {
  assert.equal(input.checkPdfPasswordForOutput(undefined, 'document'), null);
  assert.equal(input.checkPdfPasswordForOutput(PW, 'pdf'), PW);
  assert.equal(input.checkPdfPasswordForOutput(PW, 'both'), PW);

  let threw = null;
  try { input.checkPdfPasswordForOutput(PW, 'document'); } catch (e) { threw = e; }
  assert.ok(threw, 'pdf_password with output document was not refused');
  assert.equal(threw.status, 400);
  assert.equal(threw.code, 'pdf_password_needs_pdf');
  assert.equal(threw.docs, '/docs#pdf-password');
  assert.ok(!errorBlob(threw).includes(PW), 'the password leaked into the needs_pdf error');
});

test('pdfPasswordUnsupportedHere is gone: no endpoint refuses the field any more', () => {
  assert.equal(input.pdfPasswordUnsupportedHere, undefined);
});

/* ------------------------------------------------------- capabilities parity */

test('the published capability is built from the validator constants', () => {
  const cap = pdfPasswordCapability();
  assert.deepEqual(cap, {
    field: 'pdf_password',
    min_length: 1,
    max_length: 128,
    endpoints: ['/v1/render', '/v1/render/batch', '/v1/jobs'],
    encryption: 'RC4-128 (PDF standard security handler revision 3, as applied by LibreOffice 7.4)',
  });
  assert.equal(cap.field, 'pdf_password');
  assert.equal(cap.min_length, input.PDF_PASSWORD_MIN_LENGTH);
  assert.equal(cap.max_length, input.PDF_PASSWORD_MAX_LENGTH);
  // The measured encryption claim is the one exported constant, pinned verbatim.
  assert.equal(cap.encryption, PDF_PASSWORD_ENCRYPTION);
  // The published limits are the enforced limits, in both directions.
  assert.equal(input.checkPdfPassword('x'.repeat(cap.min_length)), 'x'.repeat(cap.min_length));
  assert.equal(input.checkPdfPassword('x'.repeat(cap.max_length)), 'x'.repeat(cap.max_length));
  assert.throws(() => input.checkPdfPassword(''), (e) => e.code === 'bad_pdf_password');
  assert.throws(() => input.checkPdfPassword('x'.repeat(cap.max_length + 1)), (e) => e.code === 'bad_pdf_password');
});

/* -------------------------------------------------------- the argv builder */

test('exportFilter builds the plain per-format filter without a password', () => {
  assert.equal(pdf.exportFilter('docx'), 'pdf:writer_pdf_Export');
  assert.equal(pdf.exportFilter('xlsx'), 'pdf:calc_pdf_Export');
  assert.equal(pdf.exportFilter('pptx'), 'pdf:impress_pdf_Export');
});

test('exportFilter builds the JSON filter options with a password, for all three filters', () => {
  const filters = [['docx', 'writer_pdf_Export'], ['xlsx', 'calc_pdf_Export'], ['pptx', 'impress_pdf_Export']];
  for (const [format, filter] of filters) {
    const arg = pdf.exportFilter(format, PW);
    const prefix = `pdf:${filter}:`;
    assert.ok(arg.startsWith(prefix), `${format}: wrong filter in ${arg.slice(0, 30)}…`);
    const options = JSON.parse(arg.slice(prefix.length));
    assert.deepEqual(options, {
      EncryptFile: { type: 'boolean', value: 'true' },
      DocumentOpenPassword: { type: 'string', value: PW },
    });
  }
});

test('exportFilter JSON-escapes the password, so quotes and backslashes cannot break the argv', () => {
  for (const tricky of ['a"b', 'back\\slash', 'semi;colon', 'sp ace']) {
    const arg = pdf.exportFilter('docx', tricky);
    const options = JSON.parse(arg.slice('pdf:writer_pdf_Export:'.length));
    assert.equal(options.DocumentOpenPassword.value, tricky);
    assert.equal(options.DocumentOpenPassword.type, 'string');
  }
});

test('redactSecret replaces every occurrence of the secret', () => {
  assert.equal(pdf.redactSecret(`a ${PW} b ${PW}`, PW), 'a [redacted] b [redacted]');
  assert.equal(pdf.redactSecret('no secret here', PW), 'no secret here');
  assert.equal(pdf.redactSecret('', PW), '');
  assert.equal(pdf.redactSecret('x', null), 'x');
});

/* ------------------------------------------- the failure path, end to end */

/** A logger that keeps everything it is told, so a leak is assertable. */
function captureLog() {
  const lines = [];
  const keep = (lvl) => (evt, f) => lines.push({ lvl, evt, f });
  return { lines, log: { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') } };
}

test('AT-P5 a failing soffice that echoes its argv never leaks the password into the error or the log', async () => {
  process.env.DOCMINT_FAKE_MODE = 'fail';
  const { lines, log } = captureLog();
  await assert.rejects(
    () => pdf.toPdf(Buffer.from('not a real docx'), 'docx', { password: PW, log, timeoutMs: 15000 }),
    (e) => {
      assert.equal(e.code, 'pdf_conversion_failed');
      assert.equal(e.status, 502);
      const blob = errorBlob(e);
      assert.ok(!blob.includes(PW), `the password leaked into the error: ${blob}`);
      assert.ok(blob.includes('[redacted]'), 'the redaction marker is missing from the error details');
      return true;
    },
  );
  const logged = JSON.stringify(lines);
  assert.ok(!logged.includes(PW), `the password leaked into the log: ${logged}`);
  assert.ok(logged.includes('[redacted]'), 'the redaction marker is missing from the log');
});

test('a produced PDF without /Encrypt is refused when a password was requested (fail closed)', async () => {
  process.env.DOCMINT_FAKE_MODE = 'noencrypt';
  const { log } = captureLog();
  await assert.rejects(
    () => pdf.toPdf(Buffer.from('not a real docx'), 'docx', { password: PW, log, timeoutMs: 15000 }),
    (e) => {
      assert.equal(e.code, 'pdf_encryption_failed');
      assert.equal(e.status, 502);
      assert.equal(e.docs, '/docs#pdf-password');
      assert.ok(!errorBlob(e).includes(PW), 'the password leaked into the encryption error');
      return true;
    },
  );
});

test('a produced PDF with /Encrypt is returned when a password was requested', async () => {
  process.env.DOCMINT_FAKE_MODE = 'ok';
  const { lines, log } = captureLog();
  const out = await pdf.toPdf(Buffer.from('not a real docx'), 'docx', { password: PW, log, timeoutMs: 15000 });
  assert.ok(out.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(out.buffer.includes(Buffer.from('/Encrypt')));
  // The success log says encryption happened, without saying with what.
  const okLine = lines.find((l) => l.evt === 'pdf.ok');
  assert.ok(okLine, 'no pdf.ok line was logged for the encrypted conversion');
  const ok = JSON.stringify(okLine);
  assert.ok(ok.includes('"encrypted":true'));
  assert.ok(!ok.includes(PW));
});

test('without a password the plain path is unchanged: no /Encrypt is required', async () => {
  process.env.DOCMINT_FAKE_MODE = 'noencrypt';
  const { log } = captureLog();
  const out = await pdf.toPdf(Buffer.from('not a real docx'), 'docx', { log, timeoutMs: 15000 });
  assert.ok(out.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(!out.buffer.includes(Buffer.from('/Encrypt')));
});

/* ------------------------------------- batch: parse-level validation (R1) */

const BATCH_BODY = () => ({ template: 'invoice', items: [{ data: {} }], output: 'pdf' });

test('parseBatch validates a top-level pdf_password with the same rules and codes as render', () => {
  // Absent: nothing to carry. Present and valid: it rides on the spec.
  assert.equal(batch.parseBatch(BATCH_BODY()).pdfPassword, null);
  assert.equal(batch.parseBatch({ ...BATCH_BODY(), pdf_password: PW }).pdfPassword, PW);

  for (const [what, value] of [
    ['empty string', ''],
    ['129 characters', 'x'.repeat(129)],
    ['a number', 42],
    ['null', null],
    ['a control character', 'a\u0000b'],
  ]) {
    let threw = null;
    try { batch.parseBatch({ ...BATCH_BODY(), pdf_password: value }); } catch (e) { threw = e; }
    assert.ok(threw, `${what} was not refused at batch parse`);
    assert.equal(threw.status, 400, `${what}: status`);
    assert.equal(threw.code, 'bad_pdf_password', `${what}: code`);
    assert.equal(threw.docs, '/docs#pdf-password', `${what}: docs anchor`);
    if (typeof value === 'string' && value.length > 0) {
      assert.ok(!errorBlob(threw).includes(value), `${what}: the password leaked into the error`);
    }
  }

  let threw = null;
  try { batch.parseBatch({ template: 'invoice', items: [{ data: {} }], pdf_password: PW }); } catch (e) { threw = e; }
  assert.ok(threw, 'pdf_password with the default document output was not refused');
  assert.equal(threw.status, 400);
  assert.equal(threw.code, 'pdf_password_needs_pdf');
  assert.ok(!errorBlob(threw).includes(PW), 'the password leaked into the needs_pdf error');
});

test('pdf_password inside a batch item is refused as an unknown field, not a password error', () => {
  let threw = null;
  try {
    batch.parseBatch({ ...BATCH_BODY(), items: [{ data: {}, pdf_password: PW }] });
  } catch (e) { threw = e; }
  assert.ok(threw, 'a per-item pdf_password was accepted');
  assert.equal(threw.status, 400);
  assert.equal(threw.code, 'unknown_field', 'the per-item field must stay a plain unknown field');
  assert.equal(threw.details.item, 0, 'the error does not say which item sent it');
  assert.notEqual(threw.code, 'bad_pdf_password');
});

/* ------------------------------------------------ jobs: the in-memory side channel */

/**
 * The submit-side and restart behaviour of the jobs password, driven through
 * the real enqueue and the real worker with only the database replaced (the
 * jobs-accounting pattern). The fake answers exactly the statements the queue
 * issues and keeps a query log, so the INSERT can be asserted on directly.
 */

const dbPath = require.resolve('../src/db');

const jobState = { account: null, jobs: [], files: [], usage: [], sql: [] };
let claimed = false;

const jobSql = async (text, params = []) => {
  const t = text.replace(/\s+/g, ' ');
  jobState.sql.push({ text: t.slice(0, 90), params });
  if (/INSERT INTO jobs/.test(t)) {
    jobState.jobs.push({
      id: params[0], account_id: params[1], kind: params[2], request: JSON.parse(params[3]),
      webhook_url: params[4], credits_reserved: params[5], credits_charged: 0,
      status: 'queued', attempts: 0, result: null, error: null,
    });
    return { rows: [], rowCount: 1 };
  }
  if (/SELECT \* FROM jobs WHERE status = 'queued'/.test(t)) {
    if (claimed) return { rows: [], rowCount: 0 };
    const queued = jobState.jobs.find((j) => j.status === 'queued');
    if (!queued) return { rows: [], rowCount: 0 };
    claimed = true;
    return { rows: [queued], rowCount: 1 };
  }
  if (/UPDATE jobs SET status = 'running'/.test(t)) {
    const j = jobState.jobs.find((x) => x.id === params[0]);
    if (j) j.status = 'running';
    return { rows: [], rowCount: 1 };
  }
  if (/SELECT \* FROM accounts WHERE id/.test(t)) return { rows: [jobState.account], rowCount: 1 };
  if (/SELECT status FROM jobs WHERE id/.test(t)) {
    const j = jobState.jobs.find((x) => x.id === params[0]);
    return { rows: j ? [{ status: j.status }] : [], rowCount: j ? 1 : 0 };
  }
  // Recovery passes must find nothing to do in these tests.
  if (/UPDATE jobs SET status = CASE WHEN attempts/.test(t)) return { rows: [], rowCount: 0 };
  if (/SELECT id, account_id FROM jobs/.test(t)) return { rows: [], rowCount: 0 };
  if (/UPDATE jobs SET status = 'cancelled'/.test(t)) {
    const j = jobState.jobs.find((x) => x.id === params[0]);
    if (j) j.status = 'cancelled';
    return { rows: [{ id: params[0], status: 'cancelled' }], rowCount: 1 };
  }
  if (/UPDATE jobs j SET credits_reserved = 0, credits_charged/.test(t)) {
    const j = jobState.jobs.find((x) => x.id === params[0]);
    const was = j ? j.credits_reserved : 0;
    if (j) { j.credits_reserved = 0; if (was > 0) j.credits_charged = params[1]; }
    return { rows: [{ was }], rowCount: 1 };
  }
  if (/UPDATE accounts SET credits_used = GREATEST/.test(t)) {
    jobState.account.credits_used = Math.max(0, jobState.account.credits_used - params[1]);
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO files/.test(t)) {
    jobState.files.push({ token: params[0], filename: params[2], bytes: params[4], size: params[5] });
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO usage_events/.test(t)) {
    jobState.usage.push({ kind: params[1], output: params[4], credits: params[5], ok: params[8], error_code: params[9] });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE jobs SET status = 'succeeded'/.test(t)) {
    const j = jobState.jobs.find((x) => x.id === params[0]);
    if (j) { j.status = 'succeeded'; j.result = JSON.parse(params[1]); }
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE jobs SET status = 'failed'/.test(t)) {
    const j = jobState.jobs.find((x) => x.id === params[0]);
    if (j) { j.status = 'failed'; j.error = JSON.parse(params[1]); }
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
};

require.cache[dbPath] = {
  id: dbPath, filename: dbPath, loaded: true,
  exports: {
    pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
    query: jobSql,
    tx: async (fn) => fn({ query: jobSql }),
  },
};

const jobs = require('../src/jobs');
const H = require('./helpers/docx-fixtures');
const invoiceData = () => H.invoiceData();
const stubTemplate = async () => ({ buffer: H.fixture('invoice'), template: null, source: 'inline' });

const resetJobs = () => {
  jobState.account = null;
  jobState.jobs = []; jobState.files = []; jobState.usage = []; jobState.sql = [];
  claimed = false;
  jobs.pendingPasswords.clear();
};

/** Drives the real worker until the first job reaches a terminal state. */
async function runWorkerUntilTerminal(timeoutMs = 20000) {
  const stop = jobs.startWorker(stubTemplate);
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const j = jobState.jobs[0];
      if (j && ['succeeded', 'failed', 'cancelled'].includes(j.status)) return j;
      if (Date.now() > deadline) throw new Error('the job never reached a terminal state');
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, 50); });
    }
  } finally { stop(); }
}

test('jobs.enqueue strips the password from the stored request and holds it in the side channel', async () => {
  resetJobs();
  const id = await jobs.enqueue(42, {
    kind: 'render', webhookUrl: null, creditsReserved: 2, pdfPassword: PW,
    request: { template_base64: 'stub', output: 'pdf', pdf_password: PW, items: [{ data: invoiceData() }] },
  });
  const insert = [...jobState.sql].reverse().find((s) => /INSERT INTO jobs/.test(s.text));
  assert.ok(insert, 'no jobs INSERT was issued');
  // The hard constraint: the plaintext never reaches the INSERT, in any column.
  for (const p of insert.params) {
    assert.ok(!(typeof p === 'string' && p.includes(PW)), 'the INSERT carries the plaintext password');
  }
  const stored = JSON.parse(insert.params[3]);
  assert.equal(stored.pdf_password, undefined, 'the stored request still has a pdf_password key');
  assert.equal(stored.pdf_password_protected, true, 'the row does not even record THAT the job is protected');
  assert.equal(stored.output, 'pdf');
  assert.equal(jobs.pendingPasswords.get(id), PW, 'the side channel does not hold the password for the worker');
  assert.equal(jobs.pendingPasswords.size, 1, 'the side channel holds more than it should');
});

test('jobs.enqueue without a password stores no marker and no side-channel entry', async () => {
  resetJobs();
  await jobs.enqueue(42, {
    kind: 'render', webhookUrl: null, creditsReserved: 1,
    request: { template_base64: 'stub', output: 'document', items: [{ data: invoiceData() }] },
  });
  const insert = [...jobState.sql].reverse().find((s) => /INSERT INTO jobs/.test(s.text));
  const stored = JSON.parse(insert.params[3]);
  assert.equal(stored.pdf_password_protected, undefined);
  assert.equal(jobs.pendingPasswords.size, 0);
});

test('a protected job takes its password from the side channel and every PDF is stored encrypted', async () => {
  process.env.DOCMINT_FAKE_MODE = 'ok';
  resetJobs();
  jobState.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: 2 };
  await jobs.enqueue(42, {
    kind: 'render', webhookUrl: null, creditsReserved: 2, pdfPassword: PW,
    request: { template_base64: 'stub', output: 'pdf', items: [{ data: invoiceData() }] },
  });
  const j = await runWorkerUntilTerminal();
  assert.equal(j.status, 'succeeded', JSON.stringify(j.error));
  assert.equal(j.credits_charged, 2);
  // The entry is deleted when the job finishes: no plaintext outlives the run.
  assert.equal(jobs.pendingPasswords.size, 0, 'a password copy outlived the finished job');
  // The password never sat in the stored request, and the delivered PDF is encrypted.
  assert.ok(!JSON.stringify(j.request).includes(PW), 'the password leaked into the stored request');
  assert.equal(jobState.files.length, 1);
  assert.ok(jobState.files[0].bytes.includes(Buffer.from('/Encrypt')), 'the stored PDF is not encrypted');
});

test('a protected job whose in-memory password a restart lost fails closed with pdf_encryption_failed and a full refund', async () => {
  resetJobs();
  jobState.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: 2 };
  await jobs.enqueue(42, {
    kind: 'render', webhookUrl: null, creditsReserved: 2, pdfPassword: PW,
    request: { template_base64: 'stub', output: 'pdf', items: [{ data: invoiceData() }] },
  });
  jobs.pendingPasswords.clear(); // ← the restart: the map dies with the process, the row does not

  const j = await runWorkerUntilTerminal();
  assert.equal(j.status, 'failed');
  assert.equal(j.error.code, 'pdf_encryption_failed');
  assert.equal(j.credits_charged, 0);
  assert.equal(jobState.account.credits_used, 0, 'the reserved credits were not refunded');
  assert.equal(jobState.files.length, 0, 'a file was delivered from the failed job');
  assert.equal(jobState.usage.length, 1);
  assert.equal(jobState.usage[0].error_code, 'pdf_encryption_failed');
  assert.equal(jobState.usage[0].ok, false);
});

test('an unprotected job still runs on a stored request that carries the protected marker logic untouched', async () => {
  process.env.DOCMINT_FAKE_MODE = 'noencrypt';
  resetJobs();
  jobState.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: 1 };
  await jobs.enqueue(42, {
    kind: 'render', webhookUrl: null, creditsReserved: 1,
    request: { template_base64: 'stub', output: 'document', items: [{ data: invoiceData() }] },
  });
  const j = await runWorkerUntilTerminal();
  assert.equal(j.status, 'succeeded', JSON.stringify(j.error));
  assert.equal(jobState.files.length, 1);
  assert.match(jobState.files[0].filename, /\.docx$/);
  assert.equal(jobs.pendingPasswords.size, 0);
});

test('cancelling a queued protected job drops its side-channel password', async () => {
  resetJobs();
  jobState.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: 2 };
  const id = await jobs.enqueue(42, {
    kind: 'render', webhookUrl: null, creditsReserved: 2, pdfPassword: PW,
    request: { template_base64: 'stub', output: 'pdf', items: [{ data: invoiceData() }] },
  });
  assert.equal(jobs.pendingPasswords.get(id), PW);
  const out = await jobs.cancel(42, id);
  assert.equal(out.status, 'cancelled');
  assert.equal(jobs.pendingPasswords.size, 0, 'the cancelled job leaves its plaintext behind');
});
