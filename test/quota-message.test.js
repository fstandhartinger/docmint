'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

// Only the atomic reservation/denial is mocked; execute the actual auth module.
function authFor(current) {
  const calls = [];
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../src/auth.js'), 'utf8'), {
    module, exports: module.exports,
    require(name) {
      if (name === 'node:crypto') return require(name);
      if (name === 'bcryptjs') return {};
      if (name === './config') return { PLANS: {} };
      if (name === './errors') return require('../src/errors');
      if (name === './db') return { query: async (sql, args) => {
        calls.push({ sql, args });
        return { rows: sql.startsWith('UPDATE') ? [] : [current] };
      } };
      throw Error(`Unexpected dependency ${name}`);
    },
  });
  return { auth: module.exports, calls };
}

test('batch denial with credits remaining does not claim every credit was consumed', async () => {
  const { auth, calls } = authFor({ credits_used: 20, credits_limit: 30, plan: 'free' });
  await assert.rejects(auth.consumeCredits(1, 12), e => {
    assert.equal(e.status, 402);
    assert.equal(e.code, 'quota_exceeded');
    assert.match(e.message, /request exceeds.*remaining monthly quota/i);
    assert.doesNotMatch(e.message, /used all/i);
    assert.equal(e.details.credits_used, 20);
    assert.equal(e.details.credits_limit, 30);
    return true;
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args[1], 12);
});

test('exhausted quota retains 402 quota_exceeded', async () => {
  const { auth } = authFor({ credits_used: 30, credits_limit: 30, plan: 'free' });
  await assert.rejects(auth.consumeCredits(1), e => e.status === 402 && e.code === 'quota_exceeded');
});

test('zero allowance remains plan_required', async () => {
  const { auth } = authFor({ credits_used: 0, credits_limit: 0, plan: 'free' });
  await assert.rejects(auth.consumeCredits(1), e => e.status === 402 && e.code === 'plan_required');
});
