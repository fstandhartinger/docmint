'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { req, serverUp, BASE } = require('./helpers');
const {
  AGENT_UA_TOKENS, AGENT_UA_PATTERN, PUBLIC_PAGE_PATHS, increment,
} = require('../src/analytics');

/**
 * AT9 — first-party site analytics.
 *
 * Two halves. The User-Agent filter and the wiring are pure and are tested
 * here with no server and no database, so they run anywhere. The counting
 * itself is exercised against a running server exactly like the rest of this
 * suite (TEST_BASE_URL or 127.0.0.1:3000), plus TEST_OWNER_ANALYTICS_KEY
 * matching the server's OWNER_ANALYTICS_KEY — without the key the server half
 * skips gracefully, because answering 404 to the whole world is the feature,
 * not a failure.
 */

/* ------------------------------------------------------- no server needed */

test('the user-agent token list is exactly the sixteen AT9 tokens', () => {
  assert.deepEqual(
    [...AGENT_UA_TOKENS].sort(),
    [
      'bot', 'curl', 'docmint-qa', 'docmint.test', 'facebookexternalhit', 'headless', 'httpx',
      'monitor', 'node-fetch', 'okhttp', 'playwright', 'preview', 'python', 'spider', 'undici', 'wget',
    ],
  );
});

test('the user-agent pattern matches agents, crawlers and our own test runners', () => {
  const agents = [
    'curl/8.5.0',
    'python-requests/2.31.0',
    'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/120.0.0.0 Safari/537.36',
    'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    'bingbot/2.0 (+http://www.bing.com/bingbot.htm)',
    'playwright/1.46.0 (chromium)',
    'AhrefsSiteAudit/6.1 spider',
    'docmint-qa/1.0',
    'docmint.test nightly smoke runner',
  ];
  for (const ua of agents) assert.ok(AGENT_UA_PATTERN.test(ua), `must be counted as agent: ${ua}`);
  // Case-insensitivity, token by token — including the dotted test domain.
  for (const token of AGENT_UA_TOKENS) {
    assert.ok(AGENT_UA_PATTERN.test(token.toUpperCase()), `${token} must match upper-cased`);
  }
});

test('a normal desktop user-agent is never an agent', () => {
  const browsers = [
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15',
    '', // a missing User-Agent is treated as a browser, never as an agent
  ];
  for (const ua of browsers) assert.ok(!AGENT_UA_PATTERN.test(ua), `must not be an agent: "${ua}"`);
});

test('the counted page paths are exactly the AT9 public set', () => {
  assert.deepEqual(
    [...PUBLIC_PAGE_PATHS].sort(),
    [
      '/', '/carbone-alternative.html', '/docs', '/docs.html', '/docupilot-alternative.html',
      '/docxtemplater-alternative.html', '/excel-report-api.html', '/index.html', '/legal',
      '/legal.html', '/n8n-word-template.html', '/powerpoint-generation-api.html', '/privacy',
      '/privacy.html', '/terms', '/terms.html', '/word-template-api.html',
    ].sort(),
  );
});

test('the billing and signup wiring is exactly the permitted counters (C1)', () => {
  // Static evidence for the wiring AT9 allows: one counter per created checkout
  // session, one per deduplicated invoice.paid, one per successful web signup —
  // and nothing else anywhere on the billing path.
  const billing = fs.readFileSync(path.join(__dirname, '..', 'src', 'billing.js'), 'utf8');
  assert.equal(billing.match(/analytics\.increment\('trial_start'\)/g)?.length, 1);
  assert.equal(billing.match(/analytics\.increment\('paid_conversion'\)/g)?.length, 1);
  const createAt = billing.indexOf('stripe.checkout.sessions.create(payload)');
  const trialAt = billing.indexOf("analytics.increment('trial_start')");
  assert.ok(createAt > -1 && trialAt > createAt, 'trial_start counts after a created session');
  const caseAt = billing.indexOf("case 'invoice.paid':");
  const paidAt = billing.indexOf("analytics.increment('paid_conversion')");
  const nextCase = billing.indexOf('case ', paidAt);
  assert.ok(caseAt > -1 && paidAt > caseAt && (nextCase === -1 || paidAt < nextCase),
    'paid_conversion must sit inside the invoice.paid branch, after the stripe_events dedupe');
  // A shared Stripe account means this branch also receives sibling products'
  // invoices. The counter must therefore sit behind the same own-price guard
  // classifySession uses, or a support payment is booked as a DocMint sale.
  assert.equal(billing.match(/const ourInvoice = lineItems\.length === 0/g)?.length, 1,
    'invoice.paid must decide ownership from the line items');
  assert.ok(billing.indexOf('const ourInvoice = lineItems.length === 0') < paidAt
    && billing.indexOf('if (ourInvoice) {') < paidAt,
    'paid_conversion must be guarded by the own-invoice check');
  assert.equal(billing.match(/planForPriceId\(item\.price\?\.id\)/g)?.length, 2,
    'both the session and the invoice path must test the price against our plans');

  const web = fs.readFileSync(path.join(__dirname, '..', 'src', 'web.js'), 'utf8');
  assert.equal(web.match(/analytics\.increment\('signup'\)/g)?.length, 1);
  const signupAt = web.indexOf("router.post('/signup'");
  assert.ok(web.indexOf("analytics.increment('signup')") > signupAt,
    'signup counts inside the POST /signup handler');

  // C1 hard boundary: on the billing path there is no analytics usage besides
  // exactly these two counter calls — no amounts, prices, quotas or refunds
  // are touched anywhere by them.
  const billingCalls = (billing.match(/analytics\.increment\('[a-z_]+'\)/g) || []).sort();
  assert.deepEqual(billingCalls, ["analytics.increment('paid_conversion')", "analytics.increment('trial_start')"]);
});

/* --------------------------------------------------- needs a live server */

let up = null;
const OWNER_KEY = process.env.TEST_OWNER_ANALYTICS_KEY || '';

/**
 * Same `when` discipline as the rest of the suite: check inside the test,
 * never hand node:test's skip option a function. These additionally need the
 * owner key the test server was started with; without it everything 404s by
 * design, which is indistinguishable from the feature working.
 */
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  if (!OWNER_KEY) { t.skip('TEST_OWNER_ANALYTICS_KEY is not set'); return; }
  await fn(t);
});

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** The owner's readout, with the key the test server was started with. */
async function analyticsDays() {
  const { res, json } = await req('/internal/analytics', { headers: { 'X-Owner-Key': OWNER_KEY } });
  assert.equal(res.status, 200, `owner readout should answer 200 with the right key, got ${res.status}`);
  assert.ok(json && Array.isArray(json.days), 'owner readout answers {days:[...]}');
  return json.days;
}

