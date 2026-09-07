'use strict';
/**
 * C2/C3/C4 billing guards — the regression suite for the three faults found on
 * 2026-09-06 by walking the real customer journey:
 *
 *   C2  an account that already subscribed got a SECOND subscription instead of an
 *       upgrade, sibling products on the shared Stripe account could downgrade it,
 *       and a webhook that failed half way was swallowed as a duplicate on retry.
 *   C3  the dashboard printed "Payment received" because the URL said
 *       `?checkout=success`. A query parameter is not a receipt.
 *   C4  the Checkout page showed the portfolio's business name, so a buyer could
 *       not tell who was charging them.
 *
 * This file needs no database, no network and no Stripe key: src/billing.js is
 * loaded in a VM with mocked `stripe`, `./db` and `./config`, and every call it
 * makes is recorded. It therefore runs anywhere, including in CI and against a
 * copy of the file pulled out of a production container.
 */
const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const BILLING = process.env.BILLING_UNDER_TEST || path.join(__dirname, '..', 'src', 'billing.js');
const SOURCE = fs.readFileSync(BILLING, 'utf8');
const PLAN_IDS = ['free', 'starter', 'pro', 'scale'];

function load(opts = {}) {
  const sizes = { free: 10, starter: 5000, pro: 50000, scale: 250000 };
  const PLANS = Object.fromEntries(PLAN_IDS.map((id) => [id, {
    id,
    name: id[0].toUpperCase() + id.slice(1),
    credits: sizes[id],
    quota: sizes[id],
    priceUsd: { free: 0, starter: 9, pro: 29, scale: 99 }[id],
    stripePriceEnv: id === 'free' ? null : `STRIPE_PRICE_${id.toUpperCase()}`,
  }]));
  const priceOf = (id) => (id === 'free' ? null : `price_test_${id}`);

  const calls = { checkoutCreate: [], subUpdate: [], portal: [], expire: [], sessionRetrieve: null, subCancel: [], selects: [], subRetrieve: [], trace: [] };
  const dbUpdates = [];
  const seenEvents = new Set();
  let failDb = false;
  let subscriptions = JSON.parse(JSON.stringify(opts.subscriptions || []));
  let sessions = JSON.parse(JSON.stringify(opts.sessions || []));
  let seq = 0;

  const account = Object.assign({
    id: 71, email: 'guards@example.test', plan: 'free',
    credits_limit: PLANS.free.credits, credits_used: 0,
    quota_month: PLANS.free.quota, used_month: 0,
    stripe_customer_id: null, stripe_subscription_id: null,
  }, opts.account || {});

  const stripe = {
    customers: {
      retrieve: async (id) => ({ id, deleted: false }),
      create: async (args) => ({ id: `cus_new_${++seq}`, ...args }),
    },
    subscriptions: {
      list: async () => {
        if (opts.failAfterCustomer) throw new Error('injected Stripe outage after customer creation');
        return { data: subscriptions, has_more: false };
      },
      retrieve: async (id) => {
        calls.subRetrieve.push(id);
        calls.trace.push(`retrieve:${id}`);
        if (opts.retrieveFailsPermanent) {
          const e = new Error(`No such subscription: ${id}`);
          e.code = 'resource_missing'; e.statusCode = 404;
          throw e;
        }
        if (opts.retrieveFails) throw new Error('injected Stripe outage on subscriptions.retrieve');
        const found = subscriptions.find((s) => s.id === id);
        if (found) return found;
        // Answering "active Pro" for an unknown id - which this stub used to do -
        // is the one answer that would hide an ordering bug behind a stub.
        const e = new Error(`No such subscription: ${id}`);
        e.code = 'resource_missing'; e.statusCode = 404;
        throw e;
      },
      cancel: async (id) => {
        calls.subCancel.push(id);
        subscriptions = subscriptions.map((x) => (x.id === id
          ? { ...x, status: 'incomplete_expired', latest_invoice: { ...(x.latest_invoice || {}), status: 'void' } }
          : x));
        return { id, status: 'incomplete_expired' };
      },
      update: async (id, args, options) => {
        calls.subUpdate.push({ id, args, options });
        const before = subscriptions.find((x) => x.id === id);
        const after = {
          ...before,
          items: { data: [{ ...before.items.data[0], price: { id: args.items[0].price } }] },
          latest_invoice: { hosted_invoice_url: 'https://invoice.invalid/i1' },
        };
        if (opts.pendingUpdate) after.pending_update = { expires_at: 1 };
        subscriptions = subscriptions.map((x) => (x.id === id ? after : x));
        return after;
      },
    },
    checkout: {
      sessions: {
        create: async (args, options) => {
          calls.checkoutCreate.push({ args, options });
          // Stripe replays the STORED body for a repeated idempotency key, and
          // that body still says `status: "open"` even when the session has since
          // been expired — measured 2026-09-06. So `create` always answers "open"
          // here, and `createStatuses` sets what a fresh RETRIEVE of that session
          // says, which is the only place the truth shows up.
          const created = { id: `cs_${++seq}`, url: `https://checkout.invalid/cs_${seq}`, status: 'open', ...args };
          const truth = (opts.createStatuses || [])[calls.checkoutCreate.length - 1] || 'open';
          sessions.push({ ...created, status: truth });
          return created;
        },
        list: async () => ({ data: opts.openSessions || [], has_more: false }),
        expire: async (id) => { calls.expire.push(id); return { id, status: 'expired' }; },
        retrieve: async (id, options) => {
          calls.sessionRetrieve = options && options.expand;
          const found = sessions.find((x) => x.id === id);
          if (!found) {
            const e = new Error('No such checkout session');
            e.code = 'resource_missing'; e.statusCode = 404;
            throw e;
          }
          return found;
        },
      },
    },
    invoices: {
      retrieve: async (id) => {
        const found = subscriptions
          .map((sub) => sub.latest_invoice)
          .find((inv) => inv && typeof inv === 'object' && inv.id === id);
        if (found) return found;
        const e = new Error('No such invoice'); e.code = 'resource_missing'; e.statusCode = 404; throw e;
      },
    },
    billingPortal: { sessions: { create: async (args) => { calls.portal.push(args); return { url: 'https://portal.invalid' }; } } },
    webhooks: { constructEvent: (body) => body },
  };

  const runQuery = async (sql, args = []) => {
    const s = String(sql);
    if (/INSERT INTO stripe_events/i.test(s)) {
      if (seenEvents.has(args[0])) return { rowCount: 0, rows: [] };
      seenEvents.add(args[0]);
      return { rowCount: 1, rows: [] };
    }
    if (/^\s*SELECT/i.test(s)) {
      calls.selects.push(s.replace(/\s+/g, ' ').trim());
      if (/FOR UPDATE/i.test(s)) calls.trace.push('lock');
      if (/WHERE\s+id\s*=/i.test(s)) return { rows: String(args[0]) === String(account.id) ? [{ ...account }] : [] };
      if (/stripe_customer_id\s*=\s*\$/i.test(s)) {
        return { rows: args[0] && args[0] === account.stripe_customer_id ? [{ ...account }] : [] };
      }
      return { rows: [{ ...account }] };
    }
    if (/UPDATE\s+accounts/i.test(s)) {
      if (failDb) throw new Error('injected DB failure');
      dbUpdates.push({ sql: s.replace(/\s+/g, ' ').trim(), args });
      for (const [, col, idx] of s.matchAll(/(\w+)\s*=\s*(?:COALESCE\([^,]+,\s*)?\$(\d+)/g)) {
        if (col === 'id') continue;
        if (col === 'stripe_customer_id' && /COALESCE/i.test(s) && account.stripe_customer_id) continue;
        account[col] = args[Number(idx) - 1];
      }
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 1, rows: [] };
  };

  const tx = async (fn) => {
    const markers = new Set(seenEvents);
    const writes = dbUpdates.length;
    // The account row is mutated in place by runQuery, so the rollback has to undo
    // that too. Without it, "nothing was written" passes whenever the throw happens
    // to precede the UPDATE — passing for the wrong reason.
    const before = JSON.parse(JSON.stringify(account));
    try {
      return await fn({ query: runQuery });
    } catch (e) {
      seenEvents.clear();
      markers.forEach((m) => seenEvents.add(m));
      dbUpdates.length = writes;         // ROLLBACK
      for (const k of Object.keys(account)) delete account[k];
      Object.assign(account, before);
      throw e;
    }
  };

  const expressMock = {
    Router: () => {
      const r = { _routes: {}, post: (p, ...h) => { r._routes[p] = h[h.length - 1]; }, get() {}, use() {} };
      return r;
    },
    raw: () => (req, res, next) => next && next(),
    json: () => (req, res, next) => next && next(),
  };
  const logStub = { info() {}, warn() {}, error() {}, debug() {} };
  const requireMock = (name) => {
    if (name === 'express') return expressMock;
    if (name === 'stripe') return function StripeCtor() { return stripe; };
    if (name === './config') {
      return {
        config: {
          publicUrl: 'https://product.invalid',
          billingEnabled: true,
          stripe: { secretKey: 'sk_test_guards', webhookSecret: 'whsec_guards' },
        },
        PLANS,
        planPriceId: priceOf,
        retentionFor: (p) => PLANS[p] || PLANS.free,
      };
    }
    if (name === './db') return { query: runQuery, tx, pool: {} };
    if (name === './log') return Object.assign({}, logStub, { log: logStub });
    if (name === './errors') {
      return {
        ApiError: class ApiError extends Error {
          constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
        },
      };
    }
    throw new Error(`unexpected require: ${name}`);
  };

  const mod = { exports: {} };
  vm.runInNewContext(SOURCE, {
    require: requireMock, module: mod, exports: mod.exports,
    console: { log() {}, warn() {}, error() {}, info() {} },
    process: { env: {} },
    Date, Math, JSON, Object, Array, String, Number, Boolean, Set, Map,
    Promise, Error, RegExp, setTimeout, clearTimeout, Buffer, URL, URLSearchParams,
  }, { filename: BILLING });

  const api = mod.exports;
  const fireEvent = async (event) => {
    if (typeof api.handleEvent === 'function') return api.handleEvent(event);
    const route = api.router._routes['/webhook'];
    return new Promise((resolve, reject) => {
      const res = {
        statusCode: 200,
        status(code) { this.statusCode = code; return this; },
        json: (body) => resolve(body),
        send: (body) => resolve({ body }),
      };
      Promise.resolve(route({ body: event, get: () => 'sig' }, res, reject)).catch(reject);
    });
  };

  return {
    api, account, calls, dbUpdates, priceOf, PLANS, fireEvent,
    setFailDb: (v) => { failDb = v; },
    setRetrieveFails: (v) => { opts.retrieveFails = v; },
    setRetrievePermanent: (v) => { opts.retrieveFailsPermanent = v; },
    quota: () => (account.quota_month !== undefined && api.BRAND_NAME === 'MailMint' ? account.quota_month : account.credits_limit),
    addSubscription: (s) => subscriptions.push(s),
    addSession: (s) => sessions.push(s),
  };
}

const BRAND = load().api.BRAND_NAME;
const paying = (over = {}) => ({ plan: 'starter', stripe_customer_id: 'cus_guards', stripe_subscription_id: 'sub_existing', ...over });
const existingSub = (h, plan = 'starter') => ({
  id: 'sub_existing', customer: 'cus_guards', status: 'active',
  metadata: { account_id: '71', plan },
  items: { data: [{ id: 'si_existing', price: { id: h.priceOf(plan) }, quantity: 1 }] },
});

describe('C2 — an existing subscription is changed, never duplicated', () => {
  test('two upgrade clicks update the subscription and open no checkout', async () => {
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 0, 'a second subscription must never be created');
    assert.ok(h.calls.subUpdate.length >= 1, 'the existing subscription must be updated');
  });

  test('duplicate clicks change the subscription once, without a replayable key', async () => {
    // This test used to require an idempotency key on the update and to assert that
    // two clicks shared it. That key is gone: measured on 2026-09-07, a key that
    // spans a window replays its stored response, so a third click in the same
    // window reached nothing at Stripe at all. The property that mattered — one
    // change, not two — is kept by the row lock and the re-read under it.
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    await h.api.createCheckoutSession(h.account, 'pro');
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 1,
      'the second click sees the price the first one set and changes nothing');
    assert.ok(!(h.calls.subUpdate[0].options || {}).idempotencyKey);
  });

  test('the upgrade is prorated, and a pending payment grants no quota yet', async () => {
    const h = load({ pendingUpdate: true, account: paying() });
    h.addSubscription(existingSub(h));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    const update = h.calls.subUpdate[0];
    assert.equal(update.args.proration_behavior, 'always_invoice');
    assert.equal(update.args.payment_behavior, 'pending_if_incomplete');
    assert.notEqual(h.quota(), h.PLANS.pro.credits, 'quota must not move before the invoice is paid');
    assert.match(out.url, /invoice|checkout=pending/, 'the customer is sent to the unpaid invoice');
  });

  test('a subscription that is not cleanly active goes to the billing portal', async () => {
    const h = load({ account: paying() });
    const sub = existingSub(h);
    sub.status = 'past_due';
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subUpdate.length, 0);
    assert.equal(h.calls.checkoutCreate.length, 0);
    assert.equal(h.calls.portal.length, 1);
  });
});

