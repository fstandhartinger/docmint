'use strict';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

const config = {
  port: num(process.env.PORT, 3000),
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  databaseUrl: process.env.DATABASE_URL || '',
  sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret',

  // Limits. These are the numbers quoted in the docs; keep them in sync, and if
  // you change one here, change the docs in the same commit.
  maxTemplateBytes: num(process.env.MAX_TEMPLATE_BYTES, 25 * 1024 * 1024),
  maxDataBytes: num(process.env.MAX_DATA_BYTES, 8 * 1024 * 1024),
  maxRequestBytes: num(process.env.MAX_REQUEST_BYTES, 36 * 1024 * 1024),
  maxVersionsKept: num(process.env.MAX_VERSIONS_KEPT, 20),

  // LibreOffice is the expensive path: measured at 219 MB peak RSS and about one
  // second per conversion. Everything else in this service is single-digit
  // milliseconds and a few megabytes. So PDF conversion gets its own small
  // semaphore, sized to the container, while filling stays unthrottled.
  maxConcurrentPdf: num(process.env.MAX_CONCURRENT_PDF, 1),
  pdfQueueLimit: num(process.env.PDF_QUEUE_LIMIT, 24),
  pdfTimeoutMs: num(process.env.PDF_TIMEOUT_MS, 90000),
  sofficeBin: process.env.SOFFICE_BIN || 'soffice',

  /**
   * Batch limits, derived from measurement rather than chosen because they look
   * round. All of these were taken on this codebase with fixtures/invoice.docx,
   * one node process, `renderer.fill` called in a loop:
   *
   *   3 line items      2.9 ms mean per item (p95 4.1 ms) — 100 items in 294 ms
   *   200 line items   32.4 ms mean per item              — 100 items in 3.2 s, 127 MB peak RSS
   *   500 line items   69.0 ms mean per item              — 200 items in 13.8 s, 152 MB peak RSS
   *
   * So the fill stage is cheap and, crucially, its memory is bounded by the
   * documents held for the response, not by the item count: 200 heavy invoices
   * were 2.65 MB of output in total. 100 items is therefore at most about 7 s of
   * CPU on the worst template measured, and leaves a 512 MB instance the room
   * LibreOffice's 219 MB needs. 100 also matches what Carbone caps a batch at,
   * so nobody has to rewrite a loop when they move across.
   */
  maxBatchItems: num(process.env.MAX_BATCH_ITEMS, 100),

  /**
   * PDF is the opposite of cheap and it does not parallelise: `maxConcurrentPdf`
   * is 1, and two simultaneous PDF renders on the production instance were
   * measured returning at 3,371 ms and 5,740 ms — perfectly serial, about 2.6 s
   * each. Twenty of them is roughly 52 s, which still fits inside the 100 s
   * proxy timeout in front of the service with room for the fill and the
   * response. Beyond that the connection dies before the answer arrives and the
   * caller sees nothing at all, so a bigger PDF batch is refused with a pointer
   * to POST /v1/jobs, where there is no connection to lose.
   */
  maxSyncBatchPdfItems: num(process.env.MAX_SYNC_BATCH_PDF_ITEMS, 20),

  /**
   * Wall-clock ceiling for one batch, matching Carbone's published 5-minute
   * budget. It is a backstop, not the normal limit: the item caps above are what
   * actually bind. It exists because a template that is pathologically slow on
   * one particular dataset must not hold a worker for an unbounded time.
   */
  batchBudgetMs: num(process.env.BATCH_BUDGET_MS, 300000),

  /* ---------------------------------------------------------- async jobs */

  // How often an idle worker asks the database for work. 1.5 s costs one trivial
  // query per instance per second and a half; anything faster is noise on the
  // connection pool, anything slower is latency a caller can feel.
  jobPollMs: num(process.env.JOB_POLL_MS, 1500),
  // A webhook receiver that is down for a moment should not lose the delivery,
  // and one that is down for good must not be retried forever. Three attempts
  // with 4 s and 8 s between them covers a restart without becoming a stampede.
  jobWebhookAttempts: num(process.env.JOB_WEBHOOK_ATTEMPTS, 3),
  jobWebhookTimeoutMs: num(process.env.JOB_WEBHOOK_TIMEOUT_MS, 15000),
  jobRetentionDays: num(process.env.JOB_RETENTION_DAYS, 7),
  // A job's files are downloaded once, usually within seconds of the webhook.
  // 24 hours is generous for a retry and short enough that the files table does
  // not become the product's storage tier.
  jobFileTtlMinutes: num(process.env.JOB_FILE_TTL_MINUTES, 1440),
  // Only a process that says it is the worker runs jobs. The queue lives in the
  // database, so any process pointed at that database would otherwise pick up
  // production's jobs — including a developer's laptop, which has no LibreOffice.
  jobsWorker: process.env.JOBS_WORKER !== '0',

  // Lets a local test point a webhook at 127.0.0.1. Never set in production:
  // with it on, `webhook_url` is a server-side request forgery primitive.
  allowPrivateNetwork: process.env.ALLOW_PRIVATE_NETWORK === '1',

  fileTtlMinutesDefault: num(process.env.FILE_TTL_MINUTES, 60),
  fileTtlMinutesMax: num(process.env.FILE_TTL_MINUTES_MAX, 10080), // 7 days
  maxStoredFileBytes: num(process.env.MAX_STORED_FILE_BYTES, 40 * 1024 * 1024),

  // Identifies this deployment in the usage log. It used to be derived from
  // PUBLIC_URL containing 'onrender.com', which meant that putting a real domain
  // in front would silently demote production to 'dev'. Deployment identity is
  // not a function of which hostname we happen to answer on.
  origin: process.env.DOCMINT_ORIGIN
    || (process.env.NODE_ENV === 'production' ? 'production' : 'dev'),

  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    publishableKey: process.env.STRIPE_PUBLISHABLE_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },
};

/**
 * Plans. `credits` is documents produced per calendar month. A PDF conversion
 * costs one extra credit on top of the fill, because it costs us roughly a
 * hundred times more CPU and pretending otherwise would mean the cheap path
 * subsidising the expensive one.
 */
const PLANS = {
  free:    { id: 'free',    name: 'Free',    credits: 30,     priceUsd: 0,  stripePriceEnv: null },
  starter: { id: 'starter', name: 'Starter', credits: 2000,   priceUsd: 9,  stripePriceEnv: 'STRIPE_PRICE_STARTER' },
  pro:     { id: 'pro',     name: 'Pro',     credits: 20000,  priceUsd: 29, stripePriceEnv: 'STRIPE_PRICE_PRO' },
  scale:   { id: 'scale',   name: 'Scale',   credits: 100000, priceUsd: 99, stripePriceEnv: 'STRIPE_PRICE_SCALE' },
};

function planPriceId(planId) {
  const p = PLANS[planId];
  if (!p || !p.stripePriceEnv) return null;
  return process.env[p.stripePriceEnv] || null;
}

/** The formats we fill, and what a template of each is called. */
const FORMATS = {
  docx: { ext: 'docx', name: 'Word document',  mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
  xlsx: { ext: 'xlsx', name: 'Excel workbook', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
  pptx: { ext: 'pptx', name: 'PowerPoint deck', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
};

module.exports = { config, PLANS, planPriceId, FORMATS };
