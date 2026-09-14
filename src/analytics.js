'use strict';

const crypto = require('node:crypto');

const { query } = require('./db');
const log = require('./log');

/**
 * AT9 — first-party site analytics.
 *
 * One row per UTC day per kind in `site_analytics_daily`. That is the entire
 * dataset: a date, a kind and a number. There is deliberately nothing here
 * that could name a person — no IP addresses, no user agents, no referrers, no
 * cookies, no fingerprints — and nothing is sent to any third-party analytics
 * product. The numbers exist so the operator can see whether the website works
 * and whether the service is growing; they are aggregates precisely so they
 * cannot name anyone.
 */

const KINDS = Object.freeze(['page_view', 'signup', 'trial_start', 'paid_conversion']);

/**
 * Agent and test traffic we never count. THE one list — the page-view filter
 * and the test suite both read it from this module, so they cannot drift.
 * Case-insensitive substring match against the User-Agent; a request with no
 * User-Agent header is treated as a browser, not an agent.
 */
const AGENT_UA_TOKENS = Object.freeze([
  'curl', 'python', 'playwright', 'headless', 'bot', 'spider', 'docmint-qa', 'docmint.test',
]);

const AGENT_UA_PATTERN = new RegExp(
  AGENT_UA_TOKENS.map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'),
  'i',
);

/**
 * The public pages a view counts for. Anything not in this set — the API, the
 * dashboard, Stripe, healthz, the auth pages, static assets with any other
 * extension, robots.txt, the favicon, the sitemap and the google verification
 * file — is never counted. The set is enumerated rather than excluded on
 * purpose: a new internal route can never start counting by accident.
 */
const PUBLIC_PAGE_PATHS = Object.freeze(new Set([
  '/', '/index.html',
  '/docs', '/docs.html',
  '/privacy', '/privacy.html',
  '/terms', '/terms.html',
  '/legal', '/legal.html',
  '/carbone-alternative.html',
  '/docupilot-alternative.html',
  '/docxtemplater-alternative.html',
  '/excel-report-api.html',
  '/n8n-word-template.html',
  '/powerpoint-generation-api.html',
  '/word-template-api.html',
]));

/**
 * The one upsert every kind shares.
 *
 * Never throws, and deliberately always goes through the pool rather than a
 * caller's transaction client: a failing analytics statement must never be able
 * to roll back someone else's transaction (a signup, or the Stripe webhook
 * fulfilment) — at worst the day a counter is missing is visible in the logs.
 */
async function increment(kind) {
  if (!KINDS.includes(kind)) {
    log.warn('analytics.unknown_kind', { kind });
    return;
  }
  try {
    await query(
      `INSERT INTO site_analytics_daily (day, kind, n)
       VALUES ((now() AT TIME ZONE 'UTC')::date, $1, 1)
       ON CONFLICT (day, kind) DO UPDATE SET n = site_analytics_daily.n + 1`,
      [kind],
    );
  } catch (err) {
    // Analytics must never take the thing it measures down with it: a missing
    // table or a stalled database logs a warning here, and the render, signup
    // or webhook the increment rode in on is none the wiser.
    log.warn('analytics.increment_failed', { kind, err });
  }
}

/**
 * A view worth counting: GET or HEAD of a whitelisted public page, from a
 * client that asks for HTML and does not look like an agent or our own tests.
 */
function isPageView(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  if (!PUBLIC_PAGE_PATHS.has(req.path)) return false;
  if (!String(req.get('accept') || '').toLowerCase().includes('text/html')) return false;
  return !AGENT_UA_PATTERN.test(req.get('user-agent') || '');
}

/**
 * The page-view counter, mounted before express.static. It never blocks and
 * never throws — the database write is fire-and-forget, and every error it
 * could raise is already swallowed inside increment(). The request always
 * passes through untouched.
 */
function countPageView(req, res, next) {
  try {
    if (isPageView(req)) increment('page_view');
  } catch (err) {
    (req.log || log).warn('analytics.page_view_failed', { err });
  }
  next();
}

/**
 * GET /internal/analytics — the owner's readout.
 *
 * The only credential is the X-Owner-Key header compared against
 * OWNER_ANALYTICS_KEY. It sits deliberately outside the /v1 API-key surface,
 * and anything that is not exactly right — a missing key, a wrong key, or the
 * environment variable not being set at all — gets the same 404 a typo would.
 * There is nothing here a 403 would help an attacker with, and a 403 would
 * tell them the route exists.
 */
async function ownerReadout(req, res) {
  const expected = Buffer.from(process.env.OWNER_ANALYTICS_KEY || '', 'utf8');
  const supplied = Buffer.from(req.get('x-owner-key') || '', 'utf8');
  const allowed = expected.length > 0
    && supplied.length === expected.length
    && crypto.timingSafeEqual(supplied, expected);
  if (!allowed) return res.status(404).type('text/plain').send('Not found');
  try {
    // day::text so the answer is "2026-09-14" however the pg driver happens to
    // parse DATE, and newest day first so the operator reads today first.
    const { rows } = await query(
      `SELECT day::text AS day, kind, n FROM site_analytics_daily ORDER BY day DESC, kind ASC`,
    );
    return res.json({ days: rows });
  } catch (err) {
    log.warn('analytics.readout_failed', { err });
    return res.status(500).json({ error: { code: 'analytics_unavailable' } });
  }
}

/** Convenience for hosts that want both pieces wired at one mount point. */
function mount(app) {
  app.use(countPageView);
  app.get('/internal/analytics', ownerReadout);
}

module.exports = {
  KINDS,
  AGENT_UA_TOKENS,
  AGENT_UA_PATTERN,
  PUBLIC_PAGE_PATHS,
  isPageView,
  increment,
  countPageView,
  ownerReadout,
  mount,
};