describe('C2 — a half-finished checkout leaves nothing broken behind', () => {
  test('an incomplete first payment still lets the buyer pay again', async () => {
    // Stripe keeps a failed first payment as `incomplete` for about a day. It
    // granted nothing, so parking the buyer in a billing portal for 24 hours
    // instead of a payment page was a revenue bug, not a safety measure.
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = existingSub(h);
    sub.id = 'sub_incomplete';
    sub.status = 'incomplete';
    // An incomplete subscription always has its first invoice: the fixture used
    // to leave it out, which is not a state Stripe produces.
    sub.latest_invoice = {
      id: 'in_first', status: 'open', hosted_invoice_url: 'https://invoice.invalid/first',
      payments: { data: [{ payment: { payment_intent: { id: 'pi_first', status: 'requires_payment_method' } } }] },
    };
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the buyer must get a payment page');
    assert.equal(h.calls.portal.length, 0);
  });

  test('a checkout that fails afterwards keeps the Stripe customer it created', async () => {
    // The customer is a real, permanent Stripe object holding the buyer's email.
    // Rolling its id back while the object survives mints a fresh orphan on every
    // retry, and nothing ever reclaims them.
    const h = load({ account: { stripe_customer_id: null }, failAfterCustomer: true });
    await assert.rejects(() => h.api.createCheckoutSession(h.account, 'pro'));
    assert.match(String(h.account.stripe_customer_id), /^cus_/,
      'the id must be committed even though the checkout failed');
  });
});