/**
 * Today's (UTC) count for a kind, or 0 when it has not happened today. Only
 * today's row counts: falling back to an older day made the first run after
 * UTC midnight compare yesterday's total with today's fresh row.
 */
function kindN(days, kind) {
  const today = new Date().toISOString().slice(0, 10);
  const row = days.find((d) => d.kind === kind && d.day === today);
  return row ? Number(row.n) : 0;
}

const readKindN = async (kind) => kindN(await analyticsDays(), kind);

/** The counter write is fire-and-forget on the server — poll instead of racing it. */
async function pollUntil(fn, { tries = 80, delayMs = 125 } = {}) {
  for (let i = 0; i < tries; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await fn()) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return false;
}

when('the analytics table exists, because the idempotent migration booted the server', async () => {
  // serverUp() only answers on a booted DocMint, and booting runs migrate().
  // The throwaway test database is created empty, so a healthy boot IS the
  // idempotent CREATE TABLE IF NOT EXISTS having run — twice, on a redeploy.
  const days = await analyticsDays();
  assert.ok(Array.isArray(days), 'owner readout answers { days: [...] }');
});

when('a browser page view increments page_view once; agent and test traffic never counts', async () => {
  const get = (ua) => req('/', {
    headers: { Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'User-Agent': ua },
  });

  const before = await readKindN('page_view');
  const { res } = await get(BROWSER_UA);
  assert.ok(res.status < 400, `GET / from a browser should be served, got ${res.status}`);
  const counted = await pollUntil(async () => (await readKindN('page_view')) === before + 1);
  assert.ok(counted, `page_view for today should move ${before} -> ${before + 1} after one browser visit`);

  // Robots and our own test runners look at the same page; the number must not move.
  await get('curl/8.5.0');
  await get('Mozilla/5.0 HeadlessChrome/120');
  const stayed = await pollUntil(async () => (await readKindN('page_view')) !== before + 1, { tries: 6, delayMs: 100 });
  const after = await readKindN('page_view');
  assert.ok(!stayed, 'agent traffic must not move the counter');
  assert.equal(after, before + 1, `agent traffic counted: ${before} -> ${after}, expected ${before + 1}`);
});

when('a successful web signup increments signup exactly once', async () => {
  const before = await readKindN('signup');
  const email = `at9-${crypto.randomBytes(6).toString('hex')}@docmint.test`;
  const { res } = await req('/signup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent('at9-password-long-enough')}`,
  });
  // fetch follows the success redirect to the dashboard without the fresh
  // cookie and lands on the login page — 200 either way; the counter is the
  // success signal, anything >= 500 would be a server bug of its own.
  assert.ok(res.status < 500, `signup should not 5xx, got ${res.status}`);
  const counted = await pollUntil(async () => (await readKindN('signup')) >= before + 1,
    { delayMs: 100 });
  assert.ok(counted, `signup should move ${before} -> ${before + 1}`);
  const after = await readKindN('signup');
  assert.equal(after, before + 1, `one signup must count exactly once: ${before} -> ${after}`);
});

when('the owner readout answers 404 to a missing or wrong key', async () => {
  const bare = await req('/internal/analytics');
  assert.equal(bare.res.status, 404, 'no X-Owner-Key header must answer 404');
  const wrong = await req('/internal/analytics', { headers: { 'X-Owner-Key': `not-${OWNER_KEY}` } });
  assert.equal(wrong.res.status, 404, 'a wrong X-Owner-Key must answer 404');
});

when("increment('trial_start') and increment('paid_conversion') upsert once per UTC day and kind", async (t) => {
  // The checkout path itself needs Stripe secrets, so per the AT this upsert
  // proof stands in for the billing wiring — which the C1 source assertions
  // above pin down statically. Needs this test process to share the server's
  // database; the supervisor's suite runs against the throwaway DB it exports.
  if (!process.env.DATABASE_URL) {
    t.skip('DATABASE_URL is not set in the test process');
    return;
  }
  for (const kind of ['trial_start', 'paid_conversion']) {
    // eslint-disable-next-line no-await-in-loop
    const before = await readKindN(kind);
    // eslint-disable-next-line no-await-in-loop
    await increment(kind);
    // eslint-disable-next-line no-await-in-loop
    await increment(kind);
    // eslint-disable-next-line no-await-in-loop
    const ok = await pollUntil(async () => (await readKindN(kind)) === before + 2);
    assert.ok(ok, `${kind} should upsert twice onto one daily row: ${before} -> ${before + 2}`);
  }
});
