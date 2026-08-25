'use strict';

const express = require('express');
const path = require('node:path');

const { config } = require('./config');
const { ApiError } = require('./errors');
const { migrate } = require('./migrate');
const api = require('./api');
const pdf = require('./pdf');
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
  res.json({ ok: true, pdf: { available: loStatus.available, ...pdf.stats() } });
});

app.use('/v1', api.router);
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
  log.info('start', {
    port: config.port,
    origin: config.origin,
    pdf_available: lo.available,
    pdf_engine: lo.version,
    max_concurrent_pdf: config.maxConcurrentPdf,
    node: process.version,
  });
  app.listen(config.port, () => log.info('listening', { port: config.port, url: config.publicUrl || null }));
}

if (require.main === module) {
  start().catch((e) => { log.error('start.failed', { err: e }); process.exit(1); });
}

module.exports = { app, start };
