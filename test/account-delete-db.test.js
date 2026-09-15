'use strict';

const test = require('node:test');

const target = process.env.DATABASE_URL;
if (!target) {
  test('AT11(f) account deletion against Postgres requires DATABASE_URL (throwaway database)', { skip: true }, () => {});
} else if (!['127.0.0.1', 'localhost'].includes(new URL(target).hostname)) {
  // The flow seeds and deletes real rows; like the QA billing suites it refuses
  // to write anywhere but a loopback database.
  test('AT11(f) account deletion requires a loopback DATABASE_URL', { skip: true }, () => {});
} else {
  const assert = require('node:assert/strict');
  const crypto = require('node:crypto');
  const { Pool } = require('pg');
  const { req, b64, serverUp, BASE } = require('./helpers');

  const pool = new Pool({ connectionString: target });
  const count = async (sql, params) => (await pool.query(sql, params)).rows[0].n;

  /* See api.test.js for why the server check happens inside the test. */
  let up = null;
  const when = (name, fn) => test(name, async (t) => {
    if (up === null) up = await serverUp();
    if (!up) { t.skip(`no server at ${BASE}`); return; }
    await fn(t);
  });

  /* An account made through the browser form, its session cookie, the CSRF
     token out of the dashboard HTML and its once-shown API key. Same shape as
     dashboard.test.js; the email always ends in @docmint.test. */
  async function webAccount() {
    const email = `at11-${crypto.randomBytes(6).toString('hex')}@docmint.test`;
    const res = await fetch(`${BASE}/signup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password: 'testpassword-long-enough' }).toString(),
      redirect: 'manual',
    });
    assert.equal(res.status, 302, `web signup should redirect, got ${res.status}`);
    const setCookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')].filter(Boolean);
    const cookiePair = setCookies.map((s) => s.split(';')[0]).find((s) => s.startsWith('docmint_session='));
    assert.ok(cookiePair, 'web signup should set the session cookie');
    const session = cookiePair.slice('docmint_session='.length);
    const cookie = `docmint_session=${session}`;

    const dash = await fetch(`${BASE}/dashboard?welcome=1`, { headers: { cookie } });
    assert.equal(dash.status, 200);
    const html = await dash.text();
    const csrf = /<meta name="docmint-csrf" content="([0-9a-f]{64})">/.exec(html)?.[1];
    assert.ok(csrf, 'the dashboard page should embed the CSRF token');
    const key = /<code id="api-key">([^<]+)<\/code>/.exec(html)?.[1] || null;
    assert.ok(key, 'the welcome page shows the first API key once');
    return { email, cookie, session, csrf, key };
  }

  function bridge(account, path, { method = 'GET', body } = {}) {
    const headers = { cookie: account.cookie, 'X-DocMint-CSRF': account.csrf };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    return fetch(`${BASE}/dashboard/api/v1${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
    });
  }

  function deleteAccount(account, body) {
    return fetch(`${BASE}/dashboard/delete-account`, {
      method: 'POST',
      headers: { cookie: account.cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      redirect: 'manual',
    });
  }

  const accountId = async (email) =>
    (await pool.query('SELECT id FROM accounts WHERE email = $1', [email])).rows[0]?.id;

  const cleanup = new Set();
  test.after(async () => {
    // Accounts already deleted through the route are absent; every remaining QA
    // account goes with its jobs first, so a retained delivery cannot block it.
    const ids = [...cleanup].filter(Boolean);
    if (ids.length) {
      await pool.query('DELETE FROM jobs WHERE account_id = ANY($1::bigint[])', [ids]).catch(() => {});
      await pool.query('DELETE FROM accounts WHERE id = ANY($1::bigint[])', [ids]).catch(() => {});
    }
    await pool.end();
  });

  const rowsFor = async (id) => ({
    api_keys: await count('SELECT count(*)::int n FROM api_keys WHERE account_id = $1', [id]),
    templates: await count('SELECT count(*)::int n FROM templates WHERE account_id = $1', [id]),
    files: await count('SELECT count(*)::int n FROM files WHERE account_id = $1', [id]),
    usage_events: await count('SELECT count(*)::int n FROM usage_events WHERE account_id = $1', [id]),
    sessions: await count('SELECT count(*)::int n FROM sessions WHERE account_id = $1', [id]),
    jobs: await count('SELECT count(*)::int n FROM jobs WHERE account_id = $1', [id]),
  });

  when('deleting an account through the route removes every linked row and nothing else', async () => {
    const a = await webAccount();
    const b = await webAccount();
    const aId = await accountId(a.email);
    const bId = await accountId(b.email);
    assert.ok(aId && bId, 'both QA accounts exist');
    cleanup.add(bId);

    // Everything the dashboard lists as deletable: a template with a stored
    // version (bridge upload), a second API key (bridge), one hosted file, one
    // usage record, a finished job whose webhook is still pending, and a
    // finished job that still holds a credit reservation.
    const name = `at11-${Date.now().toString(36)}`;
    const uploaded = await bridge(a, '/templates', {
      method: 'POST', body: { name, file_base64: b64('invoice.docx') },
    });
    assert.equal(uploaded.status, 201, await uploaded.text());
    const secondKey = await bridge(a, '/keys', { method: 'POST', body: { label: 'at11 second' } });
    assert.equal(secondKey.status, 201, await secondKey.text());
    const templateIds = (await pool.query('SELECT id FROM templates WHERE account_id = $1', [aId])).rows.map((r) => r.id);
    assert.equal(templateIds.length, 1);
    assert.ok((await count('SELECT count(*)::int n FROM template_versions WHERE template_id = ANY($1::text[])', [templateIds])) > 0);
    await pool.query(`INSERT INTO files(token, account_id, filename, content_type, bytes, size, expires_at)
      VALUES ($1, $2, 'qa-at11.bin', 'application/octet-stream', '\\x00', 1, now() + interval '1 hour')`,
      [`at11-file-${aId}`, aId]);
    await pool.query(`INSERT INTO usage_events(account_id, kind, format, credits, ok) VALUES ($1, 'render', 'docx', 1, true)`, [aId]);
    await pool.query(`INSERT INTO jobs(id, account_id, kind, request, status, webhook_url, webhook_status, finished_at)
      VALUES ($1, $2, 'batch', '{}', 'succeeded', 'http://127.0.0.1:9/hook', 'pending', now())`, [`at11-hook-${aId}`, aId]);
    await pool.query(`INSERT INTO jobs(id, account_id, kind, request, status, credits_reserved, finished_at)
      VALUES ($1, $2, 'batch', '{}', 'succeeded', 1, now())`, [`at11-reserved-${aId}`, aId]);

    // B is the control: it holds rows of the same kinds and must not change.
    await pool.query(`INSERT INTO usage_events(account_id, kind, format, credits, ok) VALUES ($1, 'render', 'docx', 1, true)`, [bId]);
    await pool.query(`INSERT INTO jobs(id, account_id, kind, request, status, finished_at)
      VALUES ($1, $2, 'batch', '{}', 'succeeded', now())`, [`at11-b-${bId}`, bId]);
    const bBefore = await rowsFor(bId);
    assert.ok(bBefore.api_keys >= 1 && bBefore.usage_events >= 1 && bBefore.jobs >= 1);

    // The extra case below needs A to have had a Stripe customer id. The route
    // refuses to delete an account while one is stored (fail closed when billing
    // cannot check it), so the id is set now — making it genuinely A's — and
    // cleared before the deletion request; afterwards it is A's FORMER id.
    const formerCustomer = `cus_at11_former_${crypto.randomBytes(6).toString('hex')}`;
    await pool.query('UPDATE accounts SET stripe_customer_id = $1 WHERE id = $2', [formerCustomer, aId]);
    await pool.query('UPDATE accounts SET stripe_customer_id = NULL WHERE id = $1', [aId]);

    const globalBefore = {
      stripe_events: await count('SELECT count(*)::int n FROM stripe_events', []),
      site_analytics_daily: await count('SELECT count(*)::int n FROM site_analytics_daily', []),
      password_reset_limits: await count('SELECT count(*)::int n FROM password_reset_limits', []),
    };

    const del = await deleteAccount(a, { csrf: a.csrf, email: a.email, password: 'testpassword-long-enough' });
    assert.equal(del.status, 303, await del.text());
    assert.equal(del.headers.get('location'), '/account-deleted');

    // Every account-linked row is gone, including the pending-webhook job and
    // the reserved-credits one: the delivery-retention trigger lets the
    // accounts cascade delete them.
    assert.equal(await count('SELECT count(*)::int n FROM accounts WHERE id = $1', [aId]), 0);
    assert.deepEqual(await rowsFor(aId), {
      api_keys: 0, templates: 0, files: 0, usage_events: 0, sessions: 0, jobs: 0,
    });
    assert.equal(await count('SELECT count(*)::int n FROM template_versions WHERE template_id = ANY($1::text[])', [templateIds]), 0);

    // The control account and the account-unlinked tables are untouched.
    assert.deepEqual(await rowsFor(bId), bBefore);
    assert.deepEqual({
      stripe_events: await count('SELECT count(*)::int n FROM stripe_events', []),
      site_analytics_daily: await count('SELECT count(*)::int n FROM site_analytics_daily', []),
      password_reset_limits: await count('SELECT count(*)::int n FROM password_reset_limits', []),
    }, globalBefore);

    // The old session, the old API key and the old password are all dead.
    const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: a.cookie }, redirect: 'manual' });
    assert.equal(dash.status, 302);
    assert.equal(dash.headers.get('location'), '/login');
    const usage = await req('/v1/usage', { key: a.key });
    assert.equal(usage.res.status, 401);
    const login = await fetch(`${BASE}/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: a.email, password: 'testpassword-long-enough' }).toString(),
      redirect: 'manual',
    });
    assert.equal(login.status, 401);

    // A Stripe event for A's former customer must not resurrect anything: the
    // existing subscription handler finds no account and simply returns.
    process.env.STRIPE_PRICE_STARTER = process.env.STRIPE_PRICE_STARTER || 'price_at11_fixture';
    const billing = require('../src/billing');
    const synthetic = {
      id: `sub_at11_${crypto.randomBytes(4).toString('hex')}`,
      customer: formerCustomer,
      metadata: {},
      items: { data: [{ price: { id: process.env.STRIPE_PRICE_STARTER } }] },
    };
    const accountsBefore = await count('SELECT count(*)::int n FROM accounts', []);
    const applied = await billing.applySubscription(synthetic, (text, params) => pool.query(text, params), { refresh: false });
    assert.equal(applied, undefined, 'no account matches a deleted id, so nothing is applied');
    assert.equal(await count('SELECT count(*)::int n FROM accounts', []), accountsBefore);
    assert.equal(await count('SELECT count(*)::int n FROM accounts WHERE stripe_customer_id = $1', [formerCustomer]), 0);
  });

  when('a queued job refuses the deletion and leaves every row intact', async () => {
    const a = await webAccount();
    const aId = await accountId(a.email);
    cleanup.add(aId);
    await pool.query(`INSERT INTO jobs(id, account_id, kind, request, status) VALUES ($1, $2, 'batch', '{}', 'queued')`, [`at11-queued-${aId}`, aId]);
    const intact = {
      accounts: await count('SELECT count(*)::int n FROM accounts WHERE id = $1', [aId]),
      ...await rowsFor(aId),
    };

    const del = await deleteAccount(a, { csrf: a.csrf, email: a.email, password: 'testpassword-long-enough' });
    assert.equal(del.status, 303, await del.text());
    assert.equal(del.headers.get('location'), '/dashboard?delete=jobs');
    assert.deepEqual({
      accounts: await count('SELECT count(*)::int n FROM accounts WHERE id = $1', [aId]),
      ...await rowsFor(aId),
    }, intact);
  });

  when('the row lock serialises deletion against a concurrent job enqueue', async () => {
    const a = await webAccount();
    const aId = await accountId(a.email);
    cleanup.add(aId);
    const holder = await pool.connect();
    const inserter = await pool.connect();
    try {
      await holder.query('BEGIN');
      const locked = await holder.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [aId]);
      assert.equal(locked.rows.length, 1);

      // INSERT INTO jobs takes a FOR KEY SHARE lock on the accounts row through
      // the foreign key, which waits behind the holder's FOR UPDATE.
      let settled = null;
      const insert = inserter.query(
        `INSERT INTO jobs(id, account_id, kind, request) VALUES ($1, $2, 'batch', '{}')`,
        [`at11-race-${aId}`, aId],
      ).then(() => { settled = 'ok'; }, (error) => { settled = error; });
      await new Promise((resolve) => { setTimeout(resolve, 400); });
      assert.equal(settled, null, 'the concurrent enqueue must block on the locked account row');

      await holder.query('DELETE FROM accounts WHERE id = $1', [aId]);
      await holder.query('COMMIT');

      // The insert promise records its rejection in `settled` instead of throwing.
      await insert;
      assert.ok(settled instanceof Error, 'the enqueue must fail once the account is gone');
      assert.equal(settled.code, '23503');
    } finally {
      await holder.query('ROLLBACK').catch(() => {});
      holder.release();
      inserter.release();
    }
  });
}
