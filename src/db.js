'use strict';

const { Pool } = require('pg');
const { config } = require('./config');

if (!config.databaseUrl) {
  console.warn('[db] DATABASE_URL is not set — the API will fail on every authenticated request.');
}

const pool = new Pool({
  connectionString: config.databaseUrl,
  ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl) ? false : { rejectUnauthorized: false },
  max: Number(process.env.PG_POOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

const query = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  // A checked-out client has no listener of the pool's, so a connection that
  // drops mid-transaction (pgbouncer/Postgres restart) would emit an unhandled
  // 'error' and crash the process. Seen on Render 14 Nov 2026 04:32Z. Swallow
  // and log here; the pending query rejects and the catch below rolls back.
  let broken = null;
  const onError = (err) => { broken = err; console.error('[db] checked-out client error', err.message); };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally {
    client.removeListener('error', onError);
    // Passing the error destroys the dead connection instead of returning it to the pool.
    client.release(broken || undefined);
  }
}

module.exports = { pool, query, tx };
