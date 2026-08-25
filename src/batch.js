'use strict';

const { config, FORMATS } = require('./config');
const { ApiError, bad } = require('./errors');
const { addEntry, writeZip } = require('./ooxml/zip');
const renderer = require('./render');
const pdf = require('./pdf');
const input = require('./input');
const log = require('./log');

/**
 * One template, many datasets, one HTTP call.
 *
 * The thing this fixes is measurable: a 500-invoice month-end run against
 * POST /v1/render is 500 HTTP round trips against a service that restarts on
 * deploy, and the PDF stage serialises anyway, so it was about 25 minutes of
 * wall clock during which any redeploy lost the position in the loop.
 *
 * Two stages, treated completely differently, because they cost completely
 * different amounts. Filling is 2.9 ms for a three-line invoice and 69 ms for a
 * five-hundred-line one, so it runs straight through with nothing in its way.
 * Converting to PDF is about 2.6 s and 219 MB of LibreOffice, so it goes through
 * the semaphore that already exists in src/pdf.js. A second semaphore here would
 * not make it faster; it would only make the real limit harder to find.
 */

const BATCH_FIELDS = [
  'template', 'template_base64', 'template_version', 'items', 'output',
  'locale', 'currency', 'timezone', 'onMissing', 'strictScope', 'response', 'on_error', 'images', 'now',
];

const ITEM_FIELDS = ['data', 'filename'];

/* ------------------------------------------------------------- validation */

/**
 * Turns the request body into a validated batch spec, or throws. Nothing is
 * rendered and nothing is charged until this has passed.
 */
function parseBatch(body, { docs = '/docs#batch' } = {}) {
  input.rejectUnknown(body, BATCH_FIELDS, docs);

  const items = body.items;
  if (!Array.isArray(items)) {
    throw bad('missing_items', '"items" must be an array of datasets, one per document.', {
      hint: 'Send {"template":"invoice","items":[{"data":{...}},{"data":{...}}]}. For a single document use POST /v1/render instead.',
      docs,
    });
  }
  if (items.length === 0) {
    throw bad('empty_batch', '"items" is empty, so there is nothing to render.', { docs });
  }
  if (items.length > config.maxBatchItems) {
    throw new ApiError(413, 'batch_too_large',
      `A batch may contain at most ${config.maxBatchItems} items; this one has ${items.length}.`, {
        hint: `Split it into ${Math.ceil(items.length / config.maxBatchItems)} calls of ${config.maxBatchItems}, or queue the work with POST /v1/jobs and let the webhook tell you when it is done.`,
        details: { items: items.length, max_items: config.maxBatchItems },
        docs,
      });
  }

  const output = input.enumOr(body.output, ['document', 'pdf', 'both'], 'output', '/docs#output');
  const response = input.enumOr(body.response, ['json', 'zip'], 'response', docs);
  const onError = input.enumOr(body.on_error, ['fail', 'continue'], 'on_error', docs);

  const opts = {
    locale: input.checkLocale(body.locale),
    currency: input.checkCurrency(body.currency),
    timezone: input.checkTimezone(body.timezone),
    onMissing: input.enumOr(body.onMissing, ['error', 'empty', 'keep'], 'onMissing', '/docs#errors'),
    strictScope: body.strictScope === true,
    // One instant for the whole batch. Letting each item read the clock would
    // mean two documents in the same run disagreeing about what "today" is.
    now: body.now ? input.checkInstant(body.now) : null,
    images: body.images && typeof body.images === 'object' ? body.images : undefined,
  };

  // Every item is checked before the first one is rendered. Finding out at item
  // 78 that item 79 has a typo in a field name, after 78 documents have already
  // been produced and charged for, is exactly the experience this replaces.
  let dataBytes = 0;
  const parsed = items.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw bad('bad_item', `items[${i}] must be an object like {"data": {...}}, not ${Array.isArray(raw) ? 'an array' : typeof raw}.`, {
        hint: 'If you have a bare list of datasets, wrap each one: items.map(d => ({data: d})).',
        details: { item: i },
        docs,
      });
    }
    try {
      input.rejectUnknown(raw, ITEM_FIELDS, docs);
    } catch (e) {
      // Say which item, or the caller has to find it in a list of a hundred.
      throw new ApiError(e.status, e.code, `items[${i}]: ${e.message}`, {
        hint: e.hint, docs: e.docs, details: { ...(e.details || {}), item: i },
      });
    }
    const data = raw.data === undefined ? {} : raw.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw bad('bad_data', `items[${i}].data must be a JSON object, not ${Array.isArray(data) ? 'an array' : typeof data}.`, {
        details: { item: i }, docs: '/docs#data',
      });
    }
    dataBytes += input.checkDataSize(data);
    if (raw.filename !== undefined && raw.filename !== null && typeof raw.filename !== 'string') {
      throw bad('bad_filename', `items[${i}].filename must be a string.`, { details: { item: i }, docs: '/docs#output' });
    }
    return { index: i, data, filename: raw.filename || null };
  });

  return { items: parsed, output, response, onError, opts, dataBytes };
}

