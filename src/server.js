'use strict';

const express = require('express');
const path = require('node:path');

const { config } = require('./config');
const { ApiError } = require('./errors');
const { migrate } = require('./migrate');
const { query, pool } = require('./db');
const api = require('./api');
const jobs = require('./jobs');
const pdf = require('./pdf');
const billing = require('./billing');
const web = require('./web');
const log = require('./log');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

/**
 * Every request gets an id, and the id goes back in a header and into every log
 * line the request produces. Support for this API is going to be someone pasting
 * an error into an issue; the id is what turns that into a single grep.
 */
app.use((req, res, next) => {
  req.id = log.newRequestId();
  req.log = log.child({ req: req.id });
  res.set('X-DocMint-Request-Id', req.id);
  const started = Date.now();
  res.on('finish', () => {
    if (req.path === '/healthz') return;
    req.log.info('http', {
      status: res.statusCode, method: req.method, path: req.route?.path || req.path,
      ms: Date.now() - started, bytes: Number(res.get('content-length') || 0),
    });
  });
  next();
});

/**
 * A deployment that is not the one customers are sent to must not compete with
 * the one that is. Set NOINDEX=1 on a staging or migration instance and every
 * response carries X-Robots-Tag: noindex, so a crawler that stumbles onto the
 * infrastructure hostname does not file it as a duplicate of the real site.
 *
 * Off by default: production must never be able to hide itself by accident.
 */
if (process.env.NOINDEX === '1') {
  app.use((req, res, next) => {
    res.set('X-Robots-Tag', 'noindex, nofollow');
    next();
  });
}

/**
 * One page, one URL. If DocMint ever answers on a second hostname — a real
 * domain in front of the Render one — a search engine would otherwise see two
 * copies of every page and have to guess. Browsers get a 301 to whatever
 * PUBLIC_URL says is the real host.
 *
 * Only GET and HEAD, and never on the API surface: the Stripe webhook, the n8n
 * node and every hosted-file link were issued against the host the caller
 * already had, and a redirect would break them.
 */
const CANONICAL_HOST = config.publicUrl ? new URL(config.publicUrl).host : '';
const NEVER_REDIRECT = ['/v1/', '/stripe/', '/f/', '/healthz'];

app.use((req, res, next) => {
  if (!CANONICAL_HOST) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (NEVER_REDIRECT.some((p) => req.path === p || req.path.startsWith(p))) return next();
  const host = (req.get('host') || '').toLowerCase();
  if (!host || host === CANONICAL_HOST) return next();
  if (host.startsWith('localhost') || host.startsWith('127.0.0.1')) return next();
  return res.redirect(301, `${config.publicUrl}${req.originalUrl}`);
});

// Stripe verifies a signature over the exact bytes it sent, so this route must be
// mounted before the JSON parser gets to rewrite them.
app.use('/stripe', express.raw({ type: 'application/json' }), billing.router);

