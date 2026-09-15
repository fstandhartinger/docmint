'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'src', 'web.js');
const BILLING = path.join(__dirname, '..', 'src', 'billing.js');
const WEB_SOURCE = fs.readFileSync(WEB, 'utf8');
const BILLING_SOURCE = fs.readFileSync(BILLING, 'utf8');
const SESSION_ID = 'delete-test-session';
const COOKIE = `docmint_session=${SESSION_ID}`;
const PUBLIC_URL = 'https://docmint.test';
const SESSION_SECRET = 'delete-test-secret';
const PORTAL_URL = 'https://billing.example/session';
const PLANS = {
  free: { id: 'free', name: 'Free', credits: 30, priceUsd: 0, stripePriceEnv: null },
  starter: { id: 'starter', name: 'Starter', credits: 2000, priceUsd: 9, stripePriceEnv: 'STRIPE_PRICE_STARTER' },
  pro: { id: 'pro', name: 'Pro', credits: 20000, priceUsd: 29, stripePriceEnv: 'STRIPE_PRICE_PRO' },
  scale: { id: 'scale', name: 'Scale', credits: 100000, priceUsd: 99, stripePriceEnv: 'STRIPE_PRICE_SCALE' },
};
const priceOf = (id) => id === 'free' ? null : `price_${id}`;

class ApiError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// The row the read-only session lookup returns. Unique ids per case keep the
// in-memory deletion limiter (15-minute window, module state) from leaking one
// case's attempts into another's.
let nextAccountId = 1000;
function account(over = {}) {
  return {
    id: nextAccountId += 1,
    email: 'del@example.test',
    password_hash: 'stored-hash',
    plan: 'free',
    credits_limit: 30,
    credits_used: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    ...over,
  };
}

function loadWeb(options = {}) {
  const calls = { queries: [], bcrypt: [], openBilling: [], infos: [], warnings: [] };
  const acct = options.account === undefined ? account() : options.account;
  const record = (via) => async (sql, params) => {
    calls.queries.push({ via, sql, params });
    if (via === 'query') return { rows: acct ? [acct] : [] };
    // Inside tx(): the FOR UPDATE lock, the active-job probe and the DELETE.
    if (/FOR UPDATE/i.test(sql)) return { rows: acct ? [{ id: acct.id, plan: acct.plan, stripe_subscription_id: acct.stripe_subscription_id }] : [] };
    if (/FROM jobs/i.test(sql)) return { rows: options.activeJob ? [{ '?column?': 1 }] : [] };
    return { rows: [] };
  };
  const billing = {
    enabled: () => options.billingEnabled !== false,
    hasOpenBilling: async (customerId) => {
      calls.openBilling.push(customerId);
      if (options.openBilling === 'throw') throw new Error('stripe unreachable');
      return options.openBilling === true;
    },
    createPortalSession: async () => ({ url: PORTAL_URL }),
    verifyCheckoutReturn: async () => ({ ok: true, message: 'paid' }),
  };
  const auth = {
    accountForSession: async (sessionId) => sessionId === SESSION_ID ? acct : null,
    createAccount: async () => { throw new Error('not used'); },
    verifyLogin: async () => null,
    createSession: async () => { throw new Error('not used'); },
    destroySession: async () => {},
    stashKeyForSession: () => {},
    takeKeyForSession: () => null,
  };
  const bcryptjs = {
    compare: async (password, hash) => {
      calls.bcrypt.push({ password, hash });
      return options.passwordOk === true;
    },
  };
  const crypto = require('node:crypto');
  const requireMock = (name) => {
    if (name === 'express') return express;
    if (name === 'node:crypto') return crypto;
    if (name === 'node:fs') return { readFileSync: () => 'body{}' };
    if (name === 'node:path') return path;
    if (name === 'bcryptjs') return bcryptjs;
    if (name === './config') {
      return {
        config: { publicUrl: PUBLIC_URL, sessionSecret: SESSION_SECRET },
        PLANS,
        planPriceId: priceOf,
      };
    }
    if (name === './db') return { query: record('query'), tx: async (fn) => fn({ query: record('tx') }), pool: {} };
    if (name === './auth') return auth;
    if (name === './billing') return billing;
    if (name === './analytics') return { increment: () => {} };
    if (name === './recovery') return { install: () => {} };
    throw new Error(`unexpected require: ${name}`);
  };
  const mod = { exports: {} };
  vm.runInNewContext(WEB_SOURCE, {
    require: requireMock,
    module: mod,
    exports: mod.exports,
    __dirname: path.dirname(WEB),
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, RegExp,
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: WEB });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.log = {
      info: (event, fields) => calls.infos.push({ event, fields }),
      warn: (event, fields) => calls.warnings.push({ event, fields }),
      error: () => {},
    };
    next();
  });
  app.use(mod.exports.router);
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve({
      app,
      server,
      base: `http://127.0.0.1:${server.address().port}`,
      calls,
      account: acct,
      csrfToken: mod.exports.csrfToken,
    }));
  });
}

