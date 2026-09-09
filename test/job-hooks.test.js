'use strict';
const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const http = require('node:http');
const crypto = require('node:crypto');
const { fork } = require('node:child_process');
const path = require('node:path');
const target = process.env.QA_JOB_DATABASE_URL;
if (!target) {
  test('durable hooks require isolated QA_JOB_DATABASE_URL', { skip: true }, () => {});
} else {
  const u = new URL(target);
  assert(['127.0.0.1', 'localhost'].includes(u.hostname) && /^\/jobqa(?:_[a-z0-9_]+)?$/.test(u.pathname));
  const { Pool } = require('pg');
  const pool = new Pool({ connectionString: target });
  const db = { query: (...a) => pool.query(...a), tx: async fn => {
    const c = await pool.connect();
    try { await c.query('BEGIN'); const r = await fn(c); await c.query('COMMIT'); return r; }
    catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  } };
  const base = path.join(__dirname, '../src');
  const cfg = { ...require('../src/config').config, jobPollMs: 20, jobWebhookAttempts: 3, jobWebhookTimeoutMs: 150 };
  let receipts = [], mode = 'ok', server, stops = [], children = [];
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const wait = async (fn, ms = 7000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await delay(20); }
    assert.fail('condition timed out');
  };
  function load(file, replacements = {}, expose = '', timers = {}) {
    const module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(path.isAbsolute(file) ? file : path.join(base, file), 'utf8') + expose,
      { module, exports: module.exports, require: n => replacements[n] || (n.startsWith('./') ? require(path.join(base, n)) : require(n)),
        process, console, Date, JSON, Buffer, setTimeout, setInterval, clearInterval, ...timers }, { filename: file });
    return module.exports;
  }
  const transport = { assertPublicUrl: () => {}, postJson: async (url, o) => {
    assert.equal(new URL(url).hostname, '127.0.0.1');
    const r = await fetch(url, { method: 'POST', body: o.body, headers: o.headers, signal: AbortSignal.timeout(o.timeoutMs) });
    return { ok: r.ok, status: r.status };
  } };
  function jobs(custom = {}) {
    return load('jobs.js', { './db': db, './config': { ...require('../src/config'), config: cfg }, './net': transport, ...custom },
      '\nmodule.exports._deliver = deliverPending; module.exports._claim = claimDelivery;');
  }
  const row = async id => (await pool.query('SELECT * FROM jobs WHERE id=$1', [id])).rows[0];
  const seed = async (id, status = 'failed', hook = true, webhookStatus = null) => {
    await pool.query(`INSERT INTO jobs(id, account_id, kind, request, status, webhook_url, webhook_status, finished_at, error, result)
      VALUES($1,1,'batch','{}',$2,$3,$4,now(),$5,$6)`, [id, status, hook ? `http://127.0.0.1:${server.address().port}/hook` : null,
      webhookStatus, status === 'failed' ? { code: 'fixture' } : null,
      status === 'succeeded' ? { files: [{ path: '/f/test', size: 42 }], credits: { used: 1 } } : null]);
    if (webhookStatus === 'failed') await pool.query('UPDATE jobs SET webhook_attempts=$2 WHERE id=$1',
      [id, JSON.stringify([{ attempt: 1 }, { attempt: 2 }, { attempt: 3 }])]);
  };
  const template = require('./helpers/docx-fixtures');
  const loadTemplate = async () => {
    await pool.query('INSERT INTO invocations VALUES(1)');
    return { buffer: template.fixture('invoice'), template: null, source: 'inline' };
  };
  const stopChildren = async () => {
    for (const c of children) if (c.exitCode === null && c.signalCode === null) await new Promise(r => { c.once('exit', r); c.kill('SIGKILL'); });
    children = [];
  };
  if (process.argv.includes('--job-hook-worker') || process.argv.includes('--job-hook-legacy')) {
    // Imported batch/usage use this same isolated DB (no service credentials).
    require.cache[require.resolve('../src/db')] = { exports: db };
    const worker = process.argv.includes('--job-hook-legacy')
      ? load(process.env.QA_JOB_BASELINE, { './db': db, './config': { config: cfg }, './net': transport }) : jobs();
    worker.startWorker(loadTemplate);
    process.send({ ready: true });
    setInterval(() => {}, 1000);
  } else {
    before(async () => {
      require.cache[require.resolve('../src/db')] = { exports: db };
      await load('migrate.js', { './db': db }).migrate();
      await pool.query('CREATE TABLE invocations(n int)');
      await pool.query("INSERT INTO accounts(id,email,password_hash,credits_used,webhook_secret) VALUES(1,'fixture@example.invalid','unused',1,'fixture-secret')");
      await pool.query("SELECT setval('accounts_id_seq', 1)");
      server = http.createServer(async (req, res) => {
        const chunks = []; for await (const c of req) chunks.push(c);
        receipts.push({ at: Date.now(), body: Buffer.concat(chunks).toString(), headers: req.headers });
        if (mode === 'hold') return;
        res.writeHead(mode === 'fail' ? 500 : 204); res.end();
      });
      await new Promise(r => server.listen(0, '127.0.0.1', r));
    });
    beforeEach(async () => {
      stops.forEach(s => s()); stops = []; await stopChildren(); await delay(220);
      await pool.query('TRUNCATE jobs,files,usage_events,invocations');
      await pool.query('UPDATE accounts SET credits_used=1 WHERE id=1');
      receipts = []; mode = 'ok';
    });
    after(async () => {
      stops.forEach(s => s()); await stopChildren(); await delay(220);
      server.closeAllConnections(); await new Promise(r => server.close(r)); await pool.end();
    });
    test('public hook state has durable ID and next retry schedule', async () => {
      await seed('job_schedule'); mode = 'fail';
      await jobs()._deliver();
      const j = await jobs().get(1, 'job_schedule');
      assert.equal(j.webhook.status, 'pending');
      assert.equal(j.webhook.delivery_id, 'job_schedule:failed');
      assert(new Date(j.webhook.next_attempt_at).getTime() > Date.now());
      assert.equal(j.webhook.attempts.length, 1);
    });
    test('500 retry obeys persisted 4s/8s backoff and stops at configured budget', async () => {
      await seed('job_retry'); mode = 'fail'; const j = jobs();
      await j._deliver(); await j._deliver(); assert.equal(receipts.length, 1);
      const first = await row('job_retry');
      assert(new Date(first.webhook_next_at).getTime() - receipts[0].at >= 3900);
      await delay(4050); await j._deliver();
      assert.equal(receipts.length, 2);
      const second = await row('job_retry');
      assert(new Date(second.webhook_next_at).getTime() - receipts[1].at >= 7900);
      await delay(8050); await j._deliver(); await j._deliver();
      assert.equal(receipts.length, 3);
      const final = await row('job_retry');
      assert.equal(final.webhook_status, 'failed'); assert.equal(final.webhook_next_at, null);
      assert.equal(final.webhook_attempts.length, 3);
      assert.equal(new Set(receipts.map(r => r.body)).size, 1);
      assert.equal(new Set(receipts.map(r => r.headers['x-docmint-delivery-id'])).size, 1);
      for (const r of receipts) {
        assert.equal(r.headers['x-docmint-signature'], 'sha256=' + crypto.createHmac('sha256', 'fixture-secret')
          .update(r.headers['x-docmint-timestamp'] + '.' + r.body).digest('hex'));
      }
    });
    test('concurrent claimers reserve one attempt; expired lease recovers identical payload', async () => {
      await seed('job_lease', 'succeeded');
      const claimed = await Promise.all(Array.from({ length: 8 }, () => jobs()._claim()));
      assert.equal(claimed.filter(Boolean).length, 1);
      assert.equal((await row('job_lease')).webhook_attempts.length, 1);
      assert.equal(await jobs()._claim(), null);
      await delay(1200); await jobs()._deliver();
      const final = await row('job_lease');
      assert.equal(final.webhook_status, 'delivered');
      assert.equal(final.webhook_attempts.length, 2);
      assert.equal(receipts[0].body, claimed.find(Boolean).webhook_body);
      assert.equal((await pool.query('SELECT credits_used FROM accounts WHERE id=1')).rows[0].credits_used, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM invocations')).rows[0].n, 0);
    });
    test('receipt DB failure stays recoverable and cannot change terminal job or charge', async () => {
      await seed('job_db', 'succeeded');
      const failingDb = { ...db, query: async (sql, args) => {
        if (sql.startsWith('UPDATE jobs SET webhook_attempts')) throw Error('isolated receipt database failure');
        return db.query(sql, args);
      } };
      await assert.rejects(jobs({ './db': failingDb })._deliver(), /isolated receipt/);
      assert.equal((await row('job_db')).status, 'succeeded');
      await delay(1200); await jobs()._deliver();
      assert.equal(receipts.length, 2); assert.equal(receipts[0].body, receipts[1].body);
      assert.equal((await row('job_db')).webhook_status, 'delivered');
      assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM usage_events')).rows[0].n, 0);
    });
    test('delayed secret DB lookup cannot send after its lease has been replaced', async () => {
      await seed('job_secret_delay');
      let entered;
      const started = new Promise(r => { entered = r; });
      const delayedDb = { ...db, query: async (sql, args) => {
        if (sql.startsWith('SELECT webhook_secret')) { entered(); await delay(1700); }
        return db.query(sql, args);
      } };
      const old = jobs({ './db': delayedDb })._deliver();
      await started; await delay(1200); await jobs()._deliver(); await old;
      assert.equal(receipts.length, 1, 'stale DB result must not authorize another HTTP send');
      assert.equal((await row('job_secret_delay')).webhook_status, 'delivered');
    });
    test('late receipt cannot overwrite newer lease outcome', async () => {
      await seed('job_cas');
      let release, entered;
      const started = new Promise(r => { entered = r; });
      const held = jobs({ './net': { ...transport, postJson: async () => {
        entered(); return new Promise(r => { release = r; });
      } } })._deliver();
      await started; await delay(1200); await jobs()._deliver();
      const newer = await row('job_cas');
      release({ ok: false, status: 500 }); await held;
      const final = await row('job_cas');
      assert.equal(final.webhook_status, 'delivered');
      assert.equal(JSON.stringify(final.webhook_attempts), JSON.stringify(newer.webhook_attempts));
    });
    test('final interrupted attempt is bounded and old delivered/exhausted/nohook rows never send', async () => {
      await seed('job_bound');
      for (let i = 0; i < 3; i++) { assert(await jobs()._claim()); await delay(1200); }
      assert.equal(await jobs()._claim(), null);
      assert.equal((await row('job_bound')).webhook_status, 'failed');
      await seed('job_old_done', 'succeeded', true, 'delivered');
      await seed('job_old_exhausted', 'failed', true, 'failed');
      await seed('job_nohook', 'succeeded', false);
      await jobs()._deliver(); assert.equal(receipts.length, 0);
      for (const sql of require('../src/job-webhook-migration')) await pool.query(sql);
      for (const sql of require('../src/job-webhook-migration')) await pool.query(sql);
      await jobs()._deliver(); assert.equal(receipts.length, 0);
      assert.equal((await row('job_bound')).webhook_attempts.length, 3);
    });
    test('stale final renderer failure delivers without another render and refunds once', async () => {
      await seed('job_stale', 'running');
      await pool.query("UPDATE jobs SET attempts=1,started_at=now()-interval '16 minutes',credits_reserved=1 WHERE id='job_stale'");
      stops.push(jobs().startWorker(loadTemplate));
      await wait(async () => (await row('job_stale')).webhook_status === 'delivered');
      assert.equal(receipts.length, 1); assert.equal(JSON.parse(receipts[0].body).status, 'failed');
      assert.equal(JSON.parse(receipts[0].body).error.code, 'renderer_crashed');
      assert.equal((await pool.query('SELECT count(*)::int n FROM invocations')).rows[0].n, 0);
      assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM usage_events')).rows[0].n, 1);
    });
    test('refund database failure preserves the reservation for an atomic retry', async () => {
      await seed('job_refund', 'failed', false);
      await pool.query("UPDATE jobs SET credits_reserved=4 WHERE id='job_refund'; UPDATE accounts SET credits_used=4 WHERE id=1");
      await pool.query(`CREATE FUNCTION qa_refund_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.credits_used < OLD.credits_used THEN RAISE EXCEPTION 'isolated refund write failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER qa_refund_fail BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION qa_refund_fail()`);
      try {
        await jobs().settleCredits('job_refund', 1, 0).catch(() => {});
        assert.equal((await row('job_refund')).credits_reserved, 4, 'refund claim must survive a failed account update');
        assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 4);
      } finally { await pool.query('DROP TRIGGER qa_refund_fail ON accounts; DROP FUNCTION qa_refund_fail()'); }
      const outcomes = await Promise.all(Array.from({ length: 8 }, () => jobs().settleCredits('job_refund', 1, 0)));
      assert.equal(outcomes.reduce((n, r) => n + r.refunded, 0), 4);
      assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 0);
      assert.equal((await row('job_refund')).credits_reserved, 0);
    });
    test('cancel refund interruption recovers automatically without rendering', async () => {
      await seed('job_cancel_refund', 'queued', false);
      await pool.query("UPDATE jobs SET credits_reserved=4 WHERE id='job_cancel_refund'; UPDATE accounts SET credits_used=4 WHERE id=1");
      await pool.query(`CREATE FUNCTION qa_refund_fail() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.credits_used < OLD.credits_used THEN RAISE EXCEPTION 'isolated refund write failure'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER qa_refund_fail BEFORE UPDATE ON accounts FOR EACH ROW EXECUTE FUNCTION qa_refund_fail()`);
      try { await jobs().cancel(1, 'job_cancel_refund').catch(() => {}); }
      finally { await pool.query('DROP TRIGGER qa_refund_fail ON accounts; DROP FUNCTION qa_refund_fail()'); }
      assert.equal((await row('job_cancel_refund')).status, 'cancelled');
      assert.equal((await row('job_cancel_refund')).credits_reserved, 4);
      stops.push(jobs().startWorker(loadTemplate));
      await wait(async () => (await row('job_cancel_refund')).credits_reserved === 0, 800);
      assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 0);
      assert.equal((await pool.query('SELECT count(*)::int n FROM invocations')).rows[0].n, 0);
    });
    test('migration fails fast on old-writer locks with local timeout and rolls back', async () => {
      await seed('job_lock');
      const blocker = await pool.connect(), migrator = await pool.connect();
      await blocker.query('BEGIN'); await blocker.query("UPDATE jobs SET attempts=0 WHERE id='job_lock'");
      await migrator.query("SET statement_timeout='1800ms'");
      try {
        const m = load('migrate.js', { './db': { ...db, query: (...a) => migrator.query(...a) } });
        const start = Date.now();
        await assert.rejects(m.migrate(), e => e.code === '55P03');
        assert(Date.now() - start < 1700);
      } finally {
        await blocker.query('ROLLBACK'); await migrator.query('RESET statement_timeout');
        blocker.release(); migrator.release();
      }
      await load('migrate.js', { './db': db }).migrate();
    });
    test('legacy failed receipt with budget remaining resumes after staged cutover', async () => {
      await seed('job_legacy', 'failed', true, 'failed');
      await pool.query("UPDATE jobs SET webhook_attempts='[{\"attempt\":1,\"status\":503,\"ok\":false}]' WHERE id='job_legacy'");
      await jobs()._deliver();
      assert.equal(receipts.length, 1);
      assert.equal((await row('job_legacy')).webhook_status, 'delivered');
      assert.equal((await row('job_legacy')).webhook_attempts.length, 2);
    });
    test('reaper retains pending terminal hooks until delivery is terminal', async () => {
      await seed('job_pending'); await seed('job_delivered', 'succeeded', true, 'delivered');
      await seed('job_exhausted', 'failed', true, 'failed'); await seed('job_nohook', 'succeeded', false);
      await pool.query("UPDATE jobs SET finished_at=now()-interval '60 days'");
      let reap;
      load('jobs.js', { './db': db }, '', {
        setInterval: () => ({ unref() {} }), setTimeout: fn => { reap = fn; return { unref() {} }; },
      }).startReapers();
      reap(); await delay(100);
      assert(await row('job_pending'), 'pending delivery must survive retention cutoff');
      assert.equal(await row('job_delivered'), undefined);
      assert.equal(await row('job_exhausted'), undefined);
      assert.equal(await row('job_nohook'), undefined);
    });
    test('worker recovers a job that becomes stale after startup without a restart', async () => {
      const j = load('jobs.js', { './db': db, './net': transport, './config': { config: cfg } }, '', {
        setInterval: (fn, ms) => setInterval(fn, ms === 60000 ? 30 : ms),
      });
      stops.push(j.startWorker(loadTemplate)); await delay(100);
      await seed('job_later', 'running');
      await pool.query("UPDATE jobs SET attempts=1,started_at=now()-interval '16 minutes' WHERE id='job_later'");
      await wait(async () => (await row('job_later')).status === 'failed', 400);
    });
    test('old-binary rollback reaper cannot delete pending hooks; account cascade still removes them', async () => {
      await seed('job_rollback_pending');
      await seed('job_rollback_done', 'succeeded', true, 'delivered');
      await seed('job_rollback_exhausted', 'failed', true, 'failed');
      await pool.query("UPDATE jobs SET finished_at=now()-interval '60 days'");
      let oldReap;
      load(process.env.QA_JOB_BASELINE, { './db': db }, '', {
        setInterval: () => ({ unref() {} }), setTimeout: fn => { oldReap = fn; return { unref() {} }; },
      }).startReapers();
      oldReap(); await delay(100);
      assert(await row('job_rollback_pending'), 'schema must retain pending outbox during binary rollback');
      assert.equal(await row('job_rollback_done'), undefined);
      assert.equal(await row('job_rollback_exhausted'), undefined);
      await pool.query("INSERT INTO accounts(id,email,password_hash) VALUES(2,'cleanup@example.invalid','unused')");
      await pool.query("UPDATE jobs SET account_id=2 WHERE id='job_rollback_pending'");
      await pool.query('DELETE FROM accounts WHERE id=2');
      assert.equal(await row('job_rollback_pending'), undefined);
    });
    test('actual old sender and disabled candidate coexist; cutover resumes only after SIGKILL of old worker', async () => {
      assert(process.env.QA_JOB_BASELINE, 'set QA_JOB_BASELINE to unchanged deployed 462db08 jobs.js');
      const legacy = fork(__filename, ['--job-hook-legacy'], { stdio: ['ignore','inherit','inherit','ipc'] });
      children.push(legacy); await new Promise(r => legacy.once('message', r));
      mode = 'fail';
      const id = await jobs().enqueue(1, { kind: 'batch', request: { template_base64: 'fixture', output: 'document',
        items: [{ data: template.invoiceData() }] }, creditsReserved: 1, webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
      await wait(() => receipts.length === 1);
      assert.equal(receipts[0].headers['x-docmint-delivery-id'], undefined);
      await wait(async () => (await row(id)).webhook_status === 'failed');
      stops.push(jobs({ './config': { config: { ...cfg, jobWebhookDeliveryEnabled: false } } }).startWorker(loadTemplate));
      await delay(3300);
      assert.equal(receipts.length, 1, 'new process must not race old retry loop');
      await stopChildren(); // authority gate: no old process can write an unfenced ACK now
      stops.forEach(s => s()); stops = []; mode = 'ok';
      stops.push(jobs().startWorker(loadTemplate));
      await wait(async () => (await row(id)).webhook_status === 'delivered');
      assert.equal(receipts.length, 2);
      assert.equal((await row(id)).webhook_attempts.length, 2);
      assert.equal(receipts[1].headers['x-docmint-delivery-id'], id + ':succeeded');
      assert.equal((await pool.query('SELECT count(*)::int n FROM invocations')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 1);
    });
    test('staged rollout disables new sender while rendering, then resumes after old workers drain', async () => {
      const disabled = { ...cfg, jobWebhookDeliveryEnabled: false };
      stops.push(jobs({ './config': { config: disabled } }).startWorker(loadTemplate));
      const id = await jobs().enqueue(1, { kind: 'batch', request: { template_base64: 'fixture', output: 'document',
        items: [{ data: template.invoiceData() }] }, creditsReserved: 1, webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
      await wait(async () => (await row(id)).status === 'succeeded'); await delay(100);
      assert.equal(receipts.length, 0, 'disabled stage must never race the old direct sender');
      stops.forEach(s => s()); stops = [];
      stops.push(jobs().startWorker(loadTemplate));
      await wait(async () => (await row(id)).webhook_status === 'delivered');
      assert.equal(receipts.length, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM invocations')).rows[0].n, 1);
    });
    test('real rendered success survives HTTP-inflight SIGKILL without extra render/charge/usage', async () => {
      mode = 'hold';
      const start = async () => {
        const c = fork(__filename, ['--job-hook-worker'], { stdio: ['ignore','inherit','inherit','ipc'] });
        children.push(c); await new Promise((r, reject) => { c.once('message', r); c.once('error', reject); }); return c;
      };
      await start();
      const id = await jobs().enqueue(1, { kind: 'batch', request: { template_base64: 'fixture', output: 'document',
        items: [{ data: template.invoiceData() }] }, creditsReserved: 1, webhookUrl: `http://127.0.0.1:${server.address().port}/hook` });
      await wait(() => receipts.length === 1); await stopChildren();
      const before = await row(id); assert.equal(before.status, 'succeeded');
      mode = 'ok'; await start();
      await wait(async () => (await row(id)).webhook_status === 'delivered');
      const after = await row(id);
      assert.equal(receipts.length, 2); assert.equal(receipts[0].body, receipts[1].body);
      assert.equal(receipts[0].headers['x-docmint-delivery-id'], receipts[1].headers['x-docmint-delivery-id']);
      assert.equal(after.credits_charged, 1); assert.equal(JSON.stringify(after.result), JSON.stringify(before.result));
      assert.equal((await pool.query('SELECT credits_used FROM accounts')).rows[0].credits_used, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM invocations')).rows[0].n, 1);
      assert.equal((await pool.query('SELECT count(*)::int n FROM usage_events')).rows[0].n, 1);
    });
  }
}
