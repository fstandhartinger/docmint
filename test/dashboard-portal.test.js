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
const SESSION_ID = 'portal-test-session';
const COOKIE = `docmint_session=${SESSION_ID}`;
const PUBLIC_URL = 'https://docmint.test';
const SESSION_SECRET = 'portal-test-secret';
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

function account(over = {}) {
  return {
    id: 1,
    email: 'portal@example.test',
    plan: 'free',
    credits_limit: 30,
    credits_used: 0,
    stripe_customer_id: null,
    stripe_subscription_id: null,
    ...over,
  };
}

function loadWeb(options = {}) {
  const calls = { portal: [], warnings: [] };
  let portalError = options.portalError;
  const billing = {
    enabled: () => options.billingEnabled !== false,
    createPortalSession: async (...args) => {
      calls.portal.push(args);
      if (portalError) throw portalError;
      return options.portalResult || { url: PORTAL_URL };
    },
    get portalError() { return portalError; },
    set portalError(value) { portalError = value; },
  };
  const auth = {
    accountForSession: async (sessionId) => sessionId === SESSION_ID ? options.account || account() : null,
    createAccount: async () => { throw new Error('not used'); },
    verifyLogin: async () => null,
    createSession: async () => { throw new Error('not used'); },
    destroySession: async () => {},
    stashKeyForSession: () => {},
    takeKeyForSession: () => null,
  };
  const crypto = require('node:crypto');
  const requireMock = (name) => {
    if (name === 'express') return express;
    if (name === 'node:crypto') return crypto;
    if (name === 'node:fs') return { readFileSync: () => 'body{}' };
    if (name === 'node:path') return path;
    if (name === './config') {
      return {
        config: { publicUrl: PUBLIC_URL, sessionSecret: SESSION_SECRET },
        PLANS,
        planPriceId: priceOf,
      };
    }
    if (name === './db') return { query: async () => ({ rows: [] }), tx: async (fn) => fn({ query: async () => ({ rows: [] }) }), pool: {} };
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
      info: () => {},
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
      billing,
      csrfToken: mod.exports.csrfToken,
    }));
  });
}

function closeWeb(harness) {
  return new Promise((resolve, reject) => harness.server.close((error) => error ? reject(error) : resolve()));
}

async function postPortal(harness, body = '') {
  return fetch(`${harness.base}/dashboard/billing-portal`, {
    method: 'POST',
    headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded' },
    body,
    redirect: 'manual',
  });
}

async function getDashboard(harness, query = '') {
  return fetch(`${harness.base}/dashboard${query}`, {
    headers: { cookie: COOKIE },
    redirect: 'manual',
  });
}