/**
 * A synchronous batch that asks for PDFs is bounded by the HTTP connection, not
 * by our own patience. LibreOffice is serialised at about 2.6 s per document, so
 * beyond `maxSyncBatchPdfItems` the answer arrives after the proxy has already
 * hung up and the caller sees a dropped connection with no error in it — the
 * worst possible failure, because there is nothing to report. Refuse instead,
 * and say where the same work does fit.
 */
function assertSyncPdfLimit(spec) {
  if (spec.output === 'document') return;
  if (spec.items.length <= config.maxSyncBatchPdfItems) return;
  throw new ApiError(413, 'batch_pdf_too_large',
    `A synchronous batch can convert at most ${config.maxSyncBatchPdfItems} documents to PDF; this one asks for ${spec.items.length}.`, {
      hint: `PDF conversion runs one at a time (about 2.6 s each), so ${spec.items.length} of them would take roughly ${Math.round(spec.items.length * 2.6)} seconds and the connection would time out first. Send the same body to POST /v1/jobs with a "webhook_url" and collect the result when it is done, or ask for "output":"document" which is not throttled.`,
      details: { items: spec.items.length, max_items: config.maxSyncBatchPdfItems, output: spec.output },
      docs: '/docs#async',
    });
}

/**
 * Refuses a batch that cannot possibly be paid for, BEFORE anything is rendered,
 * and says how many of the items would have fitted. Taking 60 credits of work
 * from an account with 40 left and discovering it at item 41 leaves the caller
 * with a partial run they have to reconcile by hand.
 */
function assertAffordable(account, perItem, count) {
  const limit = Number(account.credits_limit);
  const used = Number(account.credits_used);
  const remaining = Math.max(0, limit - used);
  const need = perItem * count;
  if (need <= remaining) return need;
  const affordable = Math.floor(remaining / perItem);
  throw new ApiError(402, 'batch_exceeds_quota',
    `This batch needs ${need} of your monthly documents but only ${remaining} are left on the ${account.plan} plan, which is enough for ${affordable} of its ${count} items.`, {
      hint: affordable > 0
        ? `Nothing was rendered and nothing was charged. Send the first ${affordable} items now and the rest after the quota resets on the 1st, or raise the limit at /dashboard.`
        : 'Nothing was rendered and nothing was charged. The quota resets on the 1st of next month; to raise it now, upgrade at /dashboard.',
      details: {
        items: count, affordable_items: affordable, credits_needed: need,
        credits_remaining: remaining, credits_limit: limit, plan: account.plan,
      },
      docs: '/docs#quota',
    });
}

/* ---------------------------------------------------------------- running */

const errorObject = (e) => (e instanceof ApiError
  ? { code: e.code, message: e.message, ...(e.hint ? { hint: e.hint } : {}), ...(e.docs ? { docs: e.docs } : {}), ...(e.details ? { details: e.details } : {}) }
  : { code: 'internal_error', message: String(e && e.message ? e.message : e).slice(0, 400) });

/** In "fail" mode the failing item's own error becomes the batch's error. */
function failBatch(e, index, done) {
  const base = e instanceof ApiError ? e : new ApiError(500, 'render_failed', String(e.message || e));
  return new ApiError(base.status, base.code, `items[${index}]: ${base.message}`, {
    hint: [base.hint, 'The batch stopped at the first failure and nothing was charged. Send "on_error":"continue" to render every item and get a per-item error instead.'].filter(Boolean).join(' '),
    docs: base.docs || '/docs#batch',
    details: { ...(base.details || {}), item: index, items_completed: done },
  });
}

/**
 * Renders every item. Returns one record per item, in the order they were sent.
 *
 * `isCancelled` is polled between items rather than per item: on the production
 * database a trivial query has been measured at 450 ms, so asking once per
 * document would cost more than the document does.
 */
