'use strict';

const crypto = require('node:crypto');

const { config, FORMATS } = require('./config');
const { ApiError } = require('./errors');
const { query, tx } = require('./db');
const { assertPublicUrl, postJson } = require('./net');
const batch = require('./batch');
const { recordUsage } = require('./usage');
const log = require('./log');

/**
 * Asynchronous rendering: a Postgres-backed queue, polled in-process.
 *
 * The queue is a table rather than a list in memory on purpose. This service
 * restarts on every deploy, and a 500-invoice run that only existed in a
 * process's heap would vanish mid-flight with no way for the caller to find out
 * how far it got. A table also means the answer to "what happened to job X" is
 * the same answer after a restart as before one.
 *
 * There is deliberately no Redis, no SQS and no separate worker service. The
 * work is minutes of CPU per month for a normal account; a second piece of
 * infrastructure to operate would cost more than it saves, and every failure
 * mode it adds is one nobody would be watching for.
 */

const CANCELLABLE = "('queued','running')";

/* --------------------------------------------------------------- storage */

/**
 * Job results are files, sometimes tens of megabytes of them, so they go in the
 * `files` table with a TTL and the job row keeps a token. A base64 blob in the
 * job row would be read back in full by every GET /v1/jobs and every listing.
 */
async function storeFile(accountId, buffer, filename, contentType, ttlMinutes) {
  if (buffer.length > config.maxStoredFileBytes) {
    throw new ApiError(413, 'file_too_large',
      `The result is ${(buffer.length / 1048576).toFixed(1)} MB, over the ${(config.maxStoredFileBytes / 1048576).toFixed(0)} MB limit for hosted files.`, {
        hint: 'Split the batch, or ask for "output":"document" rather than "both" so only one file per item is kept.',
        docs: '/docs#limits',
      });
  }
  const token = crypto.randomBytes(18).toString('base64url');
  const ttl = Math.min(Math.max(Number(ttlMinutes) || config.jobFileTtlMinutes, 1), config.fileTtlMinutesMax);
  await query(
    `INSERT INTO files (token, account_id, filename, content_type, bytes, size, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
    [token, accountId, filename, contentType, buffer, buffer.length, String(ttl)],
  );
  // Only the path is stored. The absolute URL is built per response from the host
  // that is actually answering, so a link can never point at whichever instance
  // happened to do the rendering.
  return { token, path: `/f/${token}`, filename, content_type: contentType, size: buffer.length, expires_in_minutes: ttl };
}

/* ------------------------------------------------------------------ queue */

async function enqueue(accountId, { kind, request, webhookUrl, creditsReserved }) {
  const id = `job_${crypto.randomBytes(12).toString('base64url')}`;
  await query(
    `INSERT INTO jobs (id, account_id, kind, request, webhook_url, credits_reserved)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [id, accountId, kind, JSON.stringify(request), webhookUrl || null, creditsReserved],
  );
  return id;
}

const NOT_FOUND = (id) => new ApiError(404, 'job_not_found', `There is no job called "${id}" on this account.`, {
  hint: 'Job ids are returned by POST /v1/jobs and look like job_XXXX. They belong to the account that created them, and finished jobs are kept for '
    + `${config.jobRetentionDays} days.`,
  docs: '/docs#async',
});

const publicJob = (j) => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  created_at: j.created_at,
  started_at: j.started_at,
  finished_at: j.finished_at,
  ...(j.result ? { result: j.result } : {}),
  ...(j.error ? { error: j.error } : {}),
  ...(j.webhook_url ? { webhook: {
    url: j.webhook_url, status: j.webhook_status, attempts: j.webhook_attempts || [],
    delivery_id: j.webhook_delivery_id,
    next_attempt_at: j.webhook_next_at || j.webhook_lease_until,
  } } : {}),
});

async function get(accountId, id) {
  const { rows } = await query(
    `SELECT id, kind, status, result, error, created_at, started_at, finished_at,
            webhook_url, webhook_status, webhook_attempts, webhook_delivery_id, webhook_next_at, webhook_lease_until
       FROM jobs WHERE id = $1 AND account_id = $2`,
    [id, accountId],
  );
  if (!rows.length) throw NOT_FOUND(id);
  return publicJob(rows[0]);
}