function loadBilling() {
  const stripe = {
    billingPortal: { sessions: { create: async () => ({ url: PORTAL_URL }) } },
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

// AT13(c2): drive billing.createPortalSession itself — not the route's stub — and
// assert the return_url actually handed to Stripe. The AT10 acceptance only ever
// checked this through the route, so portalReturnUrl's allowlist was untested.
function loadBillingRecording() {
  const calls = { portal: [] };
  const stripe = {
    customers: { retrieve: async () => ({ id: 'cus_at13', deleted: false }) },
    billingPortal: { sessions: { create: async (args) => { calls.portal.push(args); return { url: PORTAL_URL }; } } },
  };
  const row = { id: 1, email: 'portal@example.test', plan: 'free', stripe_customer_id: 'cus_at13', stripe_subscription_id: null };
  const db = { query: async () => ({ rows: [row] }), tx: async (fn) => fn({ query: async () => ({ rows: [row] }) }) };
  const expressMock = { Router: () => ({ get() {}, post() {}, use() {} }) };
  const requireMock = (name) => {
    if (name === 'express') return expressMock;
    if (name === 'stripe') return function Stripe() { return stripe; };
    if (name === './config') return { config: { publicUrl: PUBLIC_URL, stripe: { secretKey: 'test' } }, PLANS, planPriceId: priceOf };
    if (name === './db') return db;
    if (name === './errors') return { ApiError };
    if (name === './analytics') return { increment: () => {} };
    if (name === './log') return { info() {}, warn() {}, error() {} };
    throw new Error(`unexpected require: ${name}`);
  };
  const mod = { exports: {} };
  vm.runInNewContext(BILLING_SOURCE, {
    require: requireMock, module: mod, exports: mod.exports, __dirname: path.dirname(BILLING),
    console: { log() {}, warn() {}, error() {}, info() {} }, process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, RegExp,
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: BILLING });
  return { billing: mod.exports, calls };
}

describe('AT13(c2) — createPortalSession return_url allowlist', () => {
  const account = { id: 1, stripe_customer_id: 'cus_at13' };

  test("'/dashboard' is passed through to Stripe", async () => {
    const { billing, calls } = loadBillingRecording();
    await billing.createPortalSession(account, { returnPath: '/dashboard' });
    assert.equal(calls.portal.at(-1).return_url, `${PUBLIC_URL}/dashboard`);
  });

  test('the default is the docs quota anchor', async () => {
    const { billing, calls } = loadBillingRecording();
    await billing.createPortalSession(account, {});
    assert.equal(calls.portal.at(-1).return_url, `${PUBLIC_URL}/docs#quota`);
    await billing.createPortalSession(account);
    assert.equal(calls.portal.at(-1).return_url, `${PUBLIC_URL}/docs#quota`);
  });

  for (const [label, value] of [
    ['a protocol-relative url', '//evil.example'],
    ['an absolute url', 'https://evil.example/x'],
    ['a traversal attempt', '../../etc'],
    ['an empty string', ''],
    ['a number', 42],
    ['an object', { toString: () => '/dashboard' }],
    ['null', null],
  ]) {
    test(`${label} falls back to the default, never an open redirect`, async () => {
      const { billing, calls } = loadBillingRecording();
      await billing.createPortalSession(account, { returnPath: value });
      const url = calls.portal.at(-1).return_url;
      assert.equal(url, `${PUBLIC_URL}/docs#quota`);
      assert.ok(url.startsWith(`${PUBLIC_URL}/`), 'the return url must stay on our own origin');
      assert.ok(!url.includes('evil.example'));
    });
  }
});

describe('AT10 — billing portal link in the dashboard', () => {
  test('a) no session cookie redirects to login without opening Stripe', async () => {
    const h = await loadWeb();
    try {
      const res = await fetch(`${h.base}/dashboard/billing-portal`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'csrf=x',
        redirect: 'manual',
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
      assert.equal(h.calls.portal.length, 0);
    } finally {
      await closeWeb(h);
    }
  });

  test('b) missing and same-length wrong CSRF tokens are rejected without Stripe', async () => {
    const h = await loadWeb({ account: account({ stripe_customer_id: 'cus_test' }) });
    try {
      const missing = await postPortal(h);
      assert.equal(missing.status, 403);
      const wrong = await postPortal(h, `csrf=${'a'.repeat(64)}`);
      assert.equal(wrong.status, 403);
      assert.equal(h.calls.portal.length, 0);
    } finally {
      await closeWeb(h);
    }
  });

  test('c) valid session and CSRF opens the portal and returns to the dashboard', async () => {
    const h = await loadWeb({ account: account({ stripe_customer_id: 'cus_test' }) });
    try {
      const res = await postPortal(h, `csrf=${encodeURIComponent(h.csrfToken(SESSION_ID))}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), PORTAL_URL);
      assert.equal(h.calls.portal.length, 1);
      assert.equal(h.calls.portal[0][0].id, 1);
      assert.equal(h.calls.portal[0][0].stripe_customer_id, 'cus_test');
      assert.equal(h.calls.portal[0][1].returnPath, '/dashboard');
    } finally {
      await closeWeb(h);
    }
  });

  test('d) billing errors redirect to fixed dashboard outcomes and generic failures are logged safely', async () => {
    const h = await loadWeb({ account: account({ stripe_customer_id: 'cus_test' }) });
    try {
      h.billing.portalError = new ApiError(400, 'no_subscription', 'provider detail');
      let res = await postPortal(h, `csrf=${encodeURIComponent(h.csrfToken(SESSION_ID))}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?billing=none');

      h.billing.portalError = new ApiError(503, 'billing_unavailable', 'provider detail');
      res = await postPortal(h, `csrf=${encodeURIComponent(h.csrfToken(SESSION_ID))}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?billing=unavailable');

      h.billing.portalError = new Error('provider detail');
      res = await postPortal(h, `csrf=${encodeURIComponent(h.csrfToken(SESSION_ID))}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?billing=error');
      assert.equal(h.calls.warnings.length, 1);
      assert.equal(h.calls.warnings[0].event, 'dashboard.billing_portal_failed');
      assert.equal(h.calls.warnings[0].fields.account, 1);
      assert.equal(h.calls.warnings[0].fields.code, undefined);
    } finally {
      await closeWeb(h);
    }
  });

  test('e) dashboard renders the portal only for enabled billing with a Stripe customer', async () => {
    const h = await loadWeb({ account: account({ stripe_customer_id: 'cus_test' }) });
    try {
      const res = await getDashboard(h);
      assert.equal(res.status, 200);
      const html = await res.text();
      const csrf = h.csrfToken(SESSION_ID);
      assert.ok(html.includes('action="/dashboard/billing-portal"'));
      assert.ok(html.includes(`<input type="hidden" name="csrf" value="${csrf}">`));
      assert.ok(html.includes('Manage billing'));
    } finally {
      await closeWeb(h);
    }

    const noCustomer = await loadWeb({ account: account() });
    try {
      const noCustomerRes = await getDashboard(noCustomer);
      assert.equal(noCustomerRes.status, 200);
      assert.ok(!(await noCustomerRes.text()).includes('billing-portal'));
    } finally {
      await closeWeb(noCustomer);
    }

    const disabled = await loadWeb({ account: account({ stripe_customer_id: 'cus_test' }), billingEnabled: false });
    try {
      const disabledRes = await getDashboard(disabled);
      assert.equal(disabledRes.status, 200);
      assert.ok(!(await disabledRes.text()).includes('billing-portal'));
    } finally {
      await closeWeb(disabled);
    }
  });

  test('f) billing notices are fixed and untrusted query values are not reflected', async () => {
    const h = await loadWeb({ account: account(), billingEnabled: false });
    try {
      const none = await getDashboard(h, '?billing=none');
      assert.equal(none.status, 200);
      const noneHtml = await none.text();
      assert.ok(noneHtml.includes('There is no billing record for this account yet. Choose a plan below to start one.'));

      const script = await getDashboard(h, `?billing=${encodeURIComponent('<script>alert(1)</script>')}`);
      assert.equal(script.status, 200);
      const scriptHtml = await script.text();
      assert.ok(!scriptHtml.includes('There is no billing record for this account yet.'));
      assert.ok(!scriptHtml.includes('<script>alert(1)</script>'));
      assert.ok(!scriptHtml.includes('&lt;script&gt;'));
    } finally {
      await closeWeb(h);
    }
  });

  test('g) portal return-path allowlist defaults invalid values safely', () => {
    const billing = loadBilling();
    assert.equal(billing.portalReturnUrl('/dashboard'), `${PUBLIC_URL}/dashboard`);
    assert.equal(billing.portalReturnUrl('/docs#quota'), `${PUBLIC_URL}/docs#quota`);
    assert.equal(billing.portalReturnUrl(undefined), `${PUBLIC_URL}/docs#quota`);
    assert.equal(billing.portalReturnUrl('//evil.example'), `${PUBLIC_URL}/docs#quota`);
    assert.equal(billing.portalReturnUrl('https://evil.example'), `${PUBLIC_URL}/docs#quota`);
  });
});