describe('B — an abandoned first attempt cannot become a second live subscription', () => {
  /**
   * Measured on 2026-09-06 against the deployed image, in Stripe test mode:
   * an abandoned $9 attempt sat `incomplete` with a payable invoice, the buyer
   * completed a $29 checkout next to it, and paying the abandoned invoice
   * afterwards left TWO active subscriptions — $38.00 a month — with the account
   * on the CHEAPER plan's quota, because the later event won.
   *
   * The buyer must still be able to pay. What they must not be able to do is pay
   * twice for one intention.
   */
  const incompleteSub = (h, plan = 'starter', over = {}) => ({
    id: 'sub_incomplete', customer: 'cus_guards', status: 'incomplete',
    metadata: { account_id: '71', plan },
    items: { data: [{ id: 'si_inc', price: { id: h.priceOf(plan) }, quantity: 1 }] },
    latest_invoice: {
      id: 'in_inc', status: 'open', hosted_invoice_url: 'https://invoice.invalid/pay-me',
      // Both shapes are read by the code, because which one Stripe returns
      // depends on the API version: `payment_intent` on the pinned 2025-01-27,
      // `payments.data[].payment.payment_intent` on the newer default. The
      // fixture carries the newer one, the one a version bump would leave behind.
      payments: { data: [{ payment: { payment_intent: { id: 'pi_inc', status: 'requires_payment_method' } } }] },
    },
    ...over,
  });

  test('asking for the same plan again finishes the payment already started', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(incompleteSub(h, 'pro'));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.checkoutCreate.length, 0, 'a second subscription must not be started');
    assert.match(out.url, /invoice\.invalid/, 'the buyer is sent to the invoice they already owe');
    assert.equal(h.calls.subCancel.length, 0, 'and the attempt they are paying is left alone');
  });

  test('changing plan cancels the abandoned attempt before opening a new checkout', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(incompleteSub(h, 'starter'));
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.subCancel, ['sub_incomplete'],
      'the abandoned invoice must stop being payable, or it can be paid later');
    assert.equal(h.calls.checkoutCreate.length, 1, 'the buyer still gets a payment page');
  });

  test('an abandoned attempt next to a live subscription is cancelled, not paid', async () => {
    const h = load({ account: paying() });
    h.addSubscription(existingSub(h));
    h.addSubscription(incompleteSub(h, 'pro'));
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.deepEqual(h.calls.subCancel, ['sub_incomplete'],
      'paying it would put a second subscription next to the live one');
    assert.equal(h.calls.checkoutCreate.length, 0, 'the live subscription is upgraded in place');
  });

  test('a payment that is still in flight is never cancelled', async () => {
    // The buyer may be on the 3-D Secure step in another tab. Voiding that
    // invoice while the charge is settling is how money is taken for nothing.
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription(incompleteSub(h, 'starter', {
      latest_invoice: {
        id: 'in_inc', status: 'open', hosted_invoice_url: 'https://invoice.invalid/pay-me',
        payments: { data: [{ payment: { payment_intent: { id: 'pi_inc', status: 'processing' } } }] },
      },
    }));
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'a settling payment must not be voided');
    assert.equal(h.calls.checkoutCreate.length, 0, 'nor may a second subscription be started next to it');
    assert.match(out.url, /invoice\.invalid|portal\.invalid/);
  });

  test('an attempt whose invoice cannot be read is never replaced by a second one', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = incompleteSub(h, 'starter');
    sub.latest_invoice = 'in_gone';          // a bare id that resolves to nothing
    h.addSubscription(sub);
    const out = await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'nothing is voided on a guess');
    assert.equal(h.calls.checkoutCreate.length, 0, 'and no second payable thing is created');
    assert.match(out.url, /portal\.invalid|invoice\.invalid/);
  });

  test('an attempt whose invoice is already void is simply ignored', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const sub = incompleteSub(h, 'starter');
    sub.latest_invoice = { id: 'in_inc', status: 'void', payments: { data: [] } };
    h.addSubscription(sub);
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'there is nothing left to make unpayable');
    assert.equal(h.calls.checkoutCreate.length, 1, 'and the buyer gets on with their purchase');
  });

  test('a second abandoned attempt is cleared even when the buyer is sent to the first', async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    const settling = incompleteSub(h, 'pro');
    settling.id = 'sub_settling';
    settling.latest_invoice = {
      id: 'in_settling', status: 'open', hosted_invoice_url: 'https://invoice.invalid/settling',
      payments: { data: [{ payment: { payment_intent: { id: 'pi_s', status: 'processing' } } }] },
    };
    const stale = incompleteSub(h, 'starter');
    stale.id = 'sub_stale';
    stale.latest_invoice = {
      id: 'in_stale', status: 'open', hosted_invoice_url: 'https://invoice.invalid/stale',
      payments: { data: [{ payment: { payment_intent: { id: 'pi_t', status: 'requires_payment_method' } } }] },
    };
    h.addSubscription(settling);
    h.addSubscription(stale);
    const out = await h.api.createCheckoutSession(h.account, 'scale');
    assert.deepEqual(h.calls.subCancel, ['sub_stale'], 'the abandoned one must stop being payable');
    assert.match(out.url, /settling/, 'and the buyer is sent to the payment that is actually running');
    assert.equal(h.calls.checkoutCreate.length, 0);
  });

  test("a sibling product's incomplete subscription is not ours to cancel", async () => {
    const h = load({ account: paying({ plan: 'free', stripe_subscription_id: null }) });
    h.addSubscription({
      id: 'sub_sibling_incomplete', customer: 'cus_guards', status: 'incomplete',
      metadata: { account_id: '71' },
      items: { data: [{ id: 'si_s', price: { id: 'price_of_a_sibling_product' }, quantity: 1 }] },
      latest_invoice: { id: 'in_s', status: 'open', hosted_invoice_url: 'https://invoice.invalid/sibling', payments: { data: [] } },
    });
    await h.api.createCheckoutSession(h.account, 'pro');
    assert.equal(h.calls.subCancel.length, 0, 'we only ever touch prices we sell');
    assert.equal(h.calls.checkoutCreate.length, 1);
  });
});

