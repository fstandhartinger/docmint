'use strict';

const crypto = require('node:crypto');

const { config, FORMATS } = require('./config');
const { ApiError } = require('./errors');
const { query, tx } = require('./db');
const { assertPublicUrl, postJson } = require('./net');
const batch = require('./batch');
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
  ...(j.webhook_url ? { webhook: { url: j.webhook_url, status: j.webhook_status, attempts: j.webhook_attempts || [] } } : {}),
});

async function get(accountId, id) {
  const { rows } = await query(
    `SELECT id, kind, status, result, error, created_at, started_at, finished_at,
            webhook_url, webhook_status, webhook_attempts
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
            webhook_url, webhook_status, webhook_attempts
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
  const { rows } = await query(
    `UPDATE jobs j
        SET credits_reserved = 0, credits_charged = $2
       FROM (SELECT id, credits_reserved FROM jobs WHERE id = $1 FOR UPDATE) old
      WHERE j.id = old.id
      RETURNING old.credits_reserved AS was`,
    [jobId, keep],
  ).catch((e) => { log.error('jobs.settle_failed', { job: jobId, err: e }); return { rows: [] }; });
  const was = rows.length ? Number(rows[0].was) : 0;
  const refund = was - keep;
  if (refund > 0) {
    await query(`UPDATE accounts SET credits_used = GREATEST(0, credits_used - $2) WHERE id = $1`, [accountId, refund])
      .catch((e) => log.error('jobs.refund_failed', { job: jobId, err: e }));
  }
  return { charged: Math.min(keep, was), refunded: Math.max(0, refund) };
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
async function deliver(job, payload, l = log) {
  if (!job.webhook_url) return;
  const body = JSON.stringify(payload);
  const { rows } = await query(`SELECT webhook_secret FROM accounts WHERE id = $1`, [job.account_id]).catch(() => ({ rows: [] }));
  const secret = rows[0] && rows[0].webhook_secret;
  const timestamp = Math.floor(Date.now() / 1000);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'DocMint-Webhook/1',
    'X-DocMint-Timestamp': String(timestamp),
    'X-DocMint-Job-Id': job.id,
    'X-DocMint-Event': `job.${payload.status}`,
  };
  if (secret) {
    headers['X-DocMint-Signature'] = `sha256=${crypto.createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
  }

  const attempts = [];
  for (let attempt = 1; attempt <= config.jobWebhookAttempts; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const out = await postJson(job.webhook_url, { body, headers, timeoutMs: config.jobWebhookTimeoutMs });
    attempts.push({ attempt, at: new Date().toISOString(), status: out.status, ok: out.ok, error: out.error });
    // eslint-disable-next-line no-await-in-loop
    await recordAttempts(job.id, attempts, out.ok ? 'delivered' : 'failed');
    if (out.ok) {
      l.info('job.webhook_delivered', { job: job.id, attempt, status: out.status });
      return;
    }
    l.warn('job.webhook_failed', { job: job.id, attempt, status: out.status, error: out.error });
    // 4 s then 8 s. Long enough for a receiver that is restarting, short enough
    // that the worker is not held off other jobs for a minute per dead endpoint.
    if (attempt < config.jobWebhookAttempts) {
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => { setTimeout(r, attempt * 4000).unref(); });
    }
  }
}

const recordAttempts = (id, attempts, status) => query(
  `UPDATE jobs SET webhook_attempts = $2::jsonb, webhook_status = $3 WHERE id = $1`,
  [id, JSON.stringify(attempts), status],
).catch(() => {});

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

  const perItem = creditsPerItem(spec.output);
  const settled = await settleCredits(job.id, account.id, perItem * run.ok);

  const files = batch.filesOf(run.records, spec.output);
  const stored = [];
  if (files.length === 1 && spec.response !== 'zip') {
    stored.push(await storeFile(account.id, files[0].buffer, files[0].filename, files[0].content_type));
  } else if (files.length) {
    const { buffer, names } = batch.buildZip(files, { errors: batch.failedItems(run.records) });
    stored.push({ ...await storeFile(account.id, buffer, zipName(job.id), 'application/zip'), entries: names.length });
  }
  t.mark('store');

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
        const { rowCount } = await query(
          `UPDATE jobs SET status = 'succeeded', result = $2, finished_at = now()
            WHERE id = $1 AND status = 'running'`,
          [job.id, JSON.stringify(result)],
        );
        if (rowCount) await deliver(job, webhookPayload(job, 'succeeded', { result: absolutise(result) }));
      }
    } catch (e) {
      if (job) {
        const error = batch.errorObject(e);
        // Nothing was delivered, so nothing is charged. This is also the path a
        // crash inside a single item takes, which is why the release is here and
        // not only on the success side.
        await settleCredits(job.id, job.account_id, 0);
        const { rowCount } = await query(
          `UPDATE jobs SET status = 'failed', error = $2, finished_at = now()
            WHERE id = $1 AND status = 'running'`,
          [job.id, JSON.stringify(error)],
        ).catch(() => ({ rowCount: 0 }));
        log.warn('job.failed', { job: job.id, code: error.code, message: error.message });
        if (rowCount) await deliver(job, webhookPayload(job, 'failed', { error }));
        else await deliver(job, webhookPayload(job, 'cancelled', { error }));
      } else {
        log.warn('job.tick_failed', { err: e });
      }
    } finally {
      setTimeout(tick, job ? 50 : config.jobPollMs).unref();
    }
  };
  setTimeout(tick, 3000).unref();
  recoverStalled();
  return () => { stopped = true; };
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
      for (const j of dead) await settleCredits(j.id, j.account_id, 0);
      log.info('jobs.recovered', { total: r.rowCount, requeued: r.rowCount - dead.length, failed: dead.length });
    })
    .catch((e) => log.warn('jobs.recover_failed', { err: e }));
}

/** Finished jobs and expired files are deleted in-process; neither needs a cron. */
function startReapers() {
  const tick = () => {
    query(`DELETE FROM jobs WHERE finished_at < now() - ($1 || ' days')::interval`, [String(config.jobRetentionDays)])
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
