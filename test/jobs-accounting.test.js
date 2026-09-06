'use strict';

/**
 * What an asynchronous job is allowed to charge for, and what it must record.
 *
 * Both faults these tests pin down were found on 2026-09-06 by running the real
 * /v1/jobs path against the deployed image:
 *
 *   1. A job that renders successfully and then cannot store its result — the zip
 *      is over `maxStoredFileBytes` — settles the credits BEFORE the storage step,
 *      so the caller is billed for a job that ends "failed" and hands them
 *      nothing. Measured: 11 credits taken, `jobs.credits_charged` recording 0.
 *   2. Nothing in the job path writes `usage_events`, so the breakdown in
 *      GET /v1/usage, and every internal report built on that table, is blind to
 *      asynchronous work. Measured: an account at 129 credits used with 62
 *      credits' worth of rows.
 *
 * The worker is driven for real — `startWorker` claims the job, `runJob` fills a
 * real DOCX from the committed fixture — with only the database replaced, because
 * the faults are in what the worker tells the database, not in the rendering.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

/* ------------------------------------------------------------ the fake database */

const dbPath = require.resolve('../src/db');

const state = {
  account: null,
  job: null,
  files: [],
  usage: [],
  sql: [],
};

const q = async (text, params = []) => {
  state.sql.push({ text: text.replace(/\s+/g, ' ').trim().slice(0, 90), params });
  const t = text.replace(/\s+/g, ' ');

  if (/SELECT \* FROM accounts WHERE id/.test(t)) return { rows: [state.account], rowCount: 1 };
  if (/SELECT webhook_secret FROM accounts/.test(t)) return { rows: [{ webhook_secret: 'x' }], rowCount: 1 };
  if (/SELECT status FROM jobs WHERE id/.test(t)) return { rows: [{ status: state.job.status }], rowCount: 1 };

  if (/UPDATE jobs j SET credits_reserved = 0, credits_charged/.test(t)) {
    const was = state.job.credits_reserved;
    state.job.credits_reserved = 0;
    // Mirrors the CASE in the statement: an already-settled job keeps its charge.
    if (was > 0) state.job.credits_charged = params[1];
    return { rows: [{ was }], rowCount: 1 };
  }
  if (/UPDATE accounts SET credits_used = GREATEST/.test(t)) {
    state.account.credits_used = Math.max(0, state.account.credits_used - params[1]);
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO files/.test(t)) {
    state.files.push({ token: params[0], filename: params[2], size: params[5] });
    return { rows: [], rowCount: 1 };
  }
  if (/INSERT INTO usage_events/.test(t)) {
    state.usage.push({
      account_id: params[0], kind: params[1], format: params[2], output: params[4],
      credits: params[5], ok: params[8], error_code: params[9],
    });
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE jobs SET status = 'succeeded'/.test(t)) {
    if (state.failSucceededUpdate) throw new Error('connection terminated unexpectedly');
    state.job.status = 'succeeded'; state.job.result = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE jobs SET status = 'failed'/.test(t)) {
    state.job.status = 'failed'; state.job.error = params[1];
    return { rows: [], rowCount: 1 };
  }
  if (/UPDATE jobs SET webhook_attempts/.test(t)) return { rows: [], rowCount: 1 };
  if (/DELETE FROM jobs|DELETE FROM files|UPDATE jobs SET status = CASE WHEN attempts/.test(t)) {
    return { rows: [], rowCount: 0 };
  }
  return { rows: [], rowCount: 0 };
};

let claimed = false;
const fakeDb = {
  pool: { totalCount: 0, idleCount: 0, waitingCount: 0 },
  query: q,
  tx: async (fn) => fn({
    query: async (text, params) => {
      const t = text.replace(/\s+/g, ' ');
      if (/SELECT \* FROM jobs WHERE status = 'queued'/.test(t)) {
        if (claimed) return { rows: [], rowCount: 0 };
        claimed = true;
        return { rows: [state.job], rowCount: 1 };
      }
      if (/UPDATE jobs SET status = 'running'/.test(t)) { state.job.status = 'running'; return { rows: [], rowCount: 1 }; }
      return q(text, params);
    },
  }),
};

require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };

const jobs = require('../src/jobs');
const { config } = require('../src/config');
const H = require('./helpers/docx-fixtures');

/* ---------------------------------------------------------------- the harness */

const TEMPLATE = H.fixture('invoice');
const loadTemplate = async () => ({ buffer: TEMPLATE, template: null, source: 'inline' });

/** Runs one job through the real worker and returns when it reaches a terminal state. */
async function runOneJob({ items, output = 'document', reserved, storedFileLimit }) {
  claimed = false;
  state.files = []; state.usage = []; state.sql = [];
  state.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: reserved };
  state.job = {
    id: 'job_test', account_id: 42, kind: 'batch', status: 'queued', attempts: 0,
    credits_reserved: reserved, credits_charged: 0, webhook_url: null,
    created_at: new Date().toISOString(), started_at: null, finished_at: null,
    request: { template_base64: 'x', output, items },
  };

  const before = config.maxStoredFileBytes;
  if (storedFileLimit) config.maxStoredFileBytes = storedFileLimit;
  const stop = jobs.startWorker(loadTemplate);
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !['succeeded', 'failed', 'cancelled'].includes(state.job.status)) {
      await new Promise((r) => { setTimeout(r, 100); });
    }
  } finally {
    stop();
    config.maxStoredFileBytes = before;
  }
  return state;
}