async function runBatch({ account, spec, templateBuffer, log: l = log, deadlineAt = Date.now() + config.batchBudgetMs, isCancelled = null }) {
  const { items, output, opts, onError } = spec;
  const records = items.map((it) => ({ index: it.index, ok: false, error: null, warnings: [], ms: 0 }));
  const stages = { fill: 0, pdf: 0, zip: 0 };
  const wantPdf = output === 'pdf' || output === 'both';
  const wantDoc = output !== 'pdf';

  let cancelledAt = 0;
  let cancelled = false;
  const checkCancelled = async () => {
    if (!isCancelled || cancelled) return cancelled;
    if (Date.now() - cancelledAt < 2000) return false;
    cancelledAt = Date.now();
    cancelled = await isCancelled();
    return cancelled;
  };

  const overBudget = () => Date.now() > deadlineAt;
  const budgetError = () => new ApiError(504, 'batch_budget_exceeded',
    `This batch ran past its ${Math.round(config.batchBudgetMs / 1000)} second budget and the remaining items were not rendered.`, {
      hint: 'Split the batch, or queue it with POST /v1/jobs where there is no connection to time out.',
      docs: '/docs#batch',
    });

  /* ---- stage 1: fill. Cheap (2.9-69 ms), unthrottled, straight through. ---- */
  for (let i = 0; i < items.length; i += 1) {
    const rec = records[i];
    // eslint-disable-next-line no-await-in-loop
    if (await checkCancelled()) { rec.error = { code: 'job_cancelled', message: 'Cancelled before this item was rendered.' }; continue; }
    if (overBudget()) {
      const e = budgetError();
      if (onError === 'fail') throw failBatch(e, i, i);
      rec.error = errorObject(e);
      continue;
    }
    const started = process.hrtime.bigint();
    try {
      // eslint-disable-next-line no-await-in-loop
      const filled = await renderer.fill(templateBuffer, items[i].data, { ...opts, log: quiet(l) });
      const ext = FORMATS[filled.format].ext;
      rec.format = filled.format;
      rec.docBuffer = filled.buffer;
      rec.docName = nameFor(items[i], ext, opts, i);
      rec.pdfName = nameFor(items[i], 'pdf', opts, i);
      rec.warnings = filled.warnings;
      rec.stats = filled.stats;
      rec.ok = true;
    } catch (e) {
      if (onError === 'fail') throw failBatch(e, i, records.filter((r) => r.ok).length);
      rec.error = errorObject(e);
      l.debug('batch.item_failed', { item: i, code: rec.error.code, stage: 'fill' });
    }
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    rec.ms += ms;
    stages.fill += ms;
    l.debug('batch.item', { item: i, ok: rec.ok, stage: 'fill', format: rec.format || null, bytes: rec.docBuffer ? rec.docBuffer.length : 0, ms: Math.round(ms * 10) / 10 });
  }

  /* ---- stage 2: PDF. 2.6 s each and serialised by the semaphore in pdf.js. ---- */
  if (wantPdf) {
    const pending = records.filter((r) => r.ok).map((r) => r.index);
    let next = 0;
    let stop = null;
    // Exactly as many in flight as the semaphore will admit. More would only sit
    // in pdf.js's queue, where they would push interactive single renders out
    // and eventually trip pdf_queue_full on somebody else's request.
    const lanes = Math.max(1, Math.min(config.maxConcurrentPdf, pending.length));
    const lane = async () => {
      for (;;) {
        if (stop) return;
        const i = pending[next]; next += 1;
        if (i === undefined) return;
        const rec = records[i];
        // eslint-disable-next-line no-await-in-loop
        if (await checkCancelled()) { rec.ok = false; rec.error = { code: 'job_cancelled', message: 'Cancelled before this item was converted to PDF.' }; continue; }
        if (overBudget()) {
          const e = budgetError();
          if (onError === 'fail') { stop = failBatch(e, i, records.filter((r) => r.ok).length); return; }
          rec.ok = false; rec.error = errorObject(e);
          continue;
        }
        const started = process.hrtime.bigint();
        try {
          // eslint-disable-next-line no-await-in-loop
          const out = await pdf.toPdf(rec.docBuffer, rec.format, { log: quiet(l) });
          rec.pdfBuffer = out.buffer;
          rec.pages = out.pages;
          rec.pdfQueuedMs = out.queuedMs;
        } catch (e) {
          if (onError === 'fail') { stop = failBatch(e, i, records.filter((r) => r.ok).length); return; }
          rec.ok = false;
          rec.error = errorObject(e);
          l.debug('batch.item_failed', { item: i, code: rec.error.code, stage: 'pdf' });
        }
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        rec.ms += ms;
        stages.pdf += ms;
        l.debug('batch.item', { item: i, ok: rec.ok, stage: 'pdf', pages: rec.pages || null, bytes: rec.pdfBuffer ? rec.pdfBuffer.length : 0, ms: Math.round(ms * 10) / 10 });
      }
    };
    await Promise.all(Array.from({ length: lanes }, lane));
    if (stop) throw stop;
    // The Office bytes were only ever a step on the way to the PDF.
    if (output === 'pdf') for (const r of records) r.docBuffer = null;
  }

  for (const r of records) {
    r.ms = Math.round(r.ms * 10) / 10;
    if (r.ok && wantPdf && !r.pdfBuffer) { r.ok = false; if (!r.error) r.error = { code: 'pdf_missing', message: 'No PDF was produced for this item.' }; }
    if (r.ok && wantDoc && !r.docBuffer && output !== 'pdf') { r.ok = false; }
  }

  const ok = records.filter((r) => r.ok).length;
  return {
    records,
    ok,
    failed: records.length - ok,
    cancelled,
    stages: { fill: round1(stages.fill), pdf: round1(stages.pdf) },
  };
}

