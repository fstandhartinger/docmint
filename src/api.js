'use strict';

const express = require('express');
const crypto = require('node:crypto');

const { config, PLANS, FORMATS, planPriceId } = require('./config');
const { ApiError, bad } = require('./errors');
const { query } = require('./db');
const { authenticate, consumeCredits, refundCredits, issueApiKey, revokeApiKey } = require('./auth');
const { rateLimit } = require('./ratelimit');
const { formatterNames } = require('./capabilities');
const templates = require('./templates');
const renderer = require('./render');
const pdf = require('./pdf');
const input = require('./input');
const log = require('./log');
const billing = require('./billing');
const batchLib = require('./batch');
const jobs = require('./jobs');
const { assertPublicUrl } = require('./net');

const router = express.Router();

const asyncRoute = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const authenticateOnly = asyncRoute(async (req, res, next) => {
  req.account = await authenticate(req);
  req.log = req.log.child({ account: req.account.id });
  next();
});

const withAuth = [authenticateOnly, rateLimit];

/* ------------------------------------------------------------------ costing */

/**
 * A document costs one credit. Converting it to PDF costs one more, because
 * LibreOffice costs roughly a hundred times the CPU of the fill itself
 * (measured: about 1,020 ms against about 10 ms) and pretending the two are the
 * same price would mean the cheap path subsidising the expensive one.
 *
 * Nothing else is metered. Downloading a file you already generated is free —
 * unlike Docupilot, where "Downloading generated document also consumes 1 credit"
 * and each delivery consumes another.
 */
const CREDITS = { document: 1, pdf: 2, both: 2 };

/* --------------------------------------------------------------- /v1/render */

const RENDER_FIELDS = [
  'template', 'template_base64', 'template_version', 'data', 'output', 'filename',
  'locale', 'currency', 'timezone', 'onMissing', 'strictScope', 'response', 'images', 'now',
];

