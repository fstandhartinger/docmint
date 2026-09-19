# Visitor statistics — consent decision (decision record)

Status: **decided by the implementer; independent review pending.**
Not legal advice. Adapted from CR-67.5 — the same decision for the sibling site
benchmarkheaven.com, `/opt/model-market-comparison/ops/ux-2026-09-12/CR-67.5-CONSENT-DECISION.md` —
and bound here to the code that is actually shipped in this repository. Citations are carried
over only where they apply verbatim to this implementation.

## 1. What is implemented (the facts the decision rests on)

Code: `src/visit-stats.js` (classification, upsert, retention, report), `src/analytics.js`
(agent token list, owner readout), `src/server.js` (middleware mounts, retention timer),
`src/migrate.js` (schema). Tests: `test/visit-stats.test.js`, `test/analytics.test.js`.

| Question | Answer from the code |
|---|---|
| Storage on / active reading from the device | **None.** No cookie, `localStorage`, `sessionStorage`, script, pixel, beacon, extra request, `Accept-CH`/client hint, ETag or link decoration. The counter runs only on the server, on the page request the browser already makes for the page. (The site's separate functional storage — the dashboard session cookie `docmint_session` — is disclosed in section 2 of `/privacy` and is not read by the counter.) |
| Data used per request (in memory, then discarded) | Method, URL path, `Sec-Purpose`/`Purpose` (prefetch or prerender?), `Sec-Fetch-Dest`/`Accept` (full document load?), the `User-Agent` string (regex bot filter only, never stored), `Referer` (reduced to the host), `Sec-GPC`/`DNT` (objection). Several of these headers are optional and not sent with every request. **The IP address and forwarded-IP headers are never read.** |
| Identifiers | **None.** No IP, no hash, no salt, no fingerprint, no session or account link. Consequence: unique visitors are **not** measured — `visitReport` answers `unique_visitors: null` with a note saying why. |
| What is stored | Two tables of daily totals only, both in the first-party database. `site_analytics_daily(day, kind, n)` — the pre-existing kind counters (page_view, signup, trial_start, paid_conversion). New: `site_visit_daily(day, path, referrer_host, views, visits)` — `path` has no query string and is limited to the enumerated public pages (an unknown path is **not counted at all**; stricter than the reference's `(unknown route)` bucket, and no such bucket exists here); `referrer_host` is a host name without path or query, empty for direct/same-site traffic; "views" = counted full page loads; "visits" = page loads without a same-site referrer. |
| How it is written | One fire-and-forget upsert per counted request through the connection pool — no in-memory accumulator, nothing unwritten can linger (production traffic is ≤ ~11 page views/day, so the AT9 per-request pattern applies, not the reference's batch flush). Never inside a caller's transaction; a failing statement logs a warning and the page request carries on. |
| Where | The one Postgres database the application itself uses, in its own table, never joined with accounts, templates or usage rows. **The location is a deployment fact, proven by evidence, not by code.** Per `ops/INFRASTRUCTURE.md` and `DEPLOY.md`: the canonical host `docmint.app.mintapis.com` is served by the Coolify application `docmint` on the Sandy/Hetzner box (65.109.49.103, AS24940 Hetzner Online GmbH), and a Render web service (region Frankfurt) answers on `docmint-832s.onrender.com` from the same database; the file itself warns that the live `DATABASE_URL` must be read from the deployment before quoting a database location. This code provably only talks to the one configured `DATABASE_URL` and has no other integration — no analytics vendor. Hetzner is the hosting processor. |
| Retention | A delete of rows older than 13 months runs against **both** tables, hourly, on an unref'd timer started once per server process at boot (first run ~10 s after start; independent of traffic; idempotent — calling it twice does not double-start). A failing delete is retried on the next hourly run. |
| Output | `GET /internal/analytics?days=N` with header `X-Owner-Key` compared in constant time against `OWNER_ANALYTICS_KEY`; a missing key, a wrong key or an unset variable all get the same 404. Report (`stats` in the response, beside the legacy `days` rows): daily totals; the top 25 pages and top 25 referrer hosts with at least 3 page loads / visits in the period; and one `(other)` row each that combines every remaining row (below 3, or beyond rank 25), so the report never names a page or referrer with a single visit. `days` clamps to 1..400 (default 30). The database itself holds exact daily rows, reachable only with the database credential. |
| Agent filter | The same one list `AGENT_UA_TOKENS` in `src/analytics.js` that the kind counters use — bot, curl, docmint-qa, docmint.test, facebookexternalhit, headless, httpx, monitor, node-fetch, okhttp, playwright, preview, python, spider, undici, wget (case-insensitive substring match). **A request with no User-Agent header is counted** — the AT9 contract treats an absent header as a browser. This is a deliberate deviation from the reference, which drops missing-UA requests; recorded here because it widens what is counted. |
| Own hosts | The canonical host from `PUBLIC_URL` (`docmint.app.mintapis.com` in production), the live Render mirror `docmint-832s.onrender.com` (ops/INFRASTRUCTURE.md: two hosts, both live, one database), plus `localhost` and `127.0.0.1`. A referer whose host is in this set counts the page view but not a visit and stores no host. |
| Prefetch rules | `Sec-Purpose`/`Purpose` containing `prefetch` or `prerender` (case-insensitive) → not counted. Otherwise the request must be a full document load: `Sec-Fetch-Dest: document`, or, when that header is absent, an `Accept` that includes `text/html`. POST is never counted. |
| Objection | Requests with `Sec-GPC: 1` or `DNT: 1` are not counted. Email objection is offered in section 7 of `/privacy`; because totals cannot be traced to a person, it is answered with an explanation and the GPC/DNT route rather than a per-person deletion (stated as such on `/privacy`). |

## 2. Decision

**(a) In our assessment, no consent is required under § 25 TDDDG for exactly this configuration, and no banner is added.**

- § 25(1) TDDDG covers *storing information on* or *accessing information stored in* the terminal
  equipment. The counter stores nothing and runs nothing on the device; it only evaluates HTTP
  headers of the page request the visitor makes. LfDI Baden-Württemberg (FAQ Cookies und Tracking,
  A.3.1) states that IP address and User-Agent sent automatically are not an "access" under § 25 and
  names local log analysis without third parties, data-minimal configuration and no merging of
  usage data as the model for consent-free reach measurement — this implementation is stricter than
  that model (no IP at all, immediate aggregation to daily totals, no access-log rows for page
  views).
- DSK *OH Digitale Dienste* v1.2 (Nov 2024) keeps active reading via JavaScript and server-side
  fingerprint hashes (Rn. 23–24) as access; neither happens here. Rn. 88 names "bei jedem Abruf
  einer Seite den Zähler für diese Seite um Eins zu erhöhen" as the plain counting case — which is
  what this counter does, per page path and referring host.
- EDPB Guidelines 2/2023 v2.0 (paras. 43, 54–55) bring header/IP-based **tracking and
  fingerprinting** into Art. 5(3) ePD. No identifier is derived and no visitor is recognised or
  tracked, which puts this counter outside those examples. This is why a daily IP+UA hash for
  counting unique visitors was **not** built.
- **Residual uncertainty (stated, not hidden):** the EDPB reading of "access" is broad, and DSK
  v1.2 Rn. 89–90 says reach measurement must be judged per configuration and is "nicht per se"
  part of the base service. The conclusion is therefore our documented assessment for exactly this
  configuration, and `/privacy` words the counting factually; it does not overstate certainty. If a
  supervisory authority or court treats header evaluation as access requiring consent, the fallback
  is to switch the counter off (remove the middleware call in `src/server.js`), not to add a
  banner.
- GDPR: the persisted daily totals relate to no identifiable person. The transient processing of
  the request headers rests on Art. 6(1)(f) (own reach and capacity insight; no profile, no third
  party, reasonable expectation), with Art. 13 information on `/privacy` (sections 2 and 7) and the
  Art. 21 objection route offered there by email.

**(b) Existing browser storage (outside the counter, checked for completeness):** for anonymous
visitors the site sets nothing and reads nothing; while signed in to the dashboard, one session
cookie (`docmint_session`, HttpOnly, SameSite=Lax) holds state the visitor needs for the function
they use, is disclosed in section 2 of `/privacy`, and is covered by § 25(2) Nr. 2 TDDDG. None of
it is read by the counter.

## 3. Conditions that would reopen this decision

Adding any of the following makes the statistics consent-relevant or needs a new record:
client-side script/beacon, a cookie or any storage for statistics, any IP-derived or hashed key
(unique visitors), `Accept-CH`, full referrer URLs or query strings, an external analytics
provider, joining statistics with accounts or usage rows, longer retention.

## 4. Technical proof (for the verifier)

1. `node --test --test-concurrency=1 test/analytics.test.js test/visit-stats.test.js` — the exact
   agent token list; classification (POST, Sec-GPC/DNT, prefetch/prerender, non-document requests,
   every agent token, the five path aliases, static assets and unknown paths not counted, referer
   reduction with www-strip, truncation, own-host and no-referer cases); the no-identifier upsert
   shape (`ON CONFLICT (day, path, referrer_host)`, views=1, visits 0/1) with a failed write
   swallowed; retention deletes on both tables with the 13-month interval and a failing delete
   swallowed; the folded report (rows below 3 and beyond rank 25 in `(other)`, zero-visit
   referrers dropped, days clamped, `unique_visitors: null`); timer idempotence.
2. The server half of `test/analytics.test.js` against a running server: `/internal/analytics`
   answers 404 without or with a wrong key, 200 with the right key, and page-view counting works
   live. It skips documented when no server or no owner key is configured.
3. The removal of the two stale "no referrers" claims from `/privacy` (lines ~61 and ~119
   before this change) was verified by direct grep of `public/privacy.html` — no referrer
   fragment from the old copy remains; `test/public-copy-honesty.test.js`'s STALE list,
   which pins other `/privacy` claims, does **not** contain a referrer-related fragment, so
   this specific removal is pinned by that grep here, not by the honesty test.
4. Location: on-record per `ops/INFRASTRUCTURE.md` and `DEPLOY.md` (Coolify `docmint` on the
   Sandy/Hetzner host; Render Frankfurt instance sharing the database) — a deployment fact, not
   proven by code, and not checked by the automated tests.
