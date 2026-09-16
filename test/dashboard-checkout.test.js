'use strict';

// AT13(a)(a2)(b)(f): POST /dashboard/checkout and POST /logout are CSRF-protected and
// fail into fixed dashboard notices instead of the 500 page. Same vm-loaded-router
// harness as test/dashboard-portal.test.js: no database, no network, no Stripe.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const WEB = path.join(__dirname, '..', 'src', 'web.js');
const WEB_SOURCE = fs.readFileSync(WEB, 'utf8');
const SESSION_ID = 'checkout-test-session';
const COOKIE = `docmint_session=${SESSION_ID}`;
const PUBLIC_URL = 'https://docmint.test';
const SESSION_SECRET = 'checkout-test-secret';
const CHECKOUT_URL = 'https://checkout.example/session';
const PLANS = {
  free: { id: 'free', name: 'Free', credits: 30, priceUsd: 0, stripePriceEnv: null },
  starter: { id: 'starter', name: 'Starter', credits: 2000, priceUsd: 9, stripePriceEnv: 'STRIPE_PRICE_STARTER' },
  pro: { id: 'pro', name: 'Pro', credits: 20000, priceUsd: 29, stripePriceEnv: 'STRIPE_PRICE_PRO' },
};
// Faithful to src/config.js planPriceId: only a plan that EXISTS and has a
// configured price id is purchasable. A looser stub would let `plan=nope`
// through and quietly make the unknown-plan guard untestable.
const priceOf = (id) => (id !== 'free' && Object.hasOwn(PLANS, id) ? `price_${id}` : null);

class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

const account = (over = {}) => ({
  id: 7, email: 'checkout@example.test', plan: 'free', credits_limit: 30, credits_used: 0,
  stripe_customer_id: null, stripe_subscription_id: null, ...over,
});

function loadWeb(options = {}) {
  const calls = { checkout: [], destroyed: [], warnings: [] };
  const billing = {
    enabled: () => options.billingEnabled !== false,
    createCheckoutSession: async (...args) => {
      calls.checkout.push(args);
      if (options.checkoutError) throw options.checkoutError;
      return options.checkoutResult || { url: CHECKOUT_URL };
    },
    createPortalSession: async () => ({ url: 'https://billing.example/session' }),
    verifyCheckoutReturn: async () => ({ ok: true, message: 'Payment received.' }),
  };
  const auth = {
    accountForSession: async (sessionId) => (
      sessionId === SESSION_ID && options.account !== null ? options.account || account() : null
    ),
    createAccount: async () => { throw new Error('not used'); },
    verifyLogin: async () => null,
    createSession: async () => { throw new Error('not used'); },
    destroySession: async (id) => { calls.destroyed.push(id); },
    stashKeyForSession: () => {},
    takeKeyForSession: () => null,
  };
  const nodeCrypto = require('node:crypto');
  const requireMock = (name) => {
    if (name === 'express') return express;
    if (name === 'node:crypto') return nodeCrypto;
    if (name === 'node:fs') return { readFileSync: () => 'body{}' };
    if (name === 'node:path') return path;
    if (name === './config') return { config: { publicUrl: PUBLIC_URL, sessionSecret: SESSION_SECRET }, PLANS, planPriceId: priceOf };
    if (name === './db') return { query: async () => ({ rows: [] }), tx: async (fn) => fn({ query: async () => ({ rows: [] }) }), pool: {} };
    if (name === './auth') return auth;
    if (name === './billing') return billing;
    if (name === './analytics') return { increment: () => {} };
    if (name === './recovery') return { install: () => {} };
    throw new Error(`unexpected require: ${name}`);
  };
  const mod = { exports: {} };
  vm.runInNewContext(WEB_SOURCE, {
    require: requireMock, module: mod, exports: mod.exports, __dirname: path.dirname(WEB),
    console: { log() {}, warn() {}, error() {}, info() {} }, process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map, Promise, Error, RegExp,
    setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: WEB });
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use((req, res, next) => {
    req.log = { info: () => {}, warn: (event, fields) => calls.warnings.push({ event, fields }), error: () => {} };
    next();
  });
  app.use(mod.exports.router);
  const server = app.listen(0);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.once('listening', () => resolve({
      server, calls, base: `http://127.0.0.1:${server.address().port}`, csrfToken: mod.exports.csrfToken,
    }));
  });
}

const closeWeb = (h) => new Promise((resolve, reject) => h.server.close((e) => e ? reject(e) : resolve()));

const post = (h, route, body = '', headers = {}) => fetch(`${h.base}${route}`, {
  method: 'POST',
  headers: { cookie: COOKIE, 'content-type': 'application/x-www-form-urlencoded', ...headers },
  body,
  redirect: 'manual',
});
const getDashboard = (h, query = '') => fetch(`${h.base}/dashboard${query}`, { headers: { cookie: COOKIE }, redirect: 'manual' });
const token = (h) => h.csrfToken(SESSION_ID);