router.post('/render', withAuth, asyncRoute(async (req, res) => {
  const t = log.timer();
  const body = req.body || {};
  input.rejectUnknown(body, RENDER_FIELDS, '/docs#render');

  const output = input.enumOr(body.output, ['document', 'pdf', 'both'], 'output', '/docs#output');
  const wantJson = String(body.response || '').toLowerCase() === 'json'
    || (!body.response && String(req.get('accept') || '').includes('application/json'));

  const opts = {
    locale: input.checkLocale(body.locale),
    currency: input.checkCurrency(body.currency),
    timezone: input.checkTimezone(body.timezone),
    onMissing: input.enumOr(body.onMissing, ['error', 'empty', 'keep'], 'onMissing', '/docs#errors'),
    strictScope: body.strictScope === true,
    now: body.now ? input.checkInstant(body.now) : null,
    images: body.images && typeof body.images === 'object' ? body.images : undefined,
  };

  const data = body.data === undefined ? {} : body.data;
  const dataBytes = input.checkDataSize(data);

  const { buffer: templateBuffer, source, template } = await loadTemplate(req.account, body, req.log);
  t.mark('load');

  req.log = req.log.child({ template_id: template?.id || null, template_source: source });

  // Credits are taken before the work and refunded if the work fails, so a run
  // that errors on a missing field does not cost the caller anything.
  const cost = CREDITS[output];
  const balance = await consumeCredits(req.account.id, cost);
  t.mark('quota');

  let filled;
  let pdfOut = null;
  try {
    filled = await renderer.fill(templateBuffer, data, { ...opts, log: req.log });
    t.mark('fill');

    if (output === 'pdf' || output === 'both') {
      pdfOut = await pdf.toPdf(filled.buffer, filled.format, { log: req.log });
      t.mark('pdf');
    }
  } catch (e) {
    await refundCredits(req.account.id, cost);
    await recordUsage(req.account.id, req.id, {
      kind: 'render', format: filled?.format || null, template_id: template?.id || null,
      output, credits: 0, ok: false, error_code: e.code || 'unknown', ms: t.total(), stages: t.stages(),
    });
    req.log.warn('render.fail', {
      output, code: e.code, status: e.status, field: e.details?.field, location: e.details?.location,
      stages: t.stages(), ms: t.total(), data_bytes: dataBytes,
    });
    throw e;
  }

  const ext = FORMATS[filled.format].ext;
  const docName = input.renderFilename(body.filename, data, ext, opts);
  const pdfName = input.renderFilename(body.filename, data, 'pdf', opts);

  await recordUsage(req.account.id, req.id, {
    kind: 'render', format: filled.format, template_id: template?.id || null,
    output, credits: cost, ok: true, ms: t.total(), stages: t.stages(),
  });

  req.log.info('render.ok', {
    output, format: filled.format, template_source: source,
    template_version: template ? (body.template_version || template.version) : null,
    in_bytes: templateBuffer.length, data_bytes: dataBytes,
    doc_bytes: filled.buffer.length, pdf_bytes: pdfOut?.buffer.length || null,
    pages: pdfOut?.pages ?? null, pdf_queued_ms: pdfOut?.queuedMs ?? null,
    tags: filled.stats.tags, resolved: filled.stats.resolved, sections: filled.stats.sections,
    images: filled.stats.images, warnings: filled.warnings.length,
    credits: cost, credits_remaining: balance.remaining,
    stages: t.stages(), ms: t.total(),
  });

  res.set('X-DocMint-Request-Id', req.id);
  res.set('X-DocMint-Credits-Remaining', String(balance.remaining));
  res.set('X-DocMint-Warnings', String(filled.warnings.length));

  if (wantJson || output === 'both') {
    res.json({
      request_id: req.id,
      format: filled.format,
      document: output === 'pdf' ? undefined : {
        filename: docName, content_type: FORMATS[filled.format].mime,
        size: filled.buffer.length, base64: filled.buffer.toString('base64'),
      },
      pdf: pdfOut ? {
        filename: pdfName, content_type: 'application/pdf',
        size: pdfOut.buffer.length, pages: pdfOut.pages, base64: pdfOut.buffer.toString('base64'),
      } : undefined,
      stats: { ...filled.stats, ms: t.total(), stages: t.stages() },
      warnings: filled.warnings,
      credits: { used: cost, remaining: balance.remaining, limit: balance.limit },
    });
    return;
  }

  const send = output === 'pdf' ? pdfOut.buffer : filled.buffer;
  const name = output === 'pdf' ? pdfName : docName;
  res.set('Content-Type', output === 'pdf' ? 'application/pdf' : FORMATS[filled.format].mime);
  res.set('Content-Disposition', `attachment; filename="${name.replace(/"/g, '')}"`);
  res.set('Content-Length', String(send.length));
  res.send(send);
}));

/* --------------------------------------------------- /v1/render/batch */

const BATCH_DOCS = '/docs#batch';

/**
 * One template, many datasets, one call.
 *
 * The measured problem: 500 invoices through POST /v1/render is 500 HTTP round
 * trips against a service that restarts on deploy, and the PDF stage serialises
 * anyway (two simultaneous PDF renders came back at 3,371 ms and 5,740 ms), so a
 * month-end run was about 25 minutes of wall clock with no way to resume it.
 */
