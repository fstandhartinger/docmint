'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

/**
 * visit-stats — pure unit tests. No server, no database.
 *
 * classifyRequest sees hand-built request objects, the report and the
 * retention get an injected query function, and the pieces that read src/db
 * and src/config at load time get stubbed require caches — installed before
 * the module under test is first required, because that is the only seam a
 * module leaves open when it takes its executor from ./db and its zone from
 * ./config, exactly like src/analytics.js does. Nothing here needs
 * DATABASE_URL, so this file never skips.
 */

/* Replace ./db in the require cache before anything pulls it in. */
const dbPath = require.resolve('../src/db');
const dbCalls = [];
let failNextQuery = false;
require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async (text, params) => {
      if (failNextQuery) throw new Error('database unreachable (stubbed)');
      dbCalls.push({ text, params });
      return { rows: [] };
    },
    pool: { on: () => {} },
    tx: async () => { throw new Error('tx is not used by visit-stats'); },
  },
};

/* Replace ./config the same way ./db is replaced, with the canonical PUBLIC_URL
   both live hosts are configured with (ops/INFRASTRUCTURE.md): the module under
   test then derives its own zone at load time through the real derivation path,
   independent of the ambient environment. */
const configPath = require.resolve('../src/config');
const CONFIG_PUBLIC_URL = 'https://docmint.app.mintapis.com';
function configStub(publicUrl) {
  return {
    id: configPath,
    filename: configPath,
    loaded: true,
    exports: { config: { publicUrl } },
  };
}
require.cache[configPath] = configStub(CONFIG_PUBLIC_URL);

const { AGENT_UA_TOKENS } = require('../src/analytics');
const log = require('../src/log');
const visitStats = require('../src/visit-stats');

/** A minimal stand-in for an Express request: req.get is case-insensitive. */
function fakeReq({ method = 'GET', path = '/', headers = {} } = {}) {
  const lower = {};
  for (const [k, v] of Object.entries(headers)) lower[k.toLowerCase()] = v;
  return {
    method,
    path,
    get(name) {
      const key = name.toLowerCase();
      return Object.hasOwn(lower, key) ? lower[key] : null;
    },
  };
}

const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'user-agent': BROWSER_UA,
};

/** Temporarily silence and count log.warn, so failure paths are provable without log noise. */
async function withSilentWarn(fn) {
  const originalWarn = log.warn;
  let warned = 0;
  log.warn = () => { warned += 1; };
  try {
    return { result: await fn(), warned };
  } finally {
    log.warn = originalWarn;
  }
}

/* ------------------------------------------------------ classifyRequest */

test('a plain browser GET of / counts as a view and a visit, with no referrer', () => {
  assert.deepEqual(visitStats.classifyRequest(fakeReq({ headers: BROWSER_HEADERS })), {
    path: '/', referrerHost: '', visit: true,
  });
});

test('POST is never counted', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ method: 'POST', headers: BROWSER_HEADERS })), null);
});

test('Sec-GPC: 1 honours the objection', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ headers: { ...BROWSER_HEADERS, 'sec-gpc': '1' } })), null);
});

test('DNT: 1 honours the objection', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ headers: { ...BROWSER_HEADERS, dnt: '1' } })), null);
});

test('Purpose: prefetch is never counted', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ headers: { ...BROWSER_HEADERS, purpose: 'prefetch' } })), null);
});

test('Sec-Purpose: prerender is never counted', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ headers: { ...BROWSER_HEADERS, 'sec-purpose': 'prerender' } })), null);
});

test('Sec-Fetch-Dest: image is not a page load', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ headers: { ...BROWSER_HEADERS, 'sec-fetch-dest': 'image' } })), null);
});

test('with Sec-Fetch-Dest: document the Accept header does not matter', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, 'sec-fetch-dest': 'document', accept: '*/*' },
  }));
  assert.equal(hit.path, '/');
});

test('a missing User-Agent counts — the AT9 contract: an absent header is a browser', () => {
  const { 'user-agent': _ua, ...withoutUA } = BROWSER_HEADERS;
  const hit = visitStats.classifyRequest(fakeReq({ headers: withoutUA }));
  assert.ok(hit, 'a request with no User-Agent must not be filtered as an agent');
  assert.equal(hit.path, '/');
});

test('every token of the one agent list filters, case-insensitively', () => {
  for (const token of AGENT_UA_TOKENS) {
    const hit = visitStats.classifyRequest(fakeReq({
      headers: { ...BROWSER_HEADERS, 'user-agent': `Mozilla/5.0 ${token.toUpperCase()}/1.0` },
    }));
    assert.equal(hit, null, `${token} must be counted as an agent`);
  }
});