describe('POST /dashboard/checkout — CSRF (AT13(a))', () => {
  test('no session cookie redirects to /login and never reaches Stripe', async () => {
    const h = await loadWeb();
    try {
      const res = await fetch(`${h.base}/dashboard/checkout`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `plan=pro&csrf=${token(h)}`, redirect: 'manual',
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/login');
      assert.equal(h.calls.checkout.length, 0);
    } finally { await closeWeb(h); }
  });

  test('missing csrf is refused with 403 and Stripe is never called', async () => {
    const h = await loadWeb();
    try {
      const res = await post(h, '/dashboard/checkout', 'plan=pro');
      assert.equal(res.status, 403);
      assert.match(await res.text(), /Invalid CSRF token/);
      assert.equal(h.calls.checkout.length, 0);
    } finally { await closeWeb(h); }
  });

  test('a wrong token of the SAME length is refused with 403, not a 500', async () => {
    const h = await loadWeb();
    try {
      const good = token(h);
      const wrong = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
      assert.equal(wrong.length, good.length);
      const res = await post(h, '/dashboard/checkout', `plan=pro&csrf=${wrong}`);
      assert.equal(res.status, 403);
      assert.equal(h.calls.checkout.length, 0);
    } finally { await closeWeb(h); }
  });

  test('a token of a DIFFERENT length is refused with 403 (timingSafeEqual would throw)', async () => {
    const h = await loadWeb();
    try {
      const res = await post(h, '/dashboard/checkout', 'plan=pro&csrf=deadbeef');
      assert.equal(res.status, 403);
      assert.equal(h.calls.checkout.length, 0);
    } finally { await closeWeb(h); }
  });

  test('a non-string csrf (repeated parameter) is refused, not coerced', async () => {
    const h = await loadWeb();
    try {
      const good = token(h);
      const res = await post(h, '/dashboard/checkout', `plan=pro&csrf=${good}&csrf=${good}`);
      assert.equal(res.status, 403);
      assert.equal(h.calls.checkout.length, 0);
    } finally { await closeWeb(h); }
  });
});

describe('POST /dashboard/checkout — plan and error handling (AT13(a))', () => {
  test('an unpurchasable plan is refused before Stripe is called', async () => {
    const h = await loadWeb();
    try {
      for (const body of [`plan=free&csrf=${token(h)}`, `plan=nope&csrf=${token(h)}`, `csrf=${token(h)}`]) {
        const res = await post(h, '/dashboard/checkout', body);
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), '/dashboard?checkout=unknown_plan');
      }
      assert.equal(h.calls.checkout.length, 0);
    } finally { await closeWeb(h); }
  });

  test('a valid token and plan redirect to the Stripe session url', async () => {
    const h = await loadWeb();
    try {
      const res = await post(h, '/dashboard/checkout', `plan=pro&csrf=${token(h)}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), CHECKOUT_URL);
      assert.equal(h.calls.checkout.length, 1);
      assert.equal(h.calls.checkout[0][1], 'pro');
    } finally { await closeWeb(h); }
  });

  for (const [code, target] of [
    ['billing_unavailable', '/dashboard?checkout=unavailable'],
    ['unknown_plan', '/dashboard?checkout=unknown_plan'],
    ['billing_review_required', '/dashboard?checkout=review'],
  ]) {
    test(`a ${code} error becomes ${target}`, async () => {
      const h = await loadWeb({ checkoutError: new ApiError(400, code, 'nope') });
      try {
        const res = await post(h, '/dashboard/checkout', `plan=pro&csrf=${token(h)}`);
        assert.equal(res.status, 303);
        assert.equal(res.headers.get('location'), target);
      } finally { await closeWeb(h); }
    });
  }

  test('an unmapped error becomes ?checkout=error and is logged without the provider message', async () => {
    const boom = new ApiError(500, 'card_declined_internal', 'Stripe said: secret-provider-detail');
    const h = await loadWeb({ checkoutError: boom });
    try {
      const res = await post(h, '/dashboard/checkout', `plan=pro&csrf=${token(h)}`);
      assert.equal(res.status, 303);
      assert.equal(res.headers.get('location'), '/dashboard?checkout=error');
      const warn = h.calls.warnings.find((w) => w.event === 'dashboard.checkout_failed');
      assert.ok(warn, 'the failure must be logged');
      assert.equal(warn.fields.account, 7);
      const serialised = JSON.stringify(warn.fields);
      assert.ok(!serialised.includes('secret-provider-detail'), 'the provider message must not be logged');
      assert.ok(!serialised.includes('checkout@example.test'), 'the email must not be logged');
    } finally { await closeWeb(h); }
  });
});

describe('?checkout= notices are an allowlist (AT13(b))', () => {
  test('a known value renders its fixed notice', async () => {
    const h = await loadWeb();
    try {
      const html = await (await getDashboard(h, '?checkout=unknown_plan')).text();
      assert.match(html, /That plan cannot be bought on this deployment/);
    } finally { await closeWeb(h); }
  });

  test('prototype keys and injected markup render no notice at all', async () => {
    const h = await loadWeb();
    try {
      const plain = await (await getDashboard(h)).text();
      for (const value of ['constructor', '__proto__', 'toString', 'valueOf', '%3Cscript%3Ealert(1)%3C%2Fscript%3E']) {
        const html = await (await getDashboard(h, `?checkout=${value}`)).text();
        assert.equal(html, plain, `?checkout=${value} must change nothing`);
        assert.ok(!html.includes('alert(1)'), 'injected markup must never be reflected');
      }
      const repeated = await (await getDashboard(h, '?checkout=updated&checkout=updated')).text();
      assert.equal(repeated, plain, 'a non-string query value must render no notice');
    } finally { await closeWeb(h); }
  });
});

describe('the rendered dashboard carries the tokens (AT13(a)(a2))', () => {
  test('every checkout form and the logout form contain a csrf input', async () => {
    const h = await loadWeb();
    try {
      const html = await (await getDashboard(h)).text();
      const forms = html.match(/<form[^>]*action="\/dashboard\/checkout"[\s\S]*?<\/form>/g) || [];
      assert.ok(forms.length >= 1, 'the plan card must offer at least one purchasable plan');
      for (const form of forms) assert.match(form, /name="csrf"/);
      const logout = /<form[^>]*action="\/logout"[\s\S]*?<\/form>/.exec(html);
      assert.ok(logout, 'the top bar must render a logout form');
      assert.match(logout[0], /name="csrf"/);
    } finally { await closeWeb(h); }
  });
});

describe('POST /logout — CSRF (AT13(a2))', () => {
  test('missing token is refused and the session survives', async () => {
    const h = await loadWeb();
    try {
      const res = await post(h, '/logout', '');
      assert.equal(res.status, 403);
      assert.deepEqual(h.calls.destroyed, [], 'the session must not be destroyed');
    } finally { await closeWeb(h); }
  });

  test('a wrong token of equal and of different length is refused', async () => {
    const h = await loadWeb();
    try {
      const good = token(h);
      const wrong = (good[0] === 'a' ? 'b' : 'a') + good.slice(1);
      assert.equal((await post(h, '/logout', `csrf=${wrong}`)).status, 403);
      assert.equal((await post(h, '/logout', 'csrf=short')).status, 403);
      assert.deepEqual(h.calls.destroyed, []);
    } finally { await closeWeb(h); }
  });

  test('the right token signs the user out exactly once', async () => {
    const h = await loadWeb();
    try {
      const res = await post(h, '/logout', `csrf=${token(h)}`);
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      assert.deepEqual(h.calls.destroyed, [SESSION_ID]);
    } finally { await closeWeb(h); }
  });

  test('without a session cookie logout still clears and redirects, and destroys nothing', async () => {
    const h = await loadWeb();
    try {
      const res = await fetch(`${h.base}/logout`, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: '', redirect: 'manual',
      });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/');
      assert.deepEqual(h.calls.destroyed, []);
    } finally { await closeWeb(h); }
  });
});

describe('guard: no session-backed POST route loses its token check (AT13(1c))', () => {
  const RECOVERY = path.join(__dirname, '..', 'src', 'recovery.js');
  const RECOVERY_SOURCE = fs.readFileSync(RECOVERY, 'utf8');

  // src/web.js: scan the source, because that is where the token compares live
  // inline in each handler.
  function unprotectedInWeb() {
    const lines = WEB_SOURCE.split('\n');
    const starts = [];
    lines.forEach((line, i) => {
      const m = /router\.post\('([^']+)'/.exec(line);
      if (m) starts.push({ route: m[1], line: i });
    });
    return starts.filter(({ line }, n) => {
      const end = n + 1 < starts.length ? starts[n + 1].line : lines.length;
      return !lines.slice(line, end).join('\n').includes('timingSafeEqual');
    }).map((s) => s.route);
  }

  // src/recovery.js registers its paths as template literals — `/${action}` —
  // so a source scan cannot read them. Run the real install() against a
  // recording router instead, which resolves the paths exactly as production does.
  function recoveryPosts() {
    const recorded = [];
    const stub = { get: () => {}, post: (paths) => recorded.push(...[].concat(paths)) };
    require(RECOVERY).install(stub, { product: 'DocMint', shell: () => '', minLength: 10 });
    return recorded;
  }

  test('exactly the six pre-session paths lack a token compare', () => {
    // Every one of these runs before a session exists, so csrfToken(sessionId)
    // has no key to derive from. Anything reachable WITH a session must compare
    // a token; a route added without one in either file fails right here.
    const recovery = recoveryPosts();
    assert.ok(!RECOVERY_SOURCE.includes('timingSafeEqual'), 'recovery.js compares no token, so all its POSTs are unprotected');
    assert.deepEqual([...unprotectedInWeb(), ...recovery].sort(), [
      '/forgot-password', '/login', '/reset-password', '/signup',
      '/v1/forgot-password', '/v1/reset-password',
    ]);
  });

  test('the scan really finds the routes it claims to (it cannot pass vacuously)', () => {
    assert.ok((WEB_SOURCE.match(/router\.post\(/g) || []).length >= 6, 'web.js scan must see every POST route');
    assert.equal(recoveryPosts().length, 4, 'install() must register the four recovery POST paths');
    assert.ok(unprotectedInWeb().length > 0, 'a scan that finds nothing must not count as a pass');
  });
});