router.post('/render/batch', withAuth, asyncRoute(async (req, res) => {
  const t = log.timer();
  const body = req.body || {};
  const spec = batchLib.parseBatch(body, { docs: BATCH_DOCS });
  batchLib.assertSyncPdfLimit(spec);

  const { buffer: templateBuffer, source, template } = await loadTemplate(req.account, body, req.log);
  t.mark('load');
  req.log = req.log.child({ template_id: template?.id || null, template_source: source });

  // Refused BEFORE any work, and told how many of the items would have fitted.
  // Discovering the quota at item 41 of 60 leaves a partial run to reconcile by
  // hand, which is worse than not starting.
  const perItem = CREDITS[spec.output];
  batchLib.assertAffordable(req.account, perItem, spec.items.length);
  const reserved = perItem * spec.items.length;
  const balance = await consumeCredits(req.account.id, reserved);
  t.mark('quota');

  let run;
  try {
    run = await batchLib.runBatch({
      account: req.account, spec, templateBuffer, log: req.log,
      deadlineAt: Date.now() + config.batchBudgetMs,
    });
  } catch (e) {
    // on_error "fail": nothing is delivered, so nothing is charged - including
    // the documents that were already produced when the batch stopped. Charging
    // for files the caller never received would be indefensible.
    await refundCredits(req.account.id, reserved);
    await recordUsage(req.account.id, req.id, {
      kind: 'batch', template_id: template?.id || null, output: spec.output,
      credits: 0, ok: false, error_code: e.code || 'unknown', ms: t.total(), stages: t.stages(),
    });
    req.log.warn('batch.fail', {
      items: spec.items.length, output: spec.output, on_error: spec.onError,
      code: e.code, status: e.status, item: e.details?.item, ms: t.total(),
    });
    throw e;
  }

  const charged = perItem * run.ok;
  if (charged < reserved) await refundCredits(req.account.id, reserved - charged);
  const remaining = balance.remaining + (reserved - charged);
  const format = run.records.find((r) => r.format)?.format || null;

  await recordUsage(req.account.id, req.id, {
    kind: 'batch', format, template_id: template?.id || null, output: spec.output,
    credits: charged, ok: run.failed === 0, error_code: run.failed ? 'partial' : null,
    ms: t.total(), stages: { ...t.stages(), ...run.stages },
  });

  const files = batchLib.filesOf(run.records, spec.output);
  const bytes = files.reduce((n, f) => n + f.buffer.length, 0);

  // One line for the batch, whatever its size. The per-item lines are debug,
  // because a hundred info lines per request makes the one that matters unfindable.
  req.log.info('batch.ok', {
    items: spec.items.length, ok: run.ok, failed: run.failed,
    output: spec.output, response: spec.response, on_error: spec.onError, format,
    template_source: source, files: files.length, out_bytes: bytes, data_bytes: spec.dataBytes,
    credits: charged, credits_reserved: reserved, credits_refunded: reserved - charged, credits_remaining: remaining,
    stages: { ...t.stages(), ...run.stages }, ms: t.total(),
    ms_per_item: Math.round((t.total() / spec.items.length) * 10) / 10,
  });

  res.set('X-DocMint-Request-Id', req.id);
  res.set('X-DocMint-Credits-Remaining', String(remaining));
  res.set('X-DocMint-Batch-Ok', String(run.ok));
  res.set('X-DocMint-Batch-Failed', String(run.failed));

  if (spec.response === 'zip') {
    const { buffer, names } = batchLib.buildZip(files, { errors: batchLib.failedItems(run.records) });
    t.mark('zip');
    const name = `${(template?.name || 'batch').replace(/[^A-Za-z0-9._-]/g, '')}.zip`;
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="${name}"`);
    res.set('Content-Length', String(buffer.length));
    req.log.debug('batch.zip', { entries: names.length, bytes: buffer.length, ms: t.stages().zip });
    res.send(buffer);
    return;
  }

  res.json({
    request_id: req.id,
    template: template ? { id: template.id, name: template.name, version: body.template_version || template.version } : { source },
    output: spec.output,
    count: spec.items.length,
    ok: run.ok,
    failed: run.failed,
    results: run.records.map((r) => batchLib.itemJson(r, spec.output)),
    credits: { used: charged, refunded: reserved - charged, remaining, limit: balance.limit },
    stats: { ms: t.total(), stages: { ...t.stages(), ...run.stages } },
  });
}));

/* ----------------------------------------------------------- /v1/jobs */

/**
 * The same work, without the connection.
 *
 * A synchronous batch is bounded by whatever proxy sits in front of us; a job is
 * not. It survives a redeploy because the queue is a table, it can be cancelled,
 * and it tells you it is finished rather than making you hold a socket open.
 */
const JOB_FIELDS = [...batchLib.BATCH_FIELDS, 'data', 'filename', 'webhook_url'];

/**
 * A job body is either a /v1/render body or a /v1/render/batch body. One
 * document is just a batch of one, so the single form is turned into the batch
 * form here and only one shape ever reaches the worker.
 */
function normaliseJobBody(body) {
  const { webhook_url: webhookUrl, ...rest } = body;
  if (rest.items !== undefined) {
    if (rest.data !== undefined || rest.filename !== undefined) {
      throw bad('items_and_data', 'Send either "items" (a batch) or "data" (one document), not both.', {
        hint: 'Per-item filenames go inside each item: {"items":[{"data":{...},"filename":"inv-{invoice_no}"}]}.',
        docs: '/docs#async',
      });
    }
    return { kind: 'batch', request: rest, webhookUrl };
  }
  const item = {};
  if (rest.data !== undefined) item.data = rest.data;
  if (rest.filename !== undefined) item.filename = rest.filename;
  const { data, filename, ...common } = rest;
  return { kind: 'render', request: { ...common, items: [item] }, webhookUrl };
}

router.post('/jobs', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  input.rejectUnknown(body, JOB_FIELDS, '/docs#async');
  const { kind, request, webhookUrl } = normaliseJobBody(body);

  // Everything that can be checked now IS checked now. A job that is going to
  // fail because the template name is a typo should say so in the 202 response,
  // not five minutes later in a webhook the caller has to go and read.
  const spec = batchLib.parseBatch(request, { docs: '/docs#async' });
  const { template } = await loadTemplate(req.account, request, req.log);
  if (webhookUrl !== undefined && webhookUrl !== null && webhookUrl !== '') {
    await assertPublicUrl(String(webhookUrl), 'webhook_url');
  }

  const perItem = CREDITS[spec.output];
  batchLib.assertAffordable(req.account, perItem, spec.items.length);
  const reserved = perItem * spec.items.length;
  const balance = await consumeCredits(req.account.id, reserved);

  let id;
  try {
    id = await jobs.enqueue(req.account.id, { kind, request, webhookUrl: webhookUrl || null, creditsReserved: reserved });
  } catch (e) {
    await refundCredits(req.account.id, reserved);
    throw e;
  }

  req.log.info('job.queued', {
    job: id, kind, items: spec.items.length, output: spec.output,
    template_id: template?.id || null, webhook: Boolean(webhookUrl), credits_reserved: reserved,
  });

  res.status(202).json({
    id,
    status: 'queued',
    kind,
    count: spec.items.length,
    output: spec.output,
    status_url: absoluteUrl(req, `/v1/jobs/${id}`),
    ...(webhookUrl ? { webhook_url: String(webhookUrl) } : {}),
    credits: { reserved, remaining: balance.remaining, limit: balance.limit },
    note: 'Poll status_url, or wait for the webhook. Credits are reserved now and whatever the job does not produce is given back.',
  });
}));

/** Stored file paths become absolute URLs from the host that is answering. */
function withUrls(req, job) {
  if (!job.result || !Array.isArray(job.result.files)) return job;
  return {
    ...job,
    result: { ...job.result, files: job.result.files.map(({ path, ...f }) => ({ ...f, url: absoluteUrl(req, path) })) },
  };
}

router.get('/jobs', withAuth, asyncRoute(async (req, res) => {
  const list = await jobs.list(req.account.id, req.query.limit);
  res.json({ jobs: list.map((j) => withUrls(req, j)) });
}));

router.get('/jobs/:id', withAuth, asyncRoute(async (req, res) => {
  res.json(withUrls(req, await jobs.get(req.account.id, String(req.params.id))));
}));

router.post('/jobs/:id/cancel', withAuth, asyncRoute(async (req, res) => {
  const out = await jobs.cancel(req.account.id, String(req.params.id));
  req.log.info('job.cancelled', { job: out.id });
  res.json(out);
}));

/* -------------------------------------------------------- /v1/webhooks */

/**
 * The signing secret, so a receiver can actually verify a webhook.
 *
 * There is no dashboard to read it off yet, and a signature nobody can check is
 * decoration. It is per account, never rotated automatically, and only ever
 * returned to a request already holding one of that account's API keys.
 */
router.get('/webhooks', withAuth, asyncRoute(async (req, res) => {
  const { rows } = await query(`SELECT webhook_secret FROM accounts WHERE id = $1`, [req.account.id]);
  res.json({
    signing_secret: rows[0]?.webhook_secret || null,
    algorithm: 'HMAC-SHA256',
    signed_value: '{X-DocMint-Timestamp}.{raw request body}',
    headers: {
      signature: 'X-DocMint-Signature',
      timestamp: 'X-DocMint-Timestamp',
      job_id: 'X-DocMint-Job-Id',
      event: 'X-DocMint-Event',
    },
    max_attempts: config.jobWebhookAttempts,
    note: 'Compare with a constant-time compare, and reject a timestamp more than a few minutes old so an old delivery cannot be replayed.',
  });
}));

/** Turns a stored path into an absolute URL for the request being answered. */
function absoluteUrl(req, pathname) {
  if (config.publicUrl) return `${config.publicUrl}${pathname}`;
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  const host = req.get('x-forwarded-host') || req.get('host');
  return host ? `${proto}://${host}${pathname}` : pathname;
}

/**
 * Where the template came from. Exactly one of `template` and `template_base64`,
 * because accepting both and silently preferring one is how a workflow ends up
 * rendering last month's letterhead.
 */
async function loadTemplate(account, body, l) {
  const given = ['template', 'template_base64'].filter((k) => body[k] !== undefined && body[k] !== null && body[k] !== '');
  if (given.length === 0) {
    throw bad('missing_template', 'No template: send "template" with a saved template name, or "template_base64" with the file itself.', {
      hint: 'Upload a template once with POST /v1/templates and then reference it by name, or send the file inline on every call.',
      docs: '/docs#render',
    });
  }
  if (given.length > 1) {
    throw bad('ambiguous_template', 'Send either "template" or "template_base64", not both.', {
      hint: 'Pick the saved template by name, or send the file inline - never both, because it is not obvious which would win.',
      docs: '/docs#render',
    });
  }

  if (body.template_base64) {
    if (body.template_version !== undefined) {
      throw bad('version_without_template', '"template_version" only means something with a saved "template".', { docs: '/docs#template-versions' });
    }
    const buffer = input.decodeBase64(body.template_base64, 'template_base64');
    if (buffer.length > config.maxTemplateBytes) {
      throw new ApiError(413, 'template_too_large',
        `That template is ${(buffer.length / 1048576).toFixed(1)} MB; the limit is ${(config.maxTemplateBytes / 1048576).toFixed(0)} MB.`,
        { docs: '/docs#limits' });
    }
    return { buffer, source: 'inline', template: null };
  }

  const template = await templates.findOrThrow(account.id, body.template);
  const version = await templates.bytesOf(template, body.template_version);
  l.debug('template.loaded', { template_id: template.id, name: template.name, version: version.version, bytes: version.size });
  return { buffer: version.bytes, source: 'stored', template, version: version.version };
}

/* -------------------------------------------------------------- /v1/inspect */

/**
 * "What fields does this template need?" — the question no competitor answers.
 * Free: it reads a file the caller already has and produces no document, so
 * charging for it would only discourage the one call that prevents a bad render.
 */
router.post('/inspect', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  input.rejectUnknown(body, ['template', 'template_base64', 'template_version'], '/docs#inspect');
  const { buffer, source, template } = await loadTemplate(req.account, body, req.log);
  const t = log.timer();
  const out = await renderer.inspect(buffer);
  req.log.info('inspect.ok', {
    template_id: template?.id || null, source, format: out.format,
    fields: out.fields.length, tags: out.tags.length, ms: t.total(),
  });
  res.json({
    request_id: req.id,
    format: out.format,
    // `fields` is the typed, scoped tree - what to SEND. `names` is the flat list
    // of what is literally written in the file. `tags` says where each one is.
    // `sample_data` is a skeleton that is guaranteed to render this template.
    fields: out.fields,
    names: out.names,
    tags: out.tags,
    sample_data: out.sample_data,
    template: template ? { id: template.id, name: template.name, version: template.version } : null,
  });
}));

/* ------------------------------------------------------------ /v1/templates */

router.get('/templates', withAuth, asyncRoute(async (req, res) => {
  res.json({ templates: await templates.list(req.account.id) });
}));

const uploadTemplate = asyncRoute(async (req, res) => {
  const body = req.body || {};
  const fromPath = req.params.name !== undefined;
  const known = fromPath ? ['file_base64', 'description', 'note'] : ['name', 'file_base64', 'description', 'note'];
  input.rejectUnknown(body, known, '/docs#templates');

  if (!body.file_base64) {
    throw bad('missing_file', 'Send the template file as "file_base64".', {
      hint: 'base64 -w0 invoice.docx, then send {"name":"invoice","file_base64":"<that>"}. In n8n the node handles this for you.',
      docs: '/docs#templates',
    });
  }
  const buffer = input.decodeBase64(body.file_base64, 'file_base64');

  // Extracting the fields at upload time is what lets the node show them as real
  // inputs later without opening the file again on every keystroke.
  let fields = { fields: [], tags: [] };
  try {
    const info = await renderer.inspect(buffer);
    fields = { fields: info.fields, tags: info.tags };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    req.log.warn('template.inspect_failed', { err: e });
  }

  const out = await templates.upload(req.account, {
    name: fromPath ? req.params.name : body.name,
    buffer,
    description: body.description,
    note: body.note,
    inspectFields: fields,
  });

  res.status(out.unchanged ? 200 : 201).json({
    request_id: req.id,
    id: out.template.id,
    name: out.template.name,
    format: out.format,
    version: out.version,
    unchanged: out.unchanged,
    size: buffer.length,
    fields: fields.fields,
    macro_enabled: out.macroEnabled,
  });
});

router.post('/templates', withAuth, uploadTemplate);
router.put('/templates/:name', withAuth, uploadTemplate);

router.get('/templates/:name', withAuth, asyncRoute(async (req, res) => {
  const template = await templates.findOrThrow(req.account.id, req.params.name);
  const current = await templates.bytesOf(template, null);
  res.json({
    id: template.id,
    name: template.name,
    format: template.format,
    version: template.version,
    description: template.description,
    size: Number(current.size),
    sha256: current.sha256,
    fields: current.fields,
    created_at: template.created_at,
    updated_at: template.updated_at,
    versions: await templates.versionsOf(template.id),
  });
}));

/** The endpoint the n8n node's field mapper calls. */
router.get('/templates/:name/fields', withAuth, asyncRoute(async (req, res) => {
  const template = await templates.findOrThrow(req.account.id, req.params.name);
  const version = await templates.bytesOf(template, req.query.version);
  // Stored fields come from the upload; re-deriving is cheap and means a template
  // uploaded before a renderer improvement still reports accurately.
  const out = await renderer.inspect(version.bytes);
  res.json({
    id: template.id,
    name: template.name,
    format: out.format,
    version: version.version,
    fields: out.fields,
    names: out.names,
    tags: out.tags,
    sample_data: out.sample_data,
  });
}));

router.get('/templates/:name/file', withAuth, asyncRoute(async (req, res) => {
  const template = await templates.findOrThrow(req.account.id, req.params.name);
  const version = await templates.bytesOf(template, req.query.version);
  res.set('Content-Type', FORMATS[template.format].mime);
  res.set('Content-Disposition', `attachment; filename="${template.name}.${FORMATS[template.format].ext}"`);
  res.send(version.bytes);
}));

router.get('/templates/:name/versions', withAuth, asyncRoute(async (req, res) => {
  const template = await templates.findOrThrow(req.account.id, req.params.name);
  res.json({ id: template.id, name: template.name, current: template.version, versions: await templates.versionsOf(template.id) });
}));

router.post('/templates/:name/rollback', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  input.rejectUnknown(body, ['version'], '/docs#template-versions');
  if (body.version === undefined) {
    throw bad('missing_version', 'Say which version to roll back to: {"version": 3}.', { docs: '/docs#template-versions' });
  }
  const out = await templates.rollback(req.account, req.params.name, body.version);
  res.json({
    request_id: req.id, id: out.template.id, name: out.template.name,
    version: out.version, restored_from: out.restoredFrom,
  });
}));