test('the .html aliases normalise onto the canonical paths', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/index.html', headers: BROWSER_HEADERS })).path, '/');
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/docs.html', headers: BROWSER_HEADERS })).path, '/docs');
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/privacy.html', headers: BROWSER_HEADERS })).path, '/privacy');
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/terms.html', headers: BROWSER_HEADERS })).path, '/terms');
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/legal.html', headers: BROWSER_HEADERS })).path, '/legal');
});

test('the five aliases are exactly the specified mapping', () => {
  assert.deepEqual({ ...visitStats.PAGE_ALIASES }, {
    '/index.html': '/',
    '/docs.html': '/docs',
    '/privacy.html': '/privacy',
    '/terms.html': '/terms',
    '/legal.html': '/legal',
  });
});

test('static assets and unknown paths are not counted at all', () => {
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/landing.css', headers: BROWSER_HEADERS })), null);
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/wp-admin', headers: BROWSER_HEADERS })), null);
  assert.equal(visitStats.classifyRequest(fakeReq({ path: '/v1/render', headers: BROWSER_HEADERS })), null);
});

test('a foreign referer is reduced to its host, www-stripped, and counts a visit', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://WWW.Example.COM/x/y?z=1' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: 'example.com', visit: true });
});

test('the site itself is same-site: no host stored, no visit counted', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://docmint.app.mintapis.com/docs' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false });
});

test('the live Render mirror is same-site too: ops/INFRASTRUCTURE.md names two live hosts', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://docmint-832s.onrender.com/docs' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false });
});

/* ------------------------------------------------- own-zone rule (AT-V1) */

test('a sibling subdomain of our own zone is own traffic: view counted, visit not, no host stored', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://foo.com.mintapis.com/spam' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false });
});

test('the bare zone itself counts as own traffic', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://mintapis.com/' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false });
});

test('a www. referrer of the zone is own too — www is stripped before the zone test', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://www.mintapis.com/' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false });
});

test('a lookalike host under a foreign zone is still a foreign visit, with the host stored', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://mintapis.com.evil.test/' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: 'mintapis.com.evil.test', visit: true });
});

test('a lookalike that merely contains the zone as a substring is foreign too', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://evilmintapis.com/' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: 'evilmintapis.com', visit: true });
});

test('a sibling subdomain of onrender.com is not ours — the residual pin — and stores the host', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://something-else.onrender.com/' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: 'something-else.onrender.com', visit: true });
});

test('regression: canonical host, Render mirror and localhost still classify as own', () => {
  for (const host of ['docmint.app.mintapis.com', 'docmint-832s.onrender.com', 'localhost', '127.0.0.1']) {
    const hit = visitStats.classifyRequest(fakeReq({
      headers: { ...BROWSER_HEADERS, referer: `https://${host}/docs` },
    }));
    assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false }, host);
  }
});

test('an unparseable referer counts a visit without a host', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'not a url at all' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: true });
});

test('a very long referer host is truncated to 100 characters', () => {
  const hit = visitStats.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: `https://${'a'.repeat(150)}.example.com/page` },
  }));
  assert.equal(hit.referrerHost.length, 100);
  assert.equal(hit.visit, true);
});

/* ---------------------------------------------------------- countVisit */

test('countVisit records a counted request and always lets the request pass', () => {
  dbCalls.length = 0;
  let nexted = 0;
  visitStats.countVisit(fakeReq({ headers: BROWSER_HEADERS }), {}, () => { nexted += 1; });
  assert.equal(nexted, 1);
  assert.equal(dbCalls.length, 1);
});

test('countVisit swallows a classification failure and still calls next', async () => {
  dbCalls.length = 0;
  let nexted = 0;
  // A GET with no req.get at all makes classifyRequest throw inside the middleware.
  const { warned } = await withSilentWarn(() => visitStats.countVisit({ method: 'GET', path: '/' }, {}, () => { nexted += 1; }));
  assert.equal(nexted, 1, 'the request must pass through untouched');
  assert.equal(dbCalls.length, 0);
  assert.ok(warned >= 1, 'the failure must be warned, not raised');
});

/* ----------------------------------------------------------- recordVisit */