function closeWeb(harness) {
  return new Promise((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
}

function postDelete(harness, { cookie = COOKIE, body = {} } = {}) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (cookie !== null) headers.cookie = cookie;
  return fetch(`${harness.base}/dashboard/delete-account`, {
    method: 'POST',
    headers,
    body: new URLSearchParams(body).toString(),
    redirect: 'manual',
  });
}

function validBody(harness, over = {}) {
  return {
    csrf: harness.csrfToken(SESSION_ID),
    email: harness.account.email,
    password: 'the-current-password',
    ...over,
  };
}

/* A stubbed Stripe client whose two list calls return or throw what the case
   needs; the rest of billing.js is loaded for real from the worktree source. */
function loadBilling({ subscriptions, checkouts } = {}) {
  const asResult = (value, fallback) => value === undefined ? fallback : value;
  const call = (value) => async () => {
    if (value instanceof Error) throw value;
    return value;
  };
  const stripe = {
    subscriptions: { list: call(asResult(subscriptions, { data: [], has_more: false })) },
    checkout: { sessions: { list: call(asResult(checkouts, { data: [], has_more: false })) } },
  };
  const expressMock = { Router: () => ({ get() {}, post() {}, use() {} }) };
  const requireMock = (name) => {
    if (name === 'express') return expressMock;
    if (name === 'stripe') return function Stripe() { return stripe; };
    if (name === './config') return { config: { publicUrl: PUBLIC_URL, stripe: { secretKey: 'test' } }, PLANS, planPriceId: priceOf };
    if (name === './db') return { query: async () => ({ rows: [] }), tx: async (fn) => fn({ query: async () => ({ rows: [] }) }) };
    if (name === './errors') return { ApiError };
    if (name === './analytics') return { increment: () => {} };
    if (name === './log') return { info() {}, warn() {}, error() {} };
    throw new Error(`unexpected require: ${name}`);
  };
  const mod = { exports: {} };
  vm.runInNewContext(BILLING_SOURCE, {
    require: requireMock,
    module: mod,
    exports: mod.exports,
    __dirname: path.dirname(BILLING),
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, RegExp,
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: BILLING });
  return mod.exports;
}

describe('AT11 — self-service account deletion', () => {
  test('no session cookie redirects to login without touching the database', async () => {
    const h = await loadWeb();
    try {
      const res = await postDelete(h, { cookie: null, body: { csrf: 'x', email: 'a@b.c', password: 'p' } });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
      assert.equal(h.calls.queries.length, 0);
      assert.equal(h.calls.bcrypt.length, 0);
    } finally {
      await closeWeb(h);
    }
  });

  test('missing and wrong CSRF tokens get 403 before any database query', async () => {
    const h = await loadWeb();
    try {
      const missing = await postDelete(h, { body: { email: h.account.email, password: 'p' } });
      assert.equal(missing.status, 403);
      const wrong = await postDelete(h, { body: validBody(h, { csrf: 'a'.repeat(64) }) });
      assert.equal(wrong.status, 403);
      assert.equal(h.calls.queries.length, 0);
      assert.equal(h.calls.bcrypt.length, 0);
    } finally {
      await closeWeb(h);
    }
  });

  test('the session lookup is read-only and contains no UPDATE', async () => {
    const h = await loadWeb();
    try {
      const res = await postDelete(h, { body: validBody(h, { email: 'someone-else@example.test' }) });
      assert.equal(res.status, 303);
      assert.equal(h.calls.queries.length, 1);
      assert.equal(h.calls.queries[0].via, 'query');
      assert.match(h.calls.queries[0].sql, /FROM sessions/i);
      assert.ok(!/UPDATE/i.test(h.calls.queries[0].sql), 'the session lookup must not write');
    } finally {
      await closeWeb(h);
    }
  });

  test('the sixth attempt inside the window is rate-limited before bcrypt runs', async () => {
    const h = await loadWeb({ passwordOk: false });
    try {
      for (let attempt = 0; attempt < 5; attempt += 1) {
        const res = await postDelete(h, { body: validBody(h) });
        assert.equal(res.headers.get('location'), '/dashboard?delete=password');
      }
      assert.equal(h.calls.bcrypt.length, 5);
      const sixth = await postDelete(h, { body: validBody(h) });
      assert.equal(sixth.status, 303);
      assert.equal(sixth.headers.get('location'), '/dashboard?delete=rate_limited');
      assert.equal(h.calls.bcrypt.length, 5, 'the limited attempt must not reach bcrypt');
    } finally {
      await closeWeb(h);
    }
  });

  test('an email confirmation other than the account address is refused', async () => {
    const h = await loadWeb({ passwordOk: true });
    try {
      for (const email of ['other@example.test', ` ${h.account.email}x`]) {
        const res = await postDelete(h, { body: validBody(h, { email }) });
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), '/dashboard?delete=confirm');
      }
      assert.equal(h.calls.bcrypt.length, 0, 'confirmation is checked before bcrypt');
      assert.ok(!h.calls.queries.some((q) => /DELETE FROM accounts/i.test(q.sql)));
    } finally {
      await closeWeb(h);
    }
  });

  test('a wrong current password is refused', async () => {
    const h = await loadWeb({ passwordOk: false });
    try {
      const res = await postDelete(h, { body: validBody(h) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?delete=password');
      assert.equal(h.calls.bcrypt.length, 1);
      assert.deepEqual(h.calls.bcrypt[0], { password: 'the-current-password', hash: h.account.password_hash });
      assert.ok(!h.calls.queries.some((q) => /DELETE FROM accounts/i.test(q.sql)));
    } finally {
      await closeWeb(h);
    }
  });

  test('a paid plan or a stored subscription id is refused before Stripe is asked', async () => {
    const paid = await loadWeb({ passwordOk: true, account: account({ plan: 'pro' }) });
    try {
      const res = await postDelete(paid, { body: validBody(paid) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?delete=subscription');
      assert.equal(paid.calls.openBilling.length, 0);
    } finally {
      await closeWeb(paid);
    }

    const stored = await loadWeb({ passwordOk: true, account: account({ stripe_subscription_id: 'sub_stored' }) });
    try {
      const res = await postDelete(stored, { body: validBody(stored) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?delete=subscription');
      assert.equal(stored.calls.openBilling.length, 0);
      assert.ok(!stored.calls.queries.some((q) => /DELETE FROM accounts/i.test(q.sql)));
    } finally {
      await closeWeb(stored);
    }
  });

  test('an open Stripe subscription or checkout on the stored customer blocks deletion', async () => {
    for (const [name, acct] of [
      ['open subscription', account({ stripe_customer_id: 'cus_with_sub' })],
      ['open checkout', account({ stripe_customer_id: 'cus_with_checkout' })],
    ]) {
      const h = await loadWeb({ passwordOk: true, openBilling: true, account: acct });
      try {
        const res = await postDelete(h, { body: validBody(h) });
        assert.equal(res.status, 303, name);
        assert.equal(res.headers.get('location'), '/dashboard?delete=subscription', name);
        assert.equal(h.calls.openBilling.length, 1);
        assert.ok(!h.calls.queries.some((q) => /DELETE FROM accounts/i.test(q.sql)), name);
      } finally {
        await closeWeb(h);
      }
    }
  });

  test('a failing Stripe check, or disabled billing with a stored customer, fails closed', async () => {
    const failing = await loadWeb({ passwordOk: true, openBilling: 'throw', account: account({ stripe_customer_id: 'cus_flaky' }) });
    try {
      const res = await postDelete(failing, { body: validBody(failing) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?delete=billing_check_failed');
      assert.equal(failing.calls.warnings.length, 1);
      assert.equal(failing.calls.warnings[0].event, 'dashboard.delete_account_billing_check_failed');
      // The fields object is built inside the vm realm, so deepStrictEqual's
      // prototype check would fail it; compare keys and values instead.
      assert.deepEqual(Object.keys(failing.calls.warnings[0].fields), ['account']);
      assert.equal(failing.calls.warnings[0].fields.account, failing.account.id);
      assert.ok(!failing.calls.queries.some((q) => /DELETE FROM accounts/i.test(q.sql)));
    } finally {
      await closeWeb(failing);
    }

    const disabled = await loadWeb({ passwordOk: true, billingEnabled: false, account: account({ stripe_customer_id: 'cus_orphan' }) });
    try {
      const res = await postDelete(disabled, { body: validBody(disabled) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?delete=billing_check_failed');
      assert.equal(disabled.calls.openBilling.length, 0, 'no Stripe call when billing is disabled');
    } finally {
      await closeWeb(disabled);
    }
  });

  test('an active job rolls the transaction back without deleting the account', async () => {
    const h = await loadWeb({ passwordOk: true, activeJob: true });
    try {
      const res = await postDelete(h, { body: validBody(h) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?delete=jobs');
      const txSql = h.calls.queries.filter((q) => q.via === 'tx').map((q) => q.sql);
      assert.ok(txSql.some((sql) => /FOR UPDATE/i.test(sql)), 'the account row is locked first');
      assert.ok(txSql.some((sql) => /FROM jobs/i.test(sql)), 'active jobs are probed');
      assert.ok(!txSql.some((sql) => /DELETE FROM accounts/i.test(sql)), 'nothing is deleted');
    } finally {
      await closeWeb(h);
    }
  });

  test('success deletes inside the transaction, clears the cookie and logs no email', async () => {
    const h = await loadWeb({ passwordOk: true });
    try {
      const res = await postDelete(h, { body: validBody(h) });
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/account-deleted');
      const txSql = h.calls.queries.filter((q) => q.via === 'tx').map((q) => q.sql);
      const lockAt = txSql.findIndex((sql) => /FOR UPDATE/i.test(sql));
      const deleteAt = txSql.findIndex((sql) => /DELETE FROM accounts/i.test(sql));
      assert.ok(lockAt !== -1 && deleteAt !== -1 && lockAt < deleteAt, 'the row is locked before it is deleted');
      const cookie = res.headers.get('set-cookie') || '';
      assert.match(cookie, /docmint_session=/);
      assert.match(cookie, /Expires=Thu, 01 Jan 1970/);
      assert.equal(h.calls.infos.length, 1);
      assert.equal(h.calls.infos[0].event, 'account.deleted');
      assert.deepEqual(Object.keys(h.calls.infos[0].fields), ['account']);
      assert.equal(h.calls.infos[0].fields.account, h.account.id);
      assert.ok(!JSON.stringify(h.calls.infos[0].fields).includes(h.account.email));
    } finally {
      await closeWeb(h);
    }
  });

  test('the deleted page answers with fixed text and both links', async () => {
    const h = await loadWeb();
    try {
      const res = await fetch(`${h.base}/account-deleted`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('Account deleted'));
      assert.ok(html.includes('href="/"'));
      assert.ok(html.includes('href="/signup"'));
    } finally {
      await closeWeb(h);
    }
  });

  test('an untrusted ?delete= value shows no notice and is never reflected', async () => {
    const h = await loadWeb({ billingEnabled: false });
    try {
      const known = await fetch(`${h.base}/dashboard?delete=rate_limited`, {
        headers: { cookie: COOKIE }, redirect: 'manual',
      });
      assert.equal(known.status, 200);
      assert.ok((await known.text()).includes('Too many deletion attempts.'));

      const res = await fetch(`${h.base}/dashboard?delete=${encodeURIComponent('<script>alert(1)</script>')}`, {
        headers: { cookie: COOKIE }, redirect: 'manual',
      });
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(!html.includes('Too many deletion attempts.'));
      assert.ok(!html.includes('<script>alert(1)</script>'));
      assert.ok(!html.includes('&lt;script&gt;'));

      const card = await fetch(`${h.base}/dashboard`, { headers: { cookie: COOKIE }, redirect: 'manual' });
      const cardHtml = await card.text();
      assert.ok(cardHtml.includes('action="/dashboard/delete-account"'));
      assert.ok(cardHtml.includes(`<input type="hidden" name="csrf" value="${h.csrfToken(SESSION_ID)}">`));
      assert.ok(cardHtml.includes('for="delete-email"'));
      assert.ok(cardHtml.includes('id="delete-email" name="email" type="email" required autocomplete="off"'));
      assert.ok(cardHtml.includes('for="delete-password"'));
      assert.ok(cardHtml.includes('id="delete-password" name="password" type="password" required autocomplete="current-password"'));
      assert.ok(cardHtml.includes('Delete my account permanently'));
    } finally {
      await closeWeb(h);
    }
  });
});

describe('AT11 — billing.hasOpenBilling', () => {
  test('every blocking subscription status counts as open billing', async () => {
    for (const status of ['active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused']) {
      const billing = loadBilling({ subscriptions: { data: [{ id: 'sub_1', status }], has_more: false } });
      assert.equal(await billing.hasOpenBilling('cus_1'), true, `status ${status}`);
    }
  });

  test('a cancelled subscription alone is not open billing', async () => {
    const billing = loadBilling({ subscriptions: { data: [{ id: 'sub_1', status: 'canceled' }], has_more: false } });
    assert.equal(await billing.hasOpenBilling('cus_1'), false);
  });

  test('an open checkout session counts as open billing', async () => {
    const billing = loadBilling({
      subscriptions: { data: [{ id: 'sub_1', status: 'canceled' }], has_more: false },
      checkouts: { data: [{ id: 'cs_1', status: 'open' }], has_more: false },
    });
    assert.equal(await billing.hasOpenBilling('cus_1'), true);
  });

  test('a customer Stripe no longer knows means no open billing', async () => {
    const missing = new Error('No such customer');
    missing.code = 'resource_missing';
    const billing = loadBilling({ subscriptions: missing });
    assert.equal(await billing.hasOpenBilling('cus_gone'), false);
  });

  test('any other Stripe error propagates so the caller can fail closed', async () => {
    const billing = loadBilling({ subscriptions: new Error('stripe is down') });
    await assert.rejects(() => billing.hasOpenBilling('cus_1'), /stripe is down/);
  });
});
