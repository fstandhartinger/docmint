'use strict';

// Regression: a connection that drops while a transaction holds it emitted an
// unhandled 'error' on the pg Client and crashed the process (Render, 14 Nov 2026).
const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');
const pg = require('pg');

test('tx() survives a client error event mid-transaction and destroys the client', async () => {
  const released = [];
  class FakeClient extends EventEmitter {
    async query(sql) {
      if (sql === 'SELECT boom') {
        // pg emits 'error' on the client and rejects the pending query.
        this.emit('error', new Error('Connection terminated unexpectedly'));
        throw new Error('Connection terminated unexpectedly');
      }
      return { rows: [] };
    }
    release(err) { released.push(err); }
  }
  class FakePool extends EventEmitter {
    async connect() { return new FakeClient(); }
    query() { return Promise.resolve({ rows: [] }); }
  }
  const RealPool = pg.Pool;
  pg.Pool = FakePool;
  delete require.cache[require.resolve('../src/db')];
  try {
    const { tx } = require('../src/db');
    await assert.rejects(tx((c) => c.query('SELECT boom')), /terminated unexpectedly/);
    assert.equal(released.length, 1);
    assert.ok(released[0] instanceof Error, 'broken client is released with its error');

    await tx((c) => c.query('SELECT 1'));
    assert.equal(released[1], undefined, 'healthy client goes back to the pool');
  } finally {
    pg.Pool = RealPool;
    delete require.cache[require.resolve('../src/db')];
  }
});