describe('D — a retry never hands back a dead checkout link', () => {
  /**
   * Measured on 2026-09-06 against the deployed image: Starter -> Pro -> Starter
   * inside half an hour returned the FIRST session, which the plan switch had
   * expired. Stripe's page then reads "You're all done here. You've either
   * completed your payment or this checkout session has timed out." The buyer
   * cannot pay, and nothing tells them why.
   *
   * The cause is a windowed idempotency key: Stripe replays the stored response,
   * and the session in it is gone. Reading the session back and retrying under a
   * second deterministic key does NOT fix it — measured, the second key replays a
   * dead session of its own. So checkout creation carries no key of ours, and the
   * duplicate protection is the row lock plus the open-session reuse below.
   */
  test('creating a checkout carries no replayable key of ours', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'starter');
    assert.equal(h.calls.checkoutCreate.length, 1);
    const options = h.calls.checkoutCreate[0].options || {};
    assert.ok(!options.idempotencyKey,
      'a windowed key replays whatever it stored, including a session that has since expired');
  });

  test('a second click on the same plan reuses the session that is still open', async () => {
    // This is what actually collapses a double click, and it can only ever return
    // an OPEN session, because that is what it filtered for.
    const open = {
      id: 'cs_open', mode: 'subscription', status: 'open',
      url: 'https://checkout.invalid/cs_open',
      metadata: { account_id: '71', plan: 'starter' },
    };
    const h = load({ account: { stripe_customer_id: 'cus_guards' }, openSessions: [open] });
    const out = await h.api.createCheckoutSession(h.account, 'starter');
    assert.equal(h.calls.checkoutCreate.length, 0, 'no second session is created');
    assert.equal(out.id, 'cs_open');
  });

  test('a session left open for a DIFFERENT plan is expired, not handed over', async () => {
    const open = {
      id: 'cs_other', mode: 'subscription', status: 'open',
      url: 'https://checkout.invalid/cs_other',
      metadata: { account_id: '71', plan: 'pro' },
    };
    const h = load({ account: { stripe_customer_id: 'cus_guards' }, openSessions: [open] });
    const out = await h.api.createCheckoutSession(h.account, 'starter');
    assert.deepEqual(h.calls.expire, ['cs_other']);
    assert.equal(h.calls.checkoutCreate.length, 1);
    assert.notEqual(out.id, 'cs_other');
  });
});

