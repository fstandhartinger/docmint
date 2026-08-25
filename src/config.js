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

  fileTtlMinutesDefault: num(process.env.FILE_TTL_MINUTES, 60),
  fileTtlMinutesMax: num(process.env.FILE_TTL_MINUTES_MAX, 10080), // 7 days
  maxStoredFileBytes: num(process.env.MAX_STORED_FILE_BYTES, 40 * 1024 * 1024),

  origin: process.env.DOCMINT_ORIGIN
    || ((process.env.PUBLIC_URL || '').includes('onrender.com') ? 'production' : 'dev'),

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