app.use(express.json({ limit: config.maxRequestBytes }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

/**
 * The health check reports whether LibreOffice is actually present, because an
 * image built without it looks perfectly healthy right up until the first request
 * that asks for a PDF.
 */
let loStatus = { available: false, version: null, checkedAt: 0 };
app.get('/healthz', async (req, res) => {
  if (Date.now() - loStatus.checkedAt > 60000) {
    loStatus = { ...(await pdf.probe()), checkedAt: Date.now() };
  }
  const body = { ok: true, pdf: { available: loStatus.available, ...pdf.stats() } };

  // `?db=1` times a trivial round trip and reports the pool's state. This exists
  // because the first production measurement showed 450 ms per query between two
  // services in the same city, which is the kind of number you cannot debug from
  // the outside: it could be the network, the pool opening a connection per
  // query, or the container being starved of CPU. The pool counters tell them
  // apart. Kept in, because that question recurs.
  if (req.query.db !== undefined) {
    const s = process.hrtime.bigint();
    let err = null;
    try { await query('SELECT 1'); } catch (e) { err = e.message; }
    const first = Number(process.hrtime.bigint() - s) / 1e6;
    const s2 = process.hrtime.bigint();
    try { await query('SELECT 1'); } catch (e) { err = err || e.message; }
    const second = Number(process.hrtime.bigint() - s2) / 1e6;
    body.db = {
      first_ms: Math.round(first * 10) / 10,
      second_ms: Math.round(second * 10) / 10,
      pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount },
      error: err,
    };
  }
  res.json(body);
});

/**
 * Downloading what an asynchronous job produced.
 *
 * The token is the capability: 144 bits of randomness, unguessable, and it
 * expires. There is deliberately no API key on this route, because the whole
 * point is that the URL can be handed to a browser, an email or an n8n HTTP node
 * that has no credentials - the same reason the link is useless once the TTL
 * passes. Downloading a file you already paid to generate is free.
 */
app.get('/f/:token', async (req, res, next) => {
  try {
    const { rows } = await query(
      `SELECT filename, content_type, bytes, size FROM files WHERE token = $1 AND expires_at > now()`,
      [String(req.params.token)],
    );
    if (!rows.length) {
      return res.status(404).json({
        error: {
          code: 'file_expired',
          message: 'This download link has expired, or there was never a file behind it.',
          hint: 'Job files are kept for a limited time. Run the job again, or fetch GET /v1/jobs/{id} to see whether the job is still there.',
          docs: `${config.publicUrl}/docs#async`,
          request_id: req.id,
        },
      });
    }
    const f = rows[0];
    res.set({
      'Content-Type': f.content_type,
      'Content-Length': String(f.size),
      'Content-Disposition': `attachment; filename="${f.filename.replace(/"/g, '')}"`,
      'Cache-Control': 'private, max-age=300',
    });
    return res.end(f.bytes);
  } catch (e) { return next(e); }
});

app.use('/v1', api.router);
app.use(web.router);
app.use(express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h', extensions: ['html'] }));

app.use((req, res) => {
  if (req.path.startsWith('/v1/')) {
    return res.status(404).json({
      error: {
        code: 'unknown_endpoint',
        message: `There is no ${req.method} ${req.path} endpoint.`,
        hint: 'The endpoint list is at /docs. The main one is POST /v1/render.',
        docs: `${config.publicUrl}/docs`,
        request_id: req.id,
      },
    });
  }
  res.status(404).type('text/plain').send('Not found');
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof ApiError) {
    if (err.status >= 500) req.log.error('request.error', { code: err.code, status: err.status, err });
    const body = err.toJSON(req.id);
    if (body.error.docs && body.error.docs.startsWith('/')) body.error.docs = `${config.publicUrl}${body.error.docs}`;
    return res.status(err.status).json(body);
  }

  // express.json rejects an oversized or malformed body before any route sees it.
  if (err.type === 'entity.too.large') {
    return res.status(413).json({
      error: {
        code: 'request_too_large',
        message: `The request body is larger than the ${(config.maxRequestBytes / 1048576).toFixed(0)} MB limit.`,
        hint: 'A base64 template is a third larger than the file. Upload the template once with POST /v1/templates and reference it by name instead of sending it on every render.',
        docs: `${config.publicUrl}/docs#limits`,
        request_id: req.id,
      },
    });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({
      error: {
        code: 'bad_json',
        message: 'The request body is not valid JSON.',
        hint: 'Check for a trailing comma or an unquoted key. If you are building the body in a shell, single quotes around the whole thing usually fixes it.',
        docs: `${config.publicUrl}/docs`,
        request_id: req.id,
      },
    });
  }

  req.log.error('request.unhandled', { err });
  res.status(500).json({
    error: {
      code: 'internal_error',
      message: 'Something went wrong inside DocMint. This is our fault, not yours.',
      hint: 'Please report it with the request id below; it is enough to find the exact log line.',
      request_id: req.id,
    },
  });
});

async function start() {
  if (config.databaseUrl) {
    await migrate();
  } else {
    log.warn('start.no_database', { note: 'DATABASE_URL is unset; authenticated endpoints will fail.' });
  }
  const lo = await pdf.probe();
  loStatus = { ...lo, checkedAt: Date.now() };
  if (config.databaseUrl) await billing.healStaleCustomers().catch((e) => log.warn('stripe.heal_failed', { err: e }));

  // The queue lives in the database, so any process pointed at that database
  // would otherwise pick up production's jobs - including a developer's laptop,
  // which has no LibreOffice and would fail every PDF job it stole.
  if (config.databaseUrl) {
    jobs.startReapers();
    if (config.jobsWorker) jobs.startWorker(api.loadTemplate);
  }
  log.info('start', {
    port: config.port,
    origin: config.origin,
    pdf_available: lo.available,
    pdf_engine: lo.version,
    max_concurrent_pdf: config.maxConcurrentPdf,
    max_batch_items: config.maxBatchItems,
    jobs_worker: config.databaseUrl ? config.jobsWorker : false,
    billing: billing.enabled(),
    node: process.version,
  });
  app.listen(config.port, () => log.info('listening', { port: config.port, url: config.publicUrl || null }));
}

if (require.main === module) {
  start().catch((e) => { log.error('start.failed', { err: e }); process.exit(1); });
}

module.exports = { app, start };
