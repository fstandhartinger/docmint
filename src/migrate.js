'use strict';

const { query } = require('./db');
const log = require('./log');

const STATEMENTS = [
  `CREATE EXTENSION IF NOT EXISTS pgcrypto`,

  `CREATE TABLE IF NOT EXISTS accounts (
     id             BIGSERIAL PRIMARY KEY,
     email          TEXT UNIQUE NOT NULL,
     password_hash  TEXT NOT NULL,
     plan           TEXT NOT NULL DEFAULT 'free',
     credits_limit  INTEGER NOT NULL DEFAULT 30,
     credits_used   INTEGER NOT NULL DEFAULT 0,
     period_start   TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', now()),
     stripe_customer_id     TEXT,
     stripe_subscription_id TEXT,
     created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS api_keys (
     id          BIGSERIAL PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     key_hash    TEXT UNIQUE NOT NULL,
     key_prefix  TEXT NOT NULL,
     label       TEXT NOT NULL DEFAULT 'default',
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     last_used_at TIMESTAMPTZ,
     revoked_at  TIMESTAMPTZ
   )`,
  `CREATE INDEX IF NOT EXISTS api_keys_account_idx ON api_keys(account_id)`,

  /* Templates are named by the caller, not by an opaque id, so a workflow can
     reference "invoice" and keep working after the template is replaced. The
     id is still exposed for anyone who prefers it. */
  `CREATE TABLE IF NOT EXISTS templates (
     id          TEXT PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     name        TEXT NOT NULL,
     format      TEXT NOT NULL,
     version     INTEGER NOT NULL DEFAULT 1,
     description TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (account_id, name)
   )`,
  `CREATE INDEX IF NOT EXISTS templates_account_idx ON templates(account_id, name)`,

  /* Every upload is kept as a version rather than overwriting. A template is the
     thing a business depends on; replacing one and discovering an hour later that
     the old one was better must not be an unrecoverable mistake. Old versions are
     pruned to config.maxVersionsKept, oldest first, never below one. */
  `CREATE TABLE IF NOT EXISTS template_versions (
     id          BIGSERIAL PRIMARY KEY,
     template_id TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
     version     INTEGER NOT NULL,
     bytes       BYTEA NOT NULL,
     size        INTEGER NOT NULL,
     sha256      TEXT NOT NULL,
     fields      JSONB NOT NULL DEFAULT '[]'::jsonb,
     tags        JSONB NOT NULL DEFAULT '[]'::jsonb,
     note        TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     UNIQUE (template_id, version)
   )`,
  `CREATE INDEX IF NOT EXISTS template_versions_tpl_idx ON template_versions(template_id, version DESC)`,

  `CREATE TABLE IF NOT EXISTS files (
     token       TEXT PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     filename    TEXT NOT NULL,
     content_type TEXT NOT NULL,
     bytes       BYTEA NOT NULL,
     size        INTEGER NOT NULL,
     expires_at  TIMESTAMPTZ NOT NULL,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS files_expires_idx ON files(expires_at)`,

  /* One row per billable render. `stages` holds the per-stage timings so the
     question "is the PDF path getting slower?" can be answered from data rather
     than from memory. */
  `CREATE TABLE IF NOT EXISTS usage_events (
     id          BIGSERIAL PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     kind        TEXT NOT NULL,
     format      TEXT,
     template_id TEXT,
     output      TEXT,
     credits     INTEGER NOT NULL DEFAULT 1,
     duration_ms INTEGER,
     stages      JSONB,
     ok          BOOLEAN NOT NULL,
     error_code  TEXT,
     origin      TEXT,
     request_id  TEXT,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
  `CREATE INDEX IF NOT EXISTS usage_events_account_time_idx ON usage_events(account_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS usage_events_origin_time_idx ON usage_events(origin, created_at DESC)`,

  `CREATE TABLE IF NOT EXISTS sessions (
     id          TEXT PRIMARY KEY,
     account_id  BIGINT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
     expires_at  TIMESTAMPTZ NOT NULL
   )`,

  `CREATE TABLE IF NOT EXISTS stripe_events (
     id          TEXT PRIMARY KEY,
     created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
   )`,
];

async function migrate() {
  for (const sql of STATEMENTS) await query(sql);
  log.info('migrate.done', { statements: STATEMENTS.length });
}

module.exports = { migrate };

if (require.main === module) {
  migrate().then(() => process.exit(0)).catch((e) => { log.error('migrate.fail', { err: e }); process.exit(1); });
}