router.delete('/templates/:name', withAuth, asyncRoute(async (req, res) => {
  const template = await templates.remove(req.account.id, req.params.name);
  res.json({ deleted: true, id: template.id, name: template.name });
}));

/* --------------------------------------------------------------- /v1/usage */

router.get('/usage', withAuth, asyncRoute(async (req, res) => {
  const a = req.account;
  const { rows } = await query(
    `SELECT kind, format, output, ok, count(*)::int AS n, sum(credits)::int AS credits,
            round(avg(duration_ms))::int AS avg_ms
     FROM usage_events WHERE account_id = $1 AND created_at >= date_trunc('month', now())
     GROUP BY kind, format, output, ok ORDER BY n DESC`, [a.id],
  );
  const plan = PLANS[a.plan] || PLANS.free;
  res.json({
    plan: { id: a.plan, name: plan.name, price_usd: plan.priceUsd },
    credits: { used: a.credits_used, limit: a.credits_limit, remaining: a.credits_limit - a.credits_used },
    period_start: a.period_start,
    breakdown: rows,
  });
}));

/* ---------------------------------------------------------- /v1/formats etc */

/**
 * What this build can actually do. Published so that the documentation and the
 * node can be checked against the running code rather than against a README that
 * drifted - if a formatter is listed here it exists, because the list is read out
 * of the module.
 */