async function list(accountId, limit = 25) {
  const n = Math.min(Math.max(Number(limit) || 25, 1), 100);
  const { rows } = await query(
    `SELECT id, kind, status, result, error, created_at, started_at, finished_at,
            webhook_url, webhook_status, webhook_attempts, webhook_delivery_id, webhook_next_at, webhook_lease_until
       FROM jobs WHERE account_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [accountId, n],
  );
  // The listing carries the summary, not the per-item detail: a page of twenty
  // 100-item batches would otherwise be two thousand item records nobody read.
  return rows.map((j) => {
    const out = publicJob(j);
    if (out.result) {
      const { items, ...summary } = out.result;
      out.result = { ...summary, ...(items ? { items: items.length } : {}) };
    }
    return out;
  });
}

/**
 * Cancels a queued or running job and gives back every credit it reserved.
 *
 * A queued job is stopped before it renders anything. A running one is already
 * inside a batch loop; this cannot reach in and stop it mid-item, but the loop
 * checks the row between items, so a 100-item batch stops within one document
 * rather than after ninety-nine. Either way the caller stops paying for work
 * they said they no longer want.
 *
 * The credit release is a single statement that zeroes the reservation and
 * returns what it was, so a cancel racing the worker's own settlement can only
 * refund once.
 */
async function cancel(accountId, id) {
  const { rows } = await query(
    `UPDATE jobs
        SET status      = 'cancelled',
            finished_at = now(),
            error       = jsonb_build_object(
                            'code', 'job_cancelled',
                            'message', 'This job was cancelled before it finished.')
      WHERE id = $1 AND account_id = $2 AND status IN ${CANCELLABLE}
      RETURNING id, status`,
    [id, accountId],
  );
  if (rows.length) {
    await settleCredits(id, accountId, 0);
    return { id, status: 'cancelled' };
  }
  const { rows: found } = await query(`SELECT status FROM jobs WHERE id = $1 AND account_id = $2`, [id, accountId]);
  if (!found.length) throw NOT_FOUND(id);
  throw new ApiError(409, 'job_already_finished',
    `That job is already "${found[0].status}", so there is nothing left to cancel.`, {
      hint: 'Only a queued or running job can be cancelled. Fetch it with GET /v1/jobs/{id} to see what it produced.',
      docs: '/docs#async',
    });
}

/**
 * Charges `keep` credits of whatever the job reserved and refunds the rest,
 * exactly once. `credits_reserved` is both the amount and the claim on it: the
 * statement zeroes it and returns the old value in the same round trip, so the
 * worker finishing and a cancel arriving at the same moment cannot both refund.
 */
async function settleCredits(jobId, accountId, keep) {
  // Claim consumption and the account refund must commit together. Otherwise a
  // failed account UPDATE erases the only durable evidence that a refund is owed.
  return tx(async (client) => {
    const { rows } = await client.query(
      // An already settled job keeps its real charge, even if later work fails.
      `UPDATE jobs j
          SET credits_reserved = 0,
              credits_charged = CASE WHEN old.credits_reserved > 0 THEN $2 ELSE j.credits_charged END
         FROM (SELECT id, credits_reserved FROM jobs WHERE id = $1 FOR UPDATE) old
        WHERE j.id = old.id
        RETURNING old.credits_reserved AS was`,
      [jobId, keep],
    );
    const was = rows.length ? Number(rows[0].was) : 0;
    const refund = was - keep;
    if (refund > 0) {
      await client.query(`UPDATE accounts SET credits_used = GREATEST(0, credits_used - $2) WHERE id = $1`, [accountId, refund]);
    }
    return { charged: Math.min(keep, was), refunded: Math.max(0, refund) };
  });
}

/** Claims one queued job, so two instances never take the same row. */
async function claim() {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!rows.length) return null;
    await client.query(`UPDATE jobs SET status = 'running', started_at = now() WHERE id = $1`, [rows[0].id]);
    return rows[0];
  });
}

const isCancelledNow = async (id) => {
  const { rows } = await query(`SELECT status FROM jobs WHERE id = $1`, [id]).catch(() => ({ rows: [] }));
  return rows.length ? rows[0].status === 'cancelled' : false;
};

/* ------------------------------------------------------------------ webhook */

/**
 * Signs and delivers one webhook, with bounded retries, recording every attempt.
 *
 * Anything that learns a webhook URL could otherwise forge a "succeeded" call
 * into the customer's workflow. The signature is HMAC-SHA256 over
 * `timestamp.body` with the account's own secret, so a receiver can verify both
 * that it came from us and that it is not a replay of an older delivery.
 *
 * The URL is re-checked against the SSRF rules on every attempt, not only when
 * the job was created: a name that resolved to a public address at enqueue time
 * can resolve to 169.254.169.254 by the time we call it.
 */
/** Terminal jobs are their own durable outbox; delivery never renders or settles.
 * Reserve attempts before HTTP and CAS receipts by lease token. Lost acknowledgements
 * can repeat an ID/body: receivers must deduplicate. Crashes consume the budget. */
async function claimDelivery() {
  return tx(async (client) => {
    const { rows } = await client.query(
      `SELECT * FROM jobs WHERE status IN ('succeeded','failed','cancelled')
         AND webhook_url IS NOT NULL
         AND (webhook_status IS NULL OR webhook_status IN ('pending','delivering')
           OR (webhook_status = 'failed' AND webhook_delivery_id IS NULL
               AND jsonb_array_length(COALESCE(webhook_attempts, '[]'::jsonb)) < $1))
         AND (webhook_next_at IS NULL OR webhook_next_at <= now())
         AND (webhook_lease_until IS NULL OR webhook_lease_until <= now())
       ORDER BY finished_at LIMIT 1 FOR UPDATE SKIP LOCKED`, [config.jobWebhookAttempts],
    );
    if (!rows.length) return null;
    const job = rows[0];
    const attempts = job.webhook_attempts || [];
    if (attempts.length >= config.jobWebhookAttempts) {
      await client.query(`UPDATE jobs SET webhook_status = 'failed', webhook_next_at = NULL,
        webhook_lease_until = NULL, webhook_lease_token = NULL WHERE id = $1`, [job.id]);
      return null;
    }
    const token = crypto.randomBytes(18).toString('hex');
    const id = job.webhook_delivery_id || `${job.id}:${job.status}`;
    const body = job.webhook_body || JSON.stringify(webhookPayload(job, job.status,
      job.result ? { result: absolutise(job.result) } : { error: job.error }));
    attempts.push({ attempt: attempts.length + 1, at: new Date().toISOString(), ok: false, error: 'interrupted', status: null });
    await client.query(`UPDATE jobs SET webhook_status = 'delivering', webhook_delivery_id = $2,
      webhook_body = $3, webhook_attempts = $4::jsonb, webhook_lease_token = $5,
      webhook_lease_until = now() + ($6 || ' milliseconds')::interval,
      webhook_next_at = NULL WHERE id = $1`,
    [job.id, id, body, JSON.stringify(attempts), token, String(config.jobWebhookTimeoutMs + 1000)]);
    return { ...job, webhook_delivery_id: id, webhook_body: body, webhook_attempts: attempts, webhook_lease_token: token };
  });
}

async function deliverPending() {
  const job = await claimDelivery();
  if (!job) return;
  const body = job.webhook_body;
  const attempts = job.webhook_attempts;
  const attempt = attempts.length;
  let out;
  try {
    const { rows } = await query(`SELECT webhook_secret FROM accounts WHERE id = $1`, [job.account_id]);
    const secret = rows[0] && rows[0].webhook_secret;
    if (!secret) throw new Error('webhook signing secret unavailable');
    // DB lookup/response delays are outside HTTP's deadline. Revalidate ownership
    // before sending and budget even this UPDATE's round trip against the lease.
    const refreshStarted = Date.now();
    const refreshed = await query(`UPDATE jobs SET webhook_lease_until = now() + ($3 || ' milliseconds')::interval
      WHERE id = $1 AND webhook_lease_token = $2 AND webhook_lease_until > now() RETURNING id`,
    [job.id, job.webhook_lease_token, String(config.jobWebhookTimeoutMs + 1000)]);
    if (!refreshed.rowCount) return;
    const timeoutMs = config.jobWebhookTimeoutMs - (Date.now() - refreshStarted);
    if (timeoutMs <= 0) throw new Error('webhook lease refresh deadline exceeded');
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'DocMint-Webhook/1',
      'X-DocMint-Timestamp': String(timestamp),
      'X-DocMint-Job-Id': job.id,
      'X-DocMint-Event': `job.${job.status}`,
      'X-DocMint-Delivery-Id': job.webhook_delivery_id,
      'X-DocMint-Signature': `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`,
    };
    out = await postJson(job.webhook_url, { body, headers, timeoutMs });
  } catch (e) {
    out = { ok: false, status: null, error: e.message };
  }
  attempts[attempt - 1] = { ...attempts[attempt - 1], status: out.status, ok: out.ok, error: out.error };
  const status = out.ok ? 'delivered' : attempt >= config.jobWebhookAttempts ? 'failed' : 'pending';
  await query(`UPDATE jobs SET webhook_attempts = $2::jsonb, webhook_status = $3,
    webhook_next_at = CASE WHEN $3 = 'pending' THEN now() + ($4 || ' milliseconds')::interval ELSE NULL END,
    webhook_lease_until = NULL, webhook_lease_token = NULL
    WHERE id = $1 AND webhook_lease_token = $5`,
  [job.id, JSON.stringify(attempts), status, String(attempt * 4000), job.webhook_lease_token]);
  log.info('job.webhook_attempt', { job: job.id, attempt, status: out.status, ok: out.ok });
}

/* -------------------------------------------------------------- the runner */

/**
 * Runs one job. `loadTemplate(account, body, log)` is injected so this module
 * does not depend on the route layer, which depends on it.
 */
async function runJob(job, { loadTemplate }) {
  const l = log.child({ job: job.id, account: job.account_id });
  const t = log.timer();
  const body = job.request;

  const { rows } = await query(`SELECT * FROM accounts WHERE id = $1`, [job.account_id]);
  const account = rows[0];
  if (!account) throw new ApiError(410, 'account_gone', 'The account that queued this job no longer exists.');

  const spec = batch.parseBatch(body);
  const { buffer: templateBuffer, template, source } = await loadTemplate(account, body, l);
  t.mark('load');

  const run = await batch.runBatch({
    account, spec, templateBuffer, log: l,
    deadlineAt: Date.now() + config.batchBudgetMs,
    isCancelled: () => isCancelledNow(job.id),
  });
  t.mark('render');

  if (run.cancelled) {
    // The row already says cancelled and cancel() already released the credits.
    throw new ApiError(409, 'job_cancelled', 'This job was cancelled while it was running.');
  }

  // The files are stored BEFORE the credits are settled, and the order matters.
  // Settling first meant that a result too big to store - `file_too_large` is
  // raised inside storeFile - left the caller charged for a job that ended
  // "failed" and handed them nothing, because the reservation the failure path
  // refunds had already been zeroed by the settlement. Measured on 2026-09-06:
  // an 11-item batch charged 11 credits with `jobs.credits_charged` recording 0.
  // Storing first means a delivery failure still has a reservation to give back.
  const files = batch.filesOf(run.records, spec.output);
  const stored = [];
  if (files.length === 1 && spec.response !== 'zip') {
    stored.push(described(await storeFile(account.id, files[0].buffer, files[0].filename, files[0].content_type)));
  } else if (files.length) {
    const { buffer, names } = batch.buildZip(files, { errors: batch.failedItems(run.records) });
    const f = await storeFile(account.id, buffer, zipName(job.id), 'application/zip');
    stored.push({ ...described(f), entries: names.length });
  }
  t.mark('store');

  const perItem = creditsPerItem(spec.output);
  const settled = await settleCredits(job.id, account.id, perItem * run.ok);

  // Without this row the job is invisible to GET /v1/usage's breakdown and to
  // every report built on usage_events - including the one that decides whether
  // an account ever activated. Credits were always correct; the record of what
  // they were spent on stopped at the synchronous endpoints.
  await recordUsage(account.id, job.id, {
    kind: 'job',
    format: run.records.find((r) => r.format)?.format || null,
    template_id: template ? template.id : null,
    output: spec.output,
    credits: settled.charged,
    ok: run.failed === 0,
    error_code: run.failed ? 'partial' : null,
    ms: t.total(),
    stages: { ...t.stages(), ...run.stages },
  });

  l.info('job.ok', {
    kind: job.kind, output: spec.output, items: spec.items.length, ok: run.ok, failed: run.failed,
    files: files.length, bytes: stored.reduce((s, f) => s + f.size, 0),
    credits_charged: settled.charged, credits_refunded: settled.refunded,
    stages: { ...t.stages(), ...run.stages }, ms: t.total(),
  });

  return {
    kind: job.kind,
    output: spec.output,
    template: template ? { id: template.id, name: template.name } : { source },
    count: spec.items.length,
    ok: run.ok,
    failed: run.failed,
    files: stored,
    items: run.records.map((r) => batch.itemJson(r, spec.output, { base64: false })),
    credits: { used: settled.charged, refunded: settled.refunded },
    stats: { ms: t.total(), stages: { ...t.stages(), ...run.stages } },
  };
}

/**
 * What a stored file looks like in a job result. The token is deliberately
 * dropped: it is the download capability, and the URL built from it already
 * carries it. Keeping it in the row as well would put it in the listing, in the
 * webhook body and in anything that logs either of those.
 */
const described = ({ token, ...f }) => f;

const zipName = (jobId) => `${jobId.replace(/[^A-Za-z0-9_-]/g, '')}.zip`;

/** Kept in step with the CREDITS map in api.js; both say a PDF costs one more. */
const creditsPerItem = (output) => (output === 'document' ? 1 : 2);

/* ------------------------------------------------------------------ worker */

function startWorker(loadTemplate) {
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    let job = null;
    try {
      job = await claim();
      if (job) {
        const result = await runJob(job, { loadTemplate });
        // `AND status = 'running'` so a cancellation that landed mid-render is
        // not silently overwritten by the result the caller said they did not want.
        await query(
          `UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now()
            WHERE id = $1 AND status = 'running'`,
          [job.id, JSON.stringify(result)],
        );

      }
    } catch (e) {
      if (job) {
        const error = batch.errorObject(e);
        // Nothing was delivered, so nothing is charged. This is also the path a
        // crash inside a single item takes, which is why the release is here and
        // not only on the success side.
        const released = await settleCredits(job.id, job.account_id, 0).catch((err) => {
          // The transaction retained the reservation. Periodic recovery retries
          // it; a transient refund failure must not become an unhandled rejection.
          log.error('jobs.settle_failed', { job: job.id, err });
          return { refunded: 0, charged: 0 };
        });
        // Only a job that still held a reservation is unrecorded: if it was
        // already released, either the settlement succeeded and something after
        // it threw - in which case that settlement wrote the usage row - or a
        // cancel got there first, and a cancelled job charged nothing worth a
        // second row.
        if (released.refunded > 0) {
          await recordUsage(job.account_id, job.id, {
            kind: 'job', output: (job.request && job.request.output) || null,
            credits: 0, ok: false, error_code: error.code,
          });
        }
        await query(
          `UPDATE jobs SET status = 'failed', error = $2, finished_at = now()
            WHERE id = $1 AND status = 'running'`,
          [job.id, JSON.stringify(error)],
        ).catch(() => ({ rowCount: 0 }));
        log.warn('job.failed', { job: job.id, code: error.code, message: error.message });

      } else {
        log.warn('job.tick_failed', { err: e });
      }
    } finally {
      setTimeout(tick, job ? 50 : config.jobPollMs).unref();
    }
  };
  setTimeout(tick, 3000).unref();
  const deliveryTick = async () => {
    if (stopped) return;
    try { if (config.jobWebhookDeliveryEnabled !== false) await deliverPending(); }
    catch (e) { log.warn('job.delivery_tick_failed', { err: e }); }
    finally { if (!stopped) setTimeout(deliveryTick, config.jobPollMs).unref(); }
  };
  setTimeout(deliveryTick, 3000).unref();
  recoverStalled();
  recoverRefunds();
  const recoveryTimer = setInterval(() => { recoverStalled(); recoverRefunds(); }, 60000);
  recoveryTimer.unref();
  return () => { stopped = true; clearInterval(recoveryTimer); };
}

const webhookPayload = (job, status, extra) => ({
  job_id: job.id, kind: job.kind, status, created_at: job.created_at, ...extra,
});

/** The webhook has no request to take a host from, so it uses the configured public URL. */
function absolutise(result) {
  const base = (config.publicUrl || '').replace(/\/$/, '');
  return {
    ...result,
    files: (result.files || []).map(({ path, ...f }) => ({ ...f, url: `${base}${path}` })),
  };
}

/**
 * Anything left 'running' when the process died is retried ONCE, then failed.
 *
 * Without the attempts guard this is a crash loop: a dataset that exhausts the
 * renderer's memory kills the process before any catch block runs, so the job
 * stays 'running', is requeued on the next boot, and takes the service down
 * again on a timer. One caller's batch then becomes everyone's outage.
 */
function recoverStalled() {
  query(`UPDATE jobs
            SET status      = CASE WHEN attempts >= 1 THEN 'failed' ELSE 'queued' END,
                started_at  = NULL,
                attempts    = attempts + 1,
                finished_at = CASE WHEN attempts >= 1 THEN now() ELSE NULL END,
                error       = CASE WHEN attempts >= 1 THEN
                  jsonb_build_object(
                    'code', 'renderer_crashed',
                    'message', 'The renderer stopped before this job finished, twice. The batch is most likely too large or one dataset is pathological.',
                    'hint', 'Split the batch and try again; if one item is at fault, "on_error":"continue" will tell you which.')
                  ELSE error END
          WHERE status = 'running' AND started_at < now() - interval '15 minutes'
          RETURNING id, account_id, status`)
    .then(async (r) => {
      if (!r.rowCount) return;
      const dead = r.rows.filter((j) => j.status === 'failed');
      // A crash kills the process before the in-flight settlement can refund, so
      // the credits are given back here instead. Without this the caller is
      // billed for exactly the failure the docs promise is free.
      for (const j of dead) {
        // eslint-disable-next-line no-await-in-loop
        await settleCredits(j.id, j.account_id, 0);
        // A job killed by a crash never reaches the worker's failure path, so
        // this is the only chance to record that it happened. Without it the one
        // failure mode that costs a customer a wait is the one missing from the
        // usage record.
        // eslint-disable-next-line no-await-in-loop
        await recordUsage(j.account_id, j.id, { kind: 'job', credits: 0, ok: false, error_code: 'renderer_crashed' });
      }
      log.info('jobs.recovered', { total: r.rowCount, requeued: r.rowCount - dead.length, failed: dead.length });
    })
    .catch((e) => log.warn('jobs.recover_failed', { err: e }));
}

/** Failed/cancelled terminal rows can still own a refund after a DB outage. */
async function recoverRefunds() {
  try {
    const { rows } = await query(`SELECT id, account_id FROM jobs
      WHERE status IN ('failed','cancelled') AND credits_reserved > 0
      ORDER BY finished_at LIMIT 100`);
    for (const job of rows) {
      await settleCredits(job.id, job.account_id, 0);
    }
  } catch (err) { log.warn('jobs.refund_recovery_failed', { err }); }
}

/** Finished jobs and expired files are deleted in-process; neither needs a cron. */
function startReapers() {
  const tick = () => {
    query(`DELETE FROM jobs WHERE finished_at < now() - ($1 || ' days')::interval
      AND credits_reserved = 0
      AND (webhook_url IS NULL OR webhook_status = 'delivered'
        OR (webhook_status = 'failed' AND (webhook_delivery_id IS NOT NULL
          OR jsonb_array_length(COALESCE(webhook_attempts, '[]'::jsonb)) >= $2)))`,
    [String(config.jobRetentionDays), config.jobWebhookAttempts])
      .then((r) => { if (r.rowCount) log.info('jobs.reaped', { deleted: r.rowCount }); })
      .catch((e) => log.warn('jobs.reap_failed', { err: e }));
    query(`DELETE FROM files WHERE expires_at < now()`)
      .then((r) => { if (r.rowCount) log.info('files.reaped', { deleted: r.rowCount }); })
      .catch((e) => log.warn('files.reap_failed', { err: e }));
  };
  setInterval(tick, 10 * 60 * 1000).unref();
  setTimeout(tick, 30000).unref();
}

module.exports = {
  enqueue, get, list, cancel, storeFile, runJob, startWorker, startReapers,
  settleCredits, creditsPerItem, assertPublicUrl, FORMATS,
};