describe('A — a session that cannot be priced is judged on what we do know', () => {
  const bare = (over = {}) => ({
    id: 'cs_real', object: 'checkout.session', status: 'complete', payment_status: 'unpaid',
    client_reference_id: '71', customer: 'cus_guards', metadata: { account_id: '71' }, ...over,
  });

  test('an expired session reads as expired even with no line items to read', async () => {
    // Stripe keeps line_items on an expired session today - measured - but only
    // for a documented window. "That checkout link has expired" is true whether
    // or not we can still see what was on it; "we could not match that checkout
    // to this account" is not.
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(bare({ status: 'expired' }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'expired');
  });

  test('a PAID session we cannot price is never called paid', async () => {
    // The C2 guard has to survive the reordering: a sibling product's paid
    // session must not become "activating" just because its line items are gone.
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    h.addSession(bare({ status: 'complete', payment_status: 'paid', subscription: 'sub_paid' }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'unverified');
  });

  test('a session with a price that is not ours is still foreign', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(bare({
      status: 'complete', payment_status: 'paid',
      line_items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });
});

describe('C — the customer is minted once, and the comment has to say why', () => {
  test('each transaction re-reads the account row under its own lock', async () => {
    // The split into two transactions is deliberate, but it means the first
    // transaction's lock is GONE by the time the second starts. What makes two
    // simultaneous clicks safe is that the second transaction re-reads the row
    // under a fresh lock - not a lock spanning both, which is what the comment
    // claimed.
    const h = load({ account: { stripe_customer_id: null } });
    await h.api.createCheckoutSession(h.account, 'starter');
    const locked = h.calls.selects.filter((q) => /SELECT \* FROM accounts WHERE id = \$1 FOR UPDATE/i.test(q));
    assert.ok(locked.length >= 2,
      'both the customer transaction and the checkout transaction must lock the row themselves');
  });
});

describe('C2 — one Stripe account serves several products', () => {
  test("a sibling product's cancellation cannot downgrade this account", async () => {
    const h = load({ account: paying({ stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_foreign', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_foreign', status: 'canceled', customer: 'cus_someone_else',
        metadata: { account_id: '71', plan: 'pro', service: 'other-product' },
        items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter', 'a paying customer must not be downgraded by another product');
    assert.equal(h.dbUpdates.length, 0, 'and nothing at all may be written');
  });

  test('an event for a different Stripe customer is not applied here', async () => {
    const h = load({ account: paying({ stripe_subscription_id: 'sub_mine' }) });
    await h.fireEvent({
      id: 'evt_wrongcustomer', type: 'customer.subscription.updated',
      data: { object: {
        id: 'sub_of_another_customer', status: 'active', customer: 'cus_not_ours',
        metadata: { account_id: '71', plan: 'scale' },
        items: { data: [{ price: { id: h.priceOf('scale') } }] },
      } },
    });
    assert.equal(h.account.plan, 'starter', 'a matching numeric id is not proof of ownership');
  });

  test('a stale subscription ending does not revoke the current one', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_new' }) });
    // Stripe still answers for a cancelled subscription, so the fixture holds one.
    h.addSubscription({
      id: 'sub_old', status: 'canceled', customer: 'cus_guards',
      metadata: { account_id: '71', plan: 'starter' },
      items: { data: [{ price: { id: h.priceOf('starter') } }] },
    });
    await h.fireEvent({
      id: 'evt_stale', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_old', status: 'canceled', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'starter' },
        items: { data: [{ price: { id: h.priceOf('starter') } }] },
      } },
    });
    assert.equal(h.account.plan, 'pro');
    assert.equal(h.account.stripe_subscription_id, 'sub_new');
  });

  test('cancelling the CURRENT subscription still downgrades, as it must', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_mine' }) });
    h.addSubscription({
      id: 'sub_mine', status: 'canceled', customer: 'cus_guards',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent({
      id: 'evt_own_cancel', type: 'customer.subscription.deleted',
      data: { object: {
        id: 'sub_mine', status: 'canceled', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'pro' },
        items: { data: [{ price: { id: h.priceOf('pro') } }] },
      } },
    });
    assert.equal(h.account.plan, 'free', 'the guards must not have made cancellation impossible');
  });
});

describe('C5 — which webhook lands last must not decide what the customer keeps', () => {
  /**
   * Stripe emits a purchase's four events at once and delivers them concurrently.
   * Each body is a SNAPSHOT of the moment it was emitted, and
   * `customer.subscription.created` is emitted the instant the subscription
   * exists — which for a card payment is before the card is charged — so its body
   * says `status: "incomplete"` every single time.
   *
   * MailMint measured this ending badly: one paid account in two was left on the
   * free plan with its subscription id cleared while Stripe held an active, paid
   * subscription. DocMint was then measured doing the same thing on the deployed
   * image — `plan_applied account=1 plan=free credits=30 status=incomplete` — and
   * survived only because the free apply happened to land first.
   */
  const paidSub = (h, status = 'active') => ({
    id: 'sub_bought', customer: 'cus_guards', status,
    metadata: { account_id: '71', plan: 'pro' },
    items: { data: [{ id: 'si_b', price: { id: h.priceOf('pro') } }] },
  });
  const snapshot = (h, status) => ({
    id: 'sub_bought', customer: 'cus_guards', status,
    metadata: { account_id: '71', plan: 'pro' },
    items: { data: [{ id: 'si_b', price: { id: h.priceOf('pro') } }] },
  });

  test('the "incomplete" created snapshot arriving LAST does not undo the purchase', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription(paidSub(h));                       // what Stripe holds NOW
    h.addSession({
      id: 'cs_bought', object: 'checkout.session', status: 'complete', payment_status: 'paid',
      client_reference_id: '71', customer: 'cus_guards', subscription: 'sub_bought',
      line_items: { data: [{ price: { id: h.priceOf('pro') } }] },
      metadata: { account_id: '71', plan: 'pro' },
    });

    await h.fireEvent({ id: 'evt_1', type: 'checkout.session.completed', data: { object: {
      id: 'cs_bought', payment_status: 'paid', subscription: 'sub_bought',
      client_reference_id: '71', customer: 'cus_guards', metadata: { account_id: '71', plan: 'pro' },
    } } });
    await h.fireEvent({ id: 'evt_2', type: 'customer.subscription.updated', data: { object: snapshot(h, 'active') } });
    // ...and the one Stripe emitted FIRST arrives last, still saying incomplete.
    await h.fireEvent({ id: 'evt_3', type: 'customer.subscription.created', data: { object: snapshot(h, 'incomplete') } });

    assert.equal(h.account.plan, 'pro', 'the customer paid; the last delivery must not take it away');
    assert.equal(h.account.stripe_subscription_id, 'sub_bought',
      'and the id they would manage or cancel with must still be there');
  });

  test('the status is read from Stripe AFTER the account row is locked', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription(paidSub(h));
    await h.fireEvent({ id: 'evt_lock', type: 'customer.subscription.created', data: { object: snapshot(h, 'incomplete') } });
    const lock = h.calls.trace.indexOf('lock');
    const read = h.calls.trace.indexOf('retrieve:sub_bought');
    assert.ok(read >= 0, 'the snapshot must not be believed on its own');
    assert.ok(lock >= 0 && lock < read,
      'reading Stripe outside the lock would race the very deliveries this fixes');
  });

  test('a Stripe outage drops nothing: the delivery fails and Stripe retries it', async () => {
    // This test used to require the opposite - fall back to the event body, on the
    // reasoning that an outage must not leave a paying customer with nothing. It was
    // written before the outage was actually simulated. When it was, on the deployed
    // image with Stripe genuinely unreachable, that fallback took a paying account
    // from starter/2000 to free/30 and answered HTTP 200 so nothing was ever retried.
    // A snapshot we cannot confirm is not a fact; the delivery fails instead.
    const h = load({ account: { stripe_customer_id: 'cus_guards' }, retrieveFails: true });
    await assert.rejects(() => h.fireEvent({
      id: 'evt_out', type: 'customer.subscription.updated', data: { object: snapshot(h, 'active') },
    }));
    assert.equal(h.account.plan, 'free', 'nothing is written on an unverifiable snapshot');
  });

  test('a failure Stripe will never resolve is answered, but still writes nothing', async () => {
    // "No such subscription", a key in the wrong mode, a restricted key: retrying
    // for three days cannot fix any of them, and an endpoint that fails
    // continuously eventually gets disabled — which would take the deliveries that
    // DO work down with it. So this one is answered. It still writes nothing, and
    // it still does not consume the event id.
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_live' }), retrieveFailsPermanent: true });
    const stale = (status) => ({
      id: 'sub_live', customer: 'cus_guards', status,
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ id: 'si_live', price: { id: h.priceOf('pro') }, quantity: 1 }] },
    });
    const event = { id: 'evt_perm', type: 'customer.subscription.created', data: { object: stale('incomplete') } };
    const out = await h.fireEvent(event);
    assert.equal(out.ignored, 'subscription_unverifiable');
    assert.equal(h.account.plan, 'pro', 'nothing decided from the body');

    h.setRetrievePermanent(false);
    h.addSubscription(stale('active'));
    const again = await h.fireEvent(event);
    assert.ok(!again.duplicate, 'the event id was not consumed, so a redelivery still works');
  });

  test("a sibling product's event still costs nothing, outage or not", async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_live' }), retrieveFails: true });
    const out = await h.fireEvent({ id: 'evt_out5', type: 'customer.subscription.deleted', data: { object: {
      id: 'sub_of_another_product', customer: 'cus_guards', status: 'canceled', metadata: { account_id: '71' },
      items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    } } });
    assert.ok(out, 'a foreign event is answered, not retried forever');
    assert.equal(h.account.plan, 'pro');
  });
});

