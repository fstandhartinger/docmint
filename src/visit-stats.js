'use strict';

const { query } = require('./db');
const log = require('./log');
const { config } = require('./config');
const { AGENT_UA_PATTERN, PUBLIC_PAGE_PATHS } = require('./analytics');

/**
 * Visitor statistics, beside the AT9 kind counters in analytics.js.
 *
 * One row per UTC day, per public page path and per referring host in
 * `site_visit_daily`. "views" counts the page loads the server actually
 * served — including traffic that is not a site entry, such as navigations
 * from our own domain zone. "visits" is the visitor-side metric: page loads
 * that entered the site from outside our own domain zone (the earlier
 * same-site definition is replaced by this zone-based one), including direct
 * loads with no referrer at all. The operator report is judged on `visits`
 * and on the delta of the two, never on `views` alone.
 *
 * A referrer host belongs to our own domain zone when it is the zone itself
 * or any subdomain of it: `docmint.app.mintapis.com` and zone-squatting
 * siblings like `foo.com.mintapis.com` are our own traffic, while lookalikes
 * outside the zone (`mintapis.com.evil.test`, `evilmintapis.com`) stay
 * foreign. The zone is derived ONCE at module load from the canonical
 * PUBLIC_URL's host, by taking its last two labels ("mintapis.com") — the
 * same canonical URL both live hosts are configured with, so the Render
 * mirror classifies exactly like the canonical host, whichever host serves
 * the request; the request's Host header is never read, and a missing or
 * malformed PUBLIC_URL falls back to the literal production zone. Exact
 * hosts the zone rule cannot cover stay in OWN_HOSTS: the live Render mirror
 * (a sibling subdomain of onrender.com, which is not our zone — so its other
 * subdomains still count as foreign) and local use. Own traffic counts the
 * view but not a visit and stores no referrer host.
 *
 * The server counts the page requests it delivers anyway. Nothing is written
 * to or read from the visitor's device (no cookie, storage, script, pixel or
 * client hint), and no identifier is derived — no IP, no hash, no fingerprint — so unique visitors
 * are deliberately not measured and nothing here could name a person. What is
 * deliberately NOT stored: IP addresses, the user-agent string (read only to
 * filter agents), full referrer URLs (only the host, never a path or query),
 * query strings, and anything per person. Requests carrying Sec-GPC: 1 or
 * DNT: 1 are not counted at all, and unknown paths are not counted at all —
 * the public page set is enumerated, not excluded, so there is no
 * "(unknown route)" bucket to fill.
 *
 * The upsert and retention follow src/analytics.js exactly: never throws,
 * always through the pool, never inside a caller's transaction — at worst a
 * day's row is missing and the log says so.
 */

/** Rows older than this are deleted, hourly, from both daily tables. */
const RETENTION_MONTHS = 13;

/** The report never shows a page or referrer row with fewer page loads than this (no single-visit facts). */
const MIN_REPORT_COUNT = 3;

/**
 * The .html spellings of the homepage and the four content pages collapse onto
 * their canonical path, so one page is one row rather than two. Everything
 * else is counted exactly as the request came in.
 */
const PAGE_ALIASES = Object.freeze({
  '/index.html': '/',
  '/docs.html': '/docs',
  '/privacy.html': '/privacy',
  '/terms.html': '/terms',
  '/legal.html': '/legal',
});

/**
 * The own domain zone, fixed at module load: the last two labels of the
 * canonical PUBLIC_URL's host ("mintapis.com"). Both live hosts are
 * configured with the same canonical PUBLIC_URL (ops/INFRASTRUCTURE.md), so
 * the zone is independent of which host serves the request and is never
 * derived from the request's Host header or from a mirror-style URL. A
 * missing or malformed PUBLIC_URL falls back to the literal production zone
 * rather than guessing.
 */
const FALLBACK_ZONE = 'mintapis.com';

const OWN_ZONE = (() => {
  if (!config.publicUrl) return FALLBACK_ZONE;
  try {
    const labels = new URL(config.publicUrl).hostname.toLowerCase().replace(/^www\./, '').split('.');
    return labels.length >= 2 ? labels.slice(-2).join('.') : FALLBACK_ZONE;
  } catch {
    return FALLBACK_ZONE; // a malformed PUBLIC_URL must not stop the module from loading
  }
})();