const round1 = (n) => Math.round(n * 10) / 10;

/**
 * Per-item logs are debug-level and per-batch logs are info-level, so a hundred
 * item lines do not drown the one line that says what the batch did. The
 * renderer's own info line is silenced for the same reason: a 100-item batch
 * would otherwise write 100 `fill.ok` lines nobody asked for.
 */
function quiet(l) {
  return { debug: (e, f) => l.debug(e, f), info: () => {}, warn: (e, f) => l.warn(e, f), error: (e, f) => l.error(e, f) };
}

/** A batch needs distinct names, so an item with no filename gets its position. */
function nameFor(item, ext, opts, index) {
  if (item.filename) return input.renderFilename(item.filename, item.data, ext, opts);
  return `document-${index + 1}.${ext}`;
}

/* ------------------------------------------------------------------- files */

/** Every file a finished batch produced, in item order. */
function filesOf(records, output) {
  const files = [];
  for (const r of records) {
    if (!r.ok) continue;
    if (output !== 'pdf' && r.docBuffer) {
      files.push({ index: r.index, filename: r.docName, content_type: FORMATS[r.format].mime, buffer: r.docBuffer });
    }
    if (r.pdfBuffer) {
      files.push({ index: r.index, filename: r.pdfName, content_type: 'application/pdf', buffer: r.pdfBuffer });
    }
  }
  return files;
}

/**
 * Makes a name unique inside one archive.
 *
 * Two items whose filename pattern resolves to the same string is not an error —
 * two invoices for the same customer in one run is completely ordinary — but
 * silently keeping only the last one would be. Most zip readers show both
 * entries and extract whichever they hit last, so the loss would not even be
 * visible until somebody counted the files.
 */
function uniqueName(name, used) {
  if (!used.has(name)) { used.add(name); return name; }
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let n = 2; ; n += 1) {
    const candidate = `${stem}-${n}${ext}`;
    if (!used.has(candidate)) { used.add(candidate); return candidate; }
  }
}

/**
 * A real zip, built with the package writer this project already owns rather
 * than with a new dependency. `addEntry` marks every entry dirty, so each file
 * is deflated on the way in; nothing here relies on the byte-for-byte
 * passthrough that matters when rewriting an Office package.
 */
function buildZip(files, { errors = [] } = {}) {
  const zip = { entries: [], byName: new Map() };
  const used = new Set();
  const names = [];
  for (const f of files) {
    const name = uniqueName(f.filename, used);
    names.push({ index: f.index, name });
    addEntry(zip, name, f.buffer);
  }
  // With on_error "continue" the failures have nowhere else to go: a zip has no
  // status codes. Without this the caller gets 17 files back from a 20-item batch
  // and no way to find out which three are missing or why.
  if (errors.length) {
    addEntry(zip, 'errors.json', Buffer.from(`${JSON.stringify({ failed: errors.length, items: errors }, null, 2)}\n`, 'utf8'));
    names.push({ index: null, name: 'errors.json' });
  }
  return { buffer: writeZip(zip), names };
}

/* -------------------------------------------------------------- responses */

/** The JSON body for one item, matching what POST /v1/render returns for one document. */
function itemJson(r, output, { base64 = true } = {}) {
  if (!r.ok) return { index: r.index, ok: false, error: r.error };
  const out = { index: r.index, ok: true, format: r.format, ms: r.ms };
  if (output !== 'pdf' && r.docBuffer) {
    out.document = {
      filename: r.docName, content_type: FORMATS[r.format].mime, size: r.docBuffer.length,
      ...(base64 ? { base64: r.docBuffer.toString('base64') } : {}),
    };
  }
  if (r.pdfBuffer) {
    out.pdf = {
      filename: r.pdfName, content_type: 'application/pdf', size: r.pdfBuffer.length, pages: r.pages,
      ...(base64 ? { base64: r.pdfBuffer.toString('base64') } : {}),
    };
  }
  if (r.warnings && r.warnings.length) out.warnings = r.warnings;
  return out;
}

const failedItems = (records) => records.filter((r) => !r.ok).map((r) => ({ index: r.index, error: r.error }));

module.exports = {
  BATCH_FIELDS, ITEM_FIELDS,
  parseBatch, assertSyncPdfLimit, assertAffordable,
  runBatch, filesOf, buildZip, itemJson, failedItems, uniqueName, errorObject,
};