router.get('/capabilities', asyncRoute(async (req, res) => {
  const lo = await pdf.probe();
  res.json({
    formats: Object.entries(FORMATS).map(([id, f]) => ({ id, name: f.name, mime: f.mime })),
    outputs: ['document', 'pdf', 'both'],
    pdf: { available: lo.available, engine: lo.available ? 'libreoffice' : null, concurrency: config.maxConcurrentPdf },
    formatters: formatterNames(),
    limits: {
      max_template_bytes: config.maxTemplateBytes,
      max_data_bytes: config.maxDataBytes,
      max_versions_kept: config.maxVersionsKept,
      pdf_timeout_ms: config.pdfTimeoutMs,
      // Batch caps, and where each number comes from. Filling is 2.9 ms for a
      // three-line invoice and 69 ms for a five-hundred-line one, so 100 items
      // is at most about 7 s of CPU. PDF conversion is about 2.6 s and does not
      // parallelise, so a synchronous PDF batch is capped where it still fits
      // inside a 100 s proxy timeout; bigger PDF runs go through /v1/jobs.
      max_batch_items: config.maxBatchItems,
      max_sync_batch_pdf_items: config.maxSyncBatchPdfItems,
      batch_budget_ms: config.batchBudgetMs,
      job_file_ttl_minutes: config.jobFileTtlMinutes,
      job_retention_days: config.jobRetentionDays,
      max_stored_file_bytes: config.maxStoredFileBytes,
    },
    async: {
      enabled: true,
      endpoint: '/v1/jobs',
      webhook_signature: 'HMAC-SHA256 over {timestamp}.{body}, in X-DocMint-Signature',
      webhook_attempts: config.jobWebhookAttempts,
      worker: config.jobsWorker,
    },
    credits: CREDITS,
  });
}));