test('recordVisit upserts one daily row with views=1 and visits 0 or 1', async () => {
  dbCalls.length = 0;
  await visitStats.recordVisit({ path: '/docs', referrerHost: 'example.com', visit: true });
  await visitStats.recordVisit({ path: '/', referrerHost: '', visit: false });
  assert.equal(dbCalls.length, 2);
  const [withHost, withoutHost] = dbCalls;
  assert.ok(withHost.text.includes('INSERT INTO site_visit_daily'));
  assert.ok(withHost.text.includes("VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2, 1, $3)"));
  assert.ok(withHost.text.includes('ON CONFLICT (day, path, referrer_host)'));
  assert.ok(withHost.text.includes('site_visit_daily.views + 1'));
  assert.ok(withHost.text.includes('site_visit_daily.visits + EXCLUDED.visits'));
  assert.deepEqual(withHost.params, ['/docs', 'example.com', 1]);
  assert.deepEqual(withoutHost.params, ['/', '', 0]);
});

test('a failing recordVisit is swallowed and warned, never thrown', async () => {
  failNextQuery = true;
  const { warned } = await withSilentWarn(() => visitStats.recordVisit({ path: '/', referrerHost: '', visit: true }));
  failNextQuery = false;
  assert.ok(warned >= 1, 'the failure must be warned, not raised');
});

/* ---------------------------------------------------- applyRetention */

test('applyRetention deletes 13-month-old rows from both tables', async () => {
  const statements = [];
  await visitStats.applyRetention((text) => {
    statements.push(text);
    return Promise.resolve({ rows: [] });
  });
  assert.equal(statements.length, 2);
  assert.ok(statements[0].includes('DELETE FROM site_visit_daily'), statements[0]);
  assert.ok(statements[0].includes("interval '13 months'"), statements[0]);
  assert.ok(statements[1].includes('DELETE FROM site_analytics_daily'), statements[1]);
  assert.ok(statements[1].includes("interval '13 months'"), statements[1]);
});

test('a failing retention delete is swallowed and warned, never thrown', async () => {
  const { warned } = await withSilentWarn(() => visitStats.applyRetention(() => Promise.reject(new Error('db down'))));
  assert.ok(warned >= 1, 'the failure must be warned, not raised');
});

/* -------------------------------------------------- startRetentionTimer */

test('startRetentionTimer is idempotent — calling it twice does not start two timers', () => {
  const originalSetInterval = global.setInterval;
  const originalSetTimeout = global.setTimeout;
  let intervals = 0;
  let timeouts = 0;
  global.setInterval = (...args) => { intervals += 1; return originalSetInterval(...args); };
  global.setTimeout = (...args) => { timeouts += 1; return originalSetTimeout(...args); };
  try {
    visitStats.startRetentionTimer();
    visitStats.startRetentionTimer();
  } finally {
    global.setInterval = originalSetInterval;
    global.setTimeout = originalSetTimeout;
  }
  assert.equal(intervals, 1, 'exactly one hourly timer may exist');
  assert.equal(timeouts, 1, 'exactly one first run may be scheduled');
});

/* ----------------------------------------------------------- visitReport */

/** A query function that answers the report's three statements from seeded rows. */
function reportStubQuery({ dailyRows, pageRows, referrerRows }) {
  return (text) => {
    if (/GROUP BY referrer_host/.test(text)) return Promise.resolve({ rows: referrerRows });
    if (/GROUP BY path/.test(text)) return Promise.resolve({ rows: pageRows });
    if (/GROUP BY day/.test(text)) return Promise.resolve({ rows: dailyRows });
    return Promise.reject(new Error(`unexpected query in test: ${text}`));
  };
}

function seededStub() {
  // 27 pages above the threshold (views 29..3, ranks 1..27) plus one 2-view page.
  const pageRows = [];
  for (let i = 1; i <= 27; i += 1) pageRows.push({ path: `/p${i}`, views: 30 - i, visits: 2 });
  pageRows.push({ path: '/small', views: 2, visits: 1 });
  return reportStubQuery({
    dailyRows: [
      { day: '2026-09-18', views: 10, visits: 4 },
      { day: '2026-09-19', views: 5, visits: 2 },
    ],
    pageRows,
    referrerRows: [
      { referrer_host: 'a.example', visits: 5 },
      { referrer_host: 'b.example', visits: 0 },
      { referrer_host: 'c.example', visits: 3 },
      { referrer_host: 'd.example', visits: 1 },
    ],
  });
}

test('visitReport sums the daily rows into totals', async () => {
  const report = await visitStats.visitReport(seededStub(), 30);
  assert.equal(report.days, 30);
  assert.deepEqual(report.totals, { views: 15, visits: 6 });
  assert.equal(report.daily.length, 2);
  assert.deepEqual(report.daily[0], { day: '2026-09-18', views: 10, visits: 4 });
  assert.deepEqual(report.daily[1], { day: '2026-09-19', views: 5, visits: 2 });
});