describe('C2 — a webhook that fails is retried for real', () => {
  const event = {
    id: 'evt_retry', type: 'checkout.session.completed',
    data: { object: {
      id: 'cs_retry', payment_status: 'paid', subscription: 'sub_paid',
      client_reference_id: '71', customer: 'cus_guards',
      metadata: { account_id: '71', plan: 'pro' },
    } },
  };

  test('a failure rolls the idempotency marker back, so the retry fulfils', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_paid', customer: 'cus_guards', status: 'active',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    h.setFailDb(true);
    await assert.rejects(() => h.fireEvent(event));
    h.setFailDb(false);
    const retry = await h.fireEvent(event);
    assert.ok(!retry.duplicate, 'the retry must not be swallowed as a duplicate');
    assert.equal(h.account.plan, 'pro', 'the customer paid, so the plan must land');
  });

  test('a genuine duplicate delivery is still a no-op', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_paid', customer: 'cus_guards', status: 'active',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent(event);
    const writes = h.dbUpdates.length;
    const again = await h.fireEvent(event);
    assert.ok(again.duplicate, 'the second delivery is a duplicate');
    assert.equal(h.dbUpdates.length, writes, 'and writes nothing further');
  });

  test('an unpaid checkout session grants no plan', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSubscription({
      id: 'sub_incomplete', customer: 'cus_guards', status: 'incomplete',
      metadata: { account_id: '71', plan: 'pro' },
      items: { data: [{ price: { id: h.priceOf('pro') } }] },
    });
    await h.fireEvent({
      id: 'evt_unpaid', type: 'checkout.session.completed',
      data: { object: {
        id: 'cs_unpaid', payment_status: 'unpaid', subscription: 'sub_incomplete',
        client_reference_id: '71', customer: 'cus_guards',
        metadata: { account_id: '71', plan: 'pro' },
      } },
    });
    assert.equal(h.account.plan, 'free');
  });
});