/* ----------------------------------------------------------------- signup */

/**
 * Self-serve signup, deliberately over the API rather than only through a web
 * form. The buyer here is someone wiring up a workflow; making them leave the
 * terminal, click through a dashboard and copy a key out of a modal before they
 * can see whether the thing works at all is friction with no purpose. The
 * dashboard can come later; the key must be obtainable now.
 */
const signupLimiter = new Map();

router.post('/signup', asyncRoute(async (req, res) => {
  const body = req.body || {};
  input.rejectUnknown(body, ['email', 'password'], '/docs#signup');

  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s.]+\.[^@\s]{2,}$/.test(email)) {
    throw bad('bad_email', 'That does not look like an email address.', { docs: '/docs#signup' });
  }
  const password = String(body.password || '');
  if (password.length < 10) {
    throw bad('weak_password', 'The password must be at least 10 characters.', {
      hint: 'This is the only thing standing between someone else and your templates.',
      docs: '/docs#signup',
    });
  }

  // One signup per IP per minute. Not security, just enough to stop a loop in a
  // misconfigured workflow filling the accounts table overnight.
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const last = signupLimiter.get(ip) || 0;
  if (now - last < 60000) {
    throw new ApiError(429, 'signup_rate_limited', 'Only one signup per minute from the same address.', {
      hint: 'If you already have an account, create another key with POST /v1/keys using your existing one.',
      docs: '/docs#signup',
    });
  }
  signupLimiter.set(ip, now);
  if (signupLimiter.size > 5000) signupLimiter.clear();

  const { createAccount } = require('./auth');
  let out;
  try {
    out = await createAccount(email, password);
  } catch (e) {
    if (e.code === '23505') {
      throw new ApiError(409, 'email_taken', 'There is already an account with that email address.', {
        hint: 'Create an extra API key with POST /v1/keys using a key you already hold.',
        docs: '/docs#signup',
      });
    }
    throw e;
  }

  req.log.info('signup.ok', { account: out.account.id });
  const plan = PLANS[out.account.plan];
  res.status(201).json({
    email: out.account.email,
    api_key: out.apiKey,
    plan: { id: out.account.plan, name: plan.name, credits: out.account.credits_limit },
    note: 'This is the only time the key is shown. Store it now.',
  });
}));