test('visitReport folds a page below the threshold into (other)', async () => {
  const report = await visitStats.visitReport(seededStub(), 30);
  const other = report.top_pages[report.top_pages.length - 1];
  assert.deepEqual(other, { path: '(other)', views: 9, visits: 5 });
  assert.ok(!report.top_pages.some((r) => r.path === '/small'), 'a 2-view page must not be named');
  assert.equal(report.top_pages[0].path, '/p1');
  assert.equal(report.top_pages[0].views, 29);
});

test('visitReport folds ranks beyond 25 into the same (other) row', async () => {
  const report = await visitStats.visitReport(seededStub(), 30);
  // 27 pages above the threshold: 25 shown, /p26 and /p27 fold (4+3 views).
  assert.equal(report.top_pages.length, 26, '25 shown pages plus one (other) row');
  assert.ok(!report.top_pages.some((r) => r.path === '/p26'), 'rank 26 must fold');
  assert.ok(!report.top_pages.some((r) => r.path === '/p27'), 'rank 27 must fold');
});

test('visitReport drops referrers with zero visits and folds the rest below the threshold', async () => {
  const report = await visitStats.visitReport(seededStub(), 30);
  assert.deepEqual(report.top_referrers, [
    { referrer_host: 'a.example', visits: 5 },
    { referrer_host: 'c.example', visits: 3 },
    { referrer_host: '(other)', visits: 1 },
  ]);
});

test('visitReport clamps days to 1..400 with a default of 30', async () => {
  assert.equal((await visitStats.visitReport(seededStub(), 0)).days, 30);
  assert.equal((await visitStats.visitReport(seededStub(), 9999)).days, 400);
  assert.equal((await visitStats.visitReport(seededStub())).days, 30);
  assert.equal((await visitStats.visitReport(seededStub(), '7')).days, 7);
  assert.equal((await visitStats.visitReport(seededStub(), 'nonsense')).days, 30);
  assert.equal((await visitStats.visitReport(seededStub(), -5)).days, 1);
});

test('visitReport answers unique_visitors: null with the reason', async () => {
  const report = await visitStats.visitReport(seededStub(), 30);
  assert.equal(report.unique_visitors, null);
  assert.ok(typeof report.unique_visitors_note === 'string' && /identifier/i.test(report.unique_visitors_note),
    'the note must say that counting unique visitors would need an identifier');
});

/* ------------------------------------------- own-zone derivation (the seam) */

/**
 * The zone is fixed at module load, so its derivation can only be proven by
 * re-requiring the module with a different ./config — the same require-cache
 * seam the db stub at the top of this file uses. Every classification test
 * above already runs against the canonical PUBLIC_URL stub; these pin the
 * derivation itself and the missing/malformed fallback. They sit last so the
 * swapped cache cannot disturb the other sections.
 */
function freshVisitStatsWithConfig(publicUrl) {
  require.cache[configPath] = configStub(publicUrl);
  delete require.cache[require.resolve('../src/visit-stats')];
  return require('../src/visit-stats');
}

test('OWN_ZONE is the last two labels of the canonical PUBLIC_URL host, derived at module load', () => {
  const fresh = freshVisitStatsWithConfig(CONFIG_PUBLIC_URL);
  assert.equal(fresh.OWN_ZONE, 'mintapis.com');
  const hit = fresh.classifyRequest(fakeReq({
    headers: { ...BROWSER_HEADERS, referer: 'https://foo.com.mintapis.com/' },
  }));
  assert.deepEqual(hit, { path: '/', referrerHost: '', visit: false });
});

test('a missing PUBLIC_URL falls back to the literal production zone', () => {
  const fresh = freshVisitStatsWithConfig('');
  assert.equal(fresh.OWN_ZONE, 'mintapis.com');
  assert.deepEqual(
    fresh.classifyRequest(fakeReq({ headers: { ...BROWSER_HEADERS, referer: 'https://foo.com.mintapis.com/' } })),
    { path: '/', referrerHost: '', visit: false },
  );
});

test('a malformed PUBLIC_URL falls back to the literal production zone too', () => {
  const fresh = freshVisitStatsWithConfig('::: not a url :::');
  assert.equal(fresh.OWN_ZONE, 'mintapis.com');
});

test('a single-label PUBLIC_URL host cannot yield a zone — the fallback wins', () => {
  const fresh = freshVisitStatsWithConfig('https://docmintapp');
  assert.equal(fresh.OWN_ZONE, 'mintapis.com');
});
