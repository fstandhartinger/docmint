'use strict';

// Additive only: old binaries ignore these columns. Keep on rollback so a later
// roll-forward retains IDs, attempt budgets and in-flight recovery deadlines.
module.exports = [
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS webhook_delivery_id TEXT`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS webhook_body TEXT`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS webhook_next_at TIMESTAMPTZ`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS webhook_lease_until TIMESTAMPTZ`,
  `ALTER TABLE jobs ADD COLUMN IF NOT EXISTS webhook_lease_token TEXT`,
  `CREATE INDEX IF NOT EXISTS jobs_webhook_due_idx ON jobs(webhook_next_at)
     WHERE webhook_url IS NOT NULL AND (webhook_status IS NULL OR webhook_status IN ('pending','delivering')
       OR (webhook_status = 'failed' AND webhook_delivery_id IS NULL))`,
  // Old binaries still run their broad reaper after rollback. Preserve pending
  // delivery/refund claims there too; account deletion cascades remain intentional.
  `CREATE OR REPLACE FUNCTION retain_job_delivery() RETURNS trigger LANGUAGE plpgsql AS $$
     BEGIN
       IF pg_trigger_depth() = 1 AND (OLD.credits_reserved > 0 OR
         (OLD.webhook_url IS NOT NULL AND (OLD.webhook_status IS NULL OR OLD.webhook_status IN ('pending','delivering'))))
       THEN RETURN NULL; END IF;
       RETURN OLD;
     END $$`,
  `DROP TRIGGER IF EXISTS jobs_retain_delivery ON jobs`,
  `CREATE TRIGGER jobs_retain_delivery BEFORE DELETE ON jobs
     FOR EACH ROW EXECUTE FUNCTION retain_job_delivery()`,
];