/* ---------------------------------------------------------------- billing */

router.post('/billing/checkout', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  input.rejectUnknown(body, ['plan'], '/docs#pricing');
  const plan = String(body.plan || '');
  const session = await billing.createCheckoutSession(req.account, plan);
  req.log.info('billing.checkout_created', { plan, session: session.id });
  res.json({ url: session.url, plan, expires_at: session.expires_at });
}));

router.post('/billing/portal', withAuth, asyncRoute(async (req, res) => {
  const session = await billing.createPortalSession(req.account);
  res.json({ url: session.url });
}));

router.get('/billing/plans', asyncRoute(async (req, res) => {
  res.json({
    billing_available: billing.enabled(),
    // A plan with no Stripe price configured is listed but marked unpurchasable,
    // rather than hidden: a page that shows three plans while the API knows about
    // four is how documentation and code drift apart.
    plans: Object.values(PLANS).map((p) => ({
      id: p.id, name: p.name, price_usd: p.priceUsd, documents_per_month: p.credits,
      purchasable: p.priceUsd === 0 ? false : Boolean(planPriceId(p.id)),
    })),
    note: 'One document costs one credit. Asking for a PDF costs one more, because converting it costs about a hundred times the CPU. Downloading a file you already made is free.',
  });
}));

/* ------------------------------------------------------------------- keys */