/** H is own when it is the zone itself or any subdomain of it. */
function isOwnZoneHost(host) {
  return host === OWN_ZONE || host.endsWith(`.${OWN_ZONE}`);
}

/**
 * Exact hosts that count as own even though the zone rule does not cover
 * them: the live Render mirror (ops/INFRASTRUCTURE.md: two hosts, both live,
 * one database — it is a subdomain of onrender.com, which is not our zone, so
 * its sibling subdomains still count as foreign) and local use. Referers from
 * these hosts, like every own-zone referer, count the page view but not a
 * visit and store no host.
 */
const OWN_HOSTS = new Set(['docmint.app.mintapis.com', 'docmint-832s.onrender.com', 'localhost', '127.0.0.1']);

/**
 * Decide whether one incoming request is a page load worth counting.
 *
 * The order mirrors the decision record: method, then the visitor's objection,
 * then prefetch, then what kind of request it is, then agents, then the path,
 * and only then the referer. Returns { path, referrerHost, visit } or null for
 * anything that must not be counted.
 */
function classifyRequest(req) {
  if (req.method !== 'GET') return null;

  // Objection signals the browser already sends: Global Privacy Control and Do
  // Not Track. A visitor who says "do not track me" is not counted, full stop.
  if (req.get('sec-gpc') === '1' || req.get('dnt') === '1') return null;

  // A browser prefetching or prerendering the document is not a person reading it.
  if (/prefetch|prerender/i.test(`${req.get('sec-purpose') || ''} ${req.get('purpose') || ''}`)) return null;

  // Full document loads only: stylesheets, images, XHR and API calls are not views.
  const dest = req.get('sec-fetch-dest');
  if (dest ? dest !== 'document' : !String(req.get('accept') || '').toLowerCase().includes('text/html')) return null;

  // Agent traffic is filtered by the one AT9 list in analytics.js. A MISSING
  // user-agent counts: that is the AT9 contract — an absent header is treated
  // as a browser, never as an agent.
  const ua = req.get('user-agent') || '';
  if (ua && AGENT_UA_PATTERN.test(ua)) return null;

  // Only enumerated public pages are counted. A scanner or a typo lands on
  // nothing at all, never on a bucket.
  const path = PAGE_ALIASES[req.path] || req.path;
  if (!PUBLIC_PAGE_PATHS.has(path)) return null;

  // The referer is reduced to its host and kept only when it came from
  // outside our own domain zone; own-zone and direct traffic count without a
  // host. A sibling subdomain of the zone (foo.com.mintapis.com) is own, a
  // lookalike outside the zone (mintapis.com.evil.test) is foreign.
  let refHost = null;
  try {
    refHost = new URL(req.get('referer') || '').hostname.toLowerCase().replace(/^www\./, '');
  } catch { /* a missing or unparseable referer is simply "no host" */ }

  if (refHost === null) return { path, referrerHost: '', visit: true };
  if (OWN_HOSTS.has(refHost) || isOwnZoneHost(refHost)) return { path, referrerHost: '', visit: false };
  return { path, referrerHost: refHost.slice(0, 100), visit: true };
}

/**
 * The one upsert every counted view shares, modeled on analytics.increment:
 * fire-and-forget through the pool, never inside a caller's transaction — a
 * failing statement logs a warning and the page request carries on untouched.
 */
async function recordVisit(hit) {
  try {
    await query(
      `INSERT INTO site_visit_daily (day, path, referrer_host, views, visits)
       VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, 1, $3)
       ON CONFLICT (day, path, referrer_host) DO UPDATE SET
         views  = site_visit_daily.views + 1,
         visits = site_visit_daily.visits + EXCLUDED.visits`,
      [hit.path, hit.referrerHost, hit.visit ? 1 : 0],
    );
  } catch (err) {
    log.warn('visit_stats.record_failed', { err });
  }
}

/**
 * The visitor counter, mounted before express.static next to countPageView. It
 * never blocks and never throws — the classification and the write are both
 * guarded, and the request always passes through untouched.
 */
function countVisit(req, res, next) {
  try {
    const hit = classifyRequest(req);
    if (hit) recordVisit(hit);
  } catch (err) {
    (req.log || log).warn('visit_stats.count_failed', { err });
  }
  next();
}

