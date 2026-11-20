'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const recovery = require('../src/recovery');
const auth = require('../src/auth');
const db = require('../src/db');

test('recovery: expiry, one use, races, unknown email, session invalidation, branded sender, delivery rollback and limits', { skip: !process.env.RECOVERY_TEST_DB }, async () => {
  for (const sql of recovery.migration) await db.query(sql);
  const email = `qa-recovery-${crypto.randomBytes(6).toString('hex')}@smooth-operator.online`;
  const { account } = await auth.createAccount(email, 'original-password-123');
  let mail;
  const sendMail = async m => { mail = m; };
  const request = () => recovery.forgot(email, { product: 'Mint QA', sendMail });
  const token = () => /#token=([\w-]+)/.exec(mail.text)[1];
  const bucket = recovery.digest(`email:${email}`);
  const unlock = async () => {
    await db.query('DELETE FROM password_reset_limits WHERE key = $1', [bucket]);
    await db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [account.id]);
  };
  try {
    const fresh = await request();
    assert.equal(mail, undefined, 'unused new accounts cannot trigger email');
    await db.query("UPDATE accounts SET created_at = now() - interval '25 hours' WHERE id = $1", [account.id]);
    const oldSession = await auth.createSession(account.id);
    const configuredKey = process.env.MINT_RECOVERY_RESEND_API_KEY;
    const realFetch = global.fetch;
    let known;
    try {
      delete process.env.MINT_RECOVERY_RESEND_API_KEY;
      global.fetch = () => assert.fail('a missing key must stop delivery');
      await assert.rejects(recovery.forgot(email, { product: 'Mint QA' }), { code: 'recovery_unavailable' });

      process.env.MINT_RECOVERY_RESEND_API_KEY = 'local-test-key';
      global.fetch = async (url, options) => {
        assert.equal(url, 'https://api.resend.com/emails');
        assert.equal(options.headers.authorization, 'Bearer local-test-key');
        mail = JSON.parse(options.body);
        return { ok: true };
      };
      known = await recovery.forgot(email, { product: 'Mint QA' });
    } finally {
      global.fetch = realFetch;
      if (configuredKey === undefined) delete process.env.MINT_RECOVERY_RESEND_API_KEY;
      else process.env.MINT_RECOVERY_RESEND_API_KEY = configuredKey;
    }
    assert.deepEqual(known, fresh);
    assert.equal(mail.from, 'Mint QA <noreply@mail.mintapis.com>');
    assert.equal(mail.to, email);
    const secret = token();
    const { rows } = await db.query('SELECT reset_token_hash, reset_expires_at FROM accounts WHERE id=$1', [account.id]);
    assert.notEqual(rows[0].reset_token_hash, secret);
    assert.equal(rows[0].reset_token_hash, recovery.digest(secret));
    assert.ok(new Date(rows[0].reset_expires_at) > new Date());
    assert.deepEqual(await recovery.forgot('missing-'+email, { product: 'Mint QA', sendMail: () => assert.fail('unknown address must not receive email') }), known);
    await assert.rejects(recovery.reset(secret, 'short'), { code: 'invalid_password' });
    await recovery.reset(secret, 'replacement-password-456');
    assert.equal(await auth.verifyLogin(email, 'original-password-123'), null);
    assert.ok(await auth.verifyLogin(email, 'replacement-password-456'));
    assert.equal(await auth.accountForSession(oldSession), null);
    await assert.rejects(recovery.reset(secret, 'replay-password-456'), { code: 'invalid_reset_token' });
    await unlock(); await request();
    await db.query("UPDATE accounts SET reset_expires_at = now() - interval '1 second' WHERE id=$1", [account.id]);
    await assert.rejects(recovery.reset(token(), 'expired-password-456'), { code: 'invalid_reset_token' });
    await unlock(); await request();
    const oldToken = token();
    await unlock();
    assert.deepEqual(await recovery.forgot(email, {
      product: 'Mint QA',
      sendMail: async () => { throw Error('delivery failed'); },
    }), known);
    await recovery.reset(oldToken, 'rollback-password-789');
    await unlock(); await request();
    const once = token();
    await db.query('UPDATE password_reset_limits SET used = 3 WHERE key = $1', [bucket]);
    await db.query('UPDATE accounts SET reset_requested_at = NULL WHERE id = $1', [account.id]);
    assert.deepEqual(await recovery.forgot(email, {
      product: 'Mint QA',
      sendMail: () => assert.fail('recipient cap must stop delivery'),
    }), known);
    const raced = await Promise.allSettled([recovery.reset(once, 'winner-password-111'), recovery.reset(once, 'winner-password-222')]);
    assert.equal(raced.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal(raced.filter(r => r.status === 'rejected').length, 1);
  } finally {
    await db.query('DELETE FROM accounts WHERE id=$1', [account.id]);
    await db.pool.end();
  }
});
