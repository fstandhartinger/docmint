'use strict';

const { config } = require('./config');
const { query } = require('./db');
const log = require('./log');

/**
 * One row per billable operation, whoever performed it.
 *
 * This lives in its own module rather than in the route layer because the
 * asynchronous worker has to write the same rows and cannot require api.js —
 * api.js requires jobs.js. It used to be a private function inside api.js, which
 * is precisely why every job ever run was missing from the table: the only code
 * that could write a usage row was code that answered an HTTP request.
 */
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

module.exports = { recordUsage };