/** Both daily tables age out on the same schedule. */
const RETENTION_STATEMENTS = Object.freeze([
  Object.freeze({
    table: 'site_visit_daily',
    sql: `DELETE FROM site_visit_daily WHERE day < ((now() AT TIME ZONE 'UTC')::date - interval '${RETENTION_MONTHS} months')`,
  }),
  Object.freeze({
    table: 'site_analytics_daily',
    sql: `DELETE FROM site_analytics_daily WHERE day < ((now() AT TIME ZONE 'UTC')::date - interval '${RETENTION_MONTHS} months')`,
  }),
]);

/**
 * Delete rows older than the retention period from both tables. Never throws:
 * an unreachable database must not become an unhandled rejection an hour
 * later, and a statement that fails now is simply retried on the next run.
 */
async function applyRetention(queryFn = query) {
  for (const { table, sql } of RETENTION_STATEMENTS) {
    try {
      await queryFn(sql);
    } catch (err) {
      log.warn('visit_stats.retention_failed', { table, err });
    }
  }
}

/**
 * Run the retention delete ~10 s after boot and then hourly, independent of
 * traffic. Both timers are unref'd so they never hold a process open, and the
 * start is idempotent: several entry points may call it, one timer is the most
 * that may exist.
 */
let hourlyTimer = null;

function startRetentionTimer() {
  if (hourlyTimer) return;
  const firstRun = setTimeout(applyRetention, 10000);
  firstRun.unref();
  hourlyTimer = setInterval(applyRetention, 60 * 60 * 1000);
  hourlyTimer.unref();
}

/**
 * The aggregate report for the owner readout. Pure against an injected query
 * function, so it is testable without a database. `days` clamps to 1..400 with
 * a default of 30. Pages and referrers below MIN_REPORT_COUNT page loads — and
 * ranks beyond 25 — fold into one "(other)" row each, so the report never
 * names a page or referrer with a single visit. Referrers are listed only when
 * a visit actually came from them.
 */
async function visitReport(queryFn, days = 30) {
  const n = Math.max(1, Math.min(400, Math.floor(Number(days) || 30)));
  const since = `((now() AT TIME ZONE 'UTC')::date - ${n - 1})`;
  // day::text so the answer is "2026-09-14" however the pg driver happens to
  // parse DATE — the same choice the legacy readout makes.
  const [daily, pages, referrers] = await Promise.all([
    queryFn(
      `SELECT day::text AS day, sum(views)::int AS views, sum(visits)::int AS visits
       FROM site_visit_daily WHERE day >= ${since} GROUP BY day ORDER BY day`,
    ),
    queryFn(
      `SELECT path, sum(views)::int AS views, sum(visits)::int AS visits
       FROM site_visit_daily WHERE day >= ${since} GROUP BY path ORDER BY views DESC`,
    ),
    queryFn(
      `SELECT referrer_host, sum(visits)::int AS visits
       FROM site_visit_daily WHERE day >= ${since} AND referrer_host <> ''
       GROUP BY referrer_host ORDER BY visits DESC`,
    ),
  ]);

  const fold = (rows, countKey, label, keys) => {
    const shown = rows.filter((r) => r[countKey] >= MIN_REPORT_COUNT).slice(0, 25);
    const rest = rows.filter((r) => !shown.includes(r));
    if (!rest.length) return shown;
    const other = { [label]: '(other)' };
    for (const k of keys) other[k] = rest.reduce((acc, r) => acc + r[k], 0);
    return [...shown, other];
  };

  const sum = (key) => daily.rows.reduce((acc, r) => acc + r[key], 0);
  return {
    days: n,
    unique_visitors: null,
    unique_visitors_note: 'Not measured: counting unique visitors would need an identifier (cookie, IP or hash), and no identifier exists here.',
    totals: { views: sum('views'), visits: sum('visits') },
    daily: daily.rows,
    top_pages: fold(pages.rows, 'views', 'path', ['views', 'visits']),
    top_referrers: fold(referrers.rows.filter((r) => r.visits > 0), 'visits', 'referrer_host', ['visits']),
  };
}

module.exports = {
  RETENTION_MONTHS,
  MIN_REPORT_COUNT,
  PAGE_ALIASES,
  OWN_ZONE,
  classifyRequest,
  recordVisit,
  countVisit,
  applyRetention,
  startRetentionTimer,
  visitReport,
};