router.post('/keys', withAuth, asyncRoute(async (req, res) => {
  const body = req.body || {};
  input.rejectUnknown(body, ['label'], '/docs#authentication');
  const key = await issueApiKey(req.account.id, String(body.label || 'default').slice(0, 60));
  req.log.info('key.issued', { label: body.label || 'default' });
  res.status(201).json({ key, note: 'This is the only time the key is shown. Store it now.' });
}));

router.delete('/keys/:prefix', withAuth, asyncRoute(async (req, res) => {
  const n = await revokeApiKey(req.account.id, req.params.prefix);
  if (!n) throw new ApiError(404, 'key_not_found', `No live key on this account starts with "${req.params.prefix}".`, { docs: '/docs#authentication' });
  req.log.info('key.revoked', { prefix: req.params.prefix });
  res.json({ revoked: n });
}));

/* ------------------------------------------------------------------ usage */

async function recordUsage(accountId, requestId, e) {
  try {
    await query(
      `INSERT INTO usage_events (account_id, kind, format, template_id, output, credits, duration_ms, stages, ok, error_code, origin, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [accountId, e.kind, e.format || null, e.template_id || null, e.output || null, e.credits,
        Math.round(e.ms || 0), JSON.stringify(e.stages || {}), e.ok, e.error_code || null, config.origin, requestId],
    );
  } catch (err) {
    // Usage accounting must never take a successful render down with it.
    log.error('usage.record_failed', { err });
  }
}

module.exports = { router, CREDITS, loadTemplate, recordUsage, absoluteUrl };