describe('C3 — a query parameter is not a receipt', () => {
  const priceOf = load().priceOf;
  const session = (over = {}) => ({
    id: 'cs_real', object: 'checkout.session', status: 'complete', payment_status: 'paid',
    client_reference_id: '71', customer: 'cus_guards', subscription: 'sub_paid',
    line_items: { data: [{ price: { id: priceOf('pro') } }] },
    metadata: { account_id: '71', plan: 'pro' }, ...over,
  });

  test('the dashboard exposes a server-side verifier at all', () => {
    assert.equal(typeof load().api.verifyCheckoutReturn, 'function',
      'without this the page can only be trusting ?checkout=success');
  });

  test('a forged ?checkout=success on a free account claims nothing', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    const out = await h.api.verifyCheckoutReturn(h.account, undefined);
    assert.notEqual(out.state, 'paid');
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test('a forged ?checkout=success on an ALREADY-PAID account claims nothing', async () => {
    // An existing paid plan proves an earlier payment, never THIS checkout.
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_old' }) });
    const out = await h.api.verifyCheckoutReturn(h.account, undefined);
    assert.notEqual(out.state, 'paid');
    assert.doesNotMatch(out.message, /payment received/i);
  });

  test('a real, paid, already-fulfilled session is confirmed', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    h.addSession(session());
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'paid');
    assert.equal(out.ok, true);
  });

  test('paid but not yet fulfilled reads as activating, not as live quota', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session());
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'activating');
    assert.equal(out.ok, false);
  });

  test('an unpaid session reads as pending', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session({ payment_status: 'unpaid', status: 'open', subscription: null }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'pending');
  });

  test("another account's session is refused", async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    h.addSession(session({ client_reference_id: '999', customer: 'cus_someone_else', metadata: { account_id: '999' } }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test("a SIBLING PRODUCT's paid session claims nothing here", async () => {
    // One Stripe account sells all three products and all three number their
    // accounts from 1, so a matching account id is not proof of anything.
    const h = load({ account: { stripe_customer_id: null } });
    h.addSession(session({
      customer: 'cus_of_the_other_product',
      line_items: { data: [{ price: { id: 'price_of_a_sibling_product' } }] },
    }));
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_real');
    assert.equal(out.state, 'foreign');
  });

  test('an unknown session id is unverified, never paid', async () => {
    const h = load({ account: paying({ plan: 'pro', stripe_subscription_id: 'sub_paid' }) });
    const out = await h.api.verifyCheckoutReturn(h.account, 'cs_does_not_exist');
    assert.notEqual(out.state, 'paid');
  });
});

describe(`C4 — the Checkout page says ${BRAND}, not the portfolio's name`, () => {
  test('the session carries branding_settings.display_name', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'pro');
    const args = h.calls.checkoutCreate[0].args;
    assert.equal(args.branding_settings.display_name, BRAND);
  });

  test('the success URL hands the session id back so C3 can verify it', async () => {
    const h = load({ account: { stripe_customer_id: 'cus_guards' } });
    await h.api.createCheckoutSession(h.account, 'pro');
    const args = h.calls.checkoutCreate[0].args;
    assert.match(args.success_url, /\{CHECKOUT_SESSION_ID\}/);
  });
});