const data = () => H.invoiceData();

/* ------------------------------------------------------------------- the tests */

test('a job that succeeds charges exactly what it produced', async () => {
  const s = await runOneJob({ items: [{ data: data() }, { data: data() }], reserved: 2 });
  assert.equal(s.job.status, 'succeeded');
  assert.equal(s.account.credits_used, 2, 'two documents, two credits');
  assert.equal(s.job.credits_charged, 2);
  assert.equal(s.files.length, 1, 'two documents are delivered as one zip');
});

test('a job that renders but cannot store its result is not charged for it', async () => {
  // The result is over the hosted-file limit, which is exactly the shape of the
  // failure measured in production: rendering succeeded, delivery did not.
  const s = await runOneJob({ items: [{ data: data() }, { data: data() }], reserved: 2, storedFileLimit: 1024 });

  assert.equal(s.job.status, 'failed');
  assert.equal(JSON.parse(s.job.error).code, 'file_too_large');
  assert.equal(s.files.length, 0, 'nothing was stored');
  assert.equal(s.account.credits_used, 0,
    'a job that delivered no file must give every reserved credit back');
  assert.equal(s.job.credits_charged, 0);
});

test('a job that produces documents is recorded in usage_events', async () => {
  const s = await runOneJob({ items: [{ data: data() }, { data: data() }], reserved: 2 });
  assert.equal(s.usage.length, 1, 'the job wrote exactly one usage row');
  const u = s.usage[0];
  assert.equal(u.account_id, 42);
  assert.equal(u.credits, 2, 'the usage row carries what was charged');
  assert.equal(u.ok, true);
  assert.equal(u.output, 'document');
  assert.equal(u.format, 'docx');
});

test('a partly-failing job charges for the documents it produced and no more', async () => {
  const s = await runOneJob({
    items: [{ data: data() }, { data: {} }, { data: data() }],
    reserved: 3,
  });
  // on_error defaults to "fail", so a bad item fails the whole job and costs nothing.
  assert.equal(s.job.status, 'failed');
  assert.equal(s.account.credits_used, 0);

  const s2 = await runOneJob({
    items: [{ data: data() }, { data: {} }, { data: data() }],
    reserved: 3,
  });
  assert.equal(s2.account.credits_used, 0);
});

test('a database failure after settlement does not rewrite the charge or double-count it', async () => {
  // The narrow window the reordering above opens: the job rendered, the files
  // were stored, the credits were settled - and then writing the result row
  // failed. The failure path must not turn a real charge into "credits_charged 0
  // with the account still debited", nor write a second usage row for one job.
  claimed = false;
  state.files = []; state.usage = []; state.sql = []; state.failSucceededUpdate = true;
  state.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: 2 };
  state.job = {
    id: 'job_dbfail', account_id: 42, kind: 'batch', status: 'queued', attempts: 0,
    credits_reserved: 2, credits_charged: 0, webhook_url: null,
    created_at: new Date().toISOString(),
    request: { template_base64: 'x', output: 'document', items: [{ data: data() }, { data: data() }] },
  };
  const stop = jobs.startWorker(loadTemplate);
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && state.usage.length === 0) {
      await new Promise((r) => { setTimeout(r, 100); });
    }
    await new Promise((r) => { setTimeout(r, 500); });
  } finally { stop(); state.failSucceededUpdate = false; }

  assert.equal(state.account.credits_used, 2, 'the delivered documents stay charged');
  assert.equal(state.job.credits_charged, 2, 'and the job row still says so');
  assert.equal(state.usage.length, 1, 'one job, one usage row');
  assert.equal(state.usage[0].credits, 2);
});

test('an "on_error":"continue" job charges only the items that produced a document', async () => {
  claimed = false;
  state.files = []; state.usage = []; state.sql = [];
  state.account = { id: 42, plan: 'starter', credits_limit: 2000, credits_used: 3 };
  state.job = {
    id: 'job_partial', account_id: 42, kind: 'batch', status: 'queued', attempts: 0,
    credits_reserved: 3, credits_charged: 0, webhook_url: null,
    created_at: new Date().toISOString(),
    request: { template_base64: 'x', output: 'document', on_error: 'continue', items: [{ data: data() }, { data: {} }, { data: data() }] },
  };
  const stop = jobs.startWorker(loadTemplate);
  try {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && !['succeeded', 'failed'].includes(state.job.status)) {
      await new Promise((r) => { setTimeout(r, 100); });
    }
  } finally { stop(); }

  assert.equal(state.job.status, 'succeeded');
  assert.equal(state.job.credits_charged, 2, 'two of three items produced a document');
  assert.equal(state.account.credits_used, 2, 'the third credit was given back');
  assert.equal(state.usage.length, 1);
  assert.equal(state.usage[0].credits, 2);
  assert.equal(state.usage[0].ok, false, 'a batch with a failed item is not a clean run');
});
