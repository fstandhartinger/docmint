'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { req, b64, serverUp, BASE } = require('./helpers');

/**
 * The browser dashboard: the session bridge at /dashboard/api/v1, the page it
 * serves, and the accounting behind the test render. Needs a running server;
 * skips rather than fails without one, like the rest of the suite.
 */
let up = null;

/* See api.test.js for why the server check happens inside the test. */
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

/**
 * An account made through the browser form, with its session cookie, the CSRF
 * token out of the dashboard HTML, and — from that first welcome hit, the only
 * time it is ever shown — the account's API key.
 *
 * The form is deliberately not rate-limited the way POST /v1/signup is, so a
 * test can make several isolated accounts back to back.
 */
async function webAccount() {
  const email = `dash-${crypto.randomBytes(6).toString('hex')}@docmint.test`;
  const res = await fetch(`${BASE}/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email, password: 'testpassword-long-enough' }).toString(),
    redirect: 'manual',
  });
  assert.equal(res.status, 302, `web signup should redirect, got ${res.status}`);

  const setCookies = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  const cookiePair = setCookies.map((s) => s.split(';')[0]).find((s) => s.startsWith('docmint_session='));
  assert.ok(cookiePair, 'web signup should set the session cookie');
  const session = cookiePair.slice('docmint_session='.length);
  const cookie = `docmint_session=${session}`;

  const dash = await fetch(`${BASE}/dashboard?welcome=1`, { headers: { cookie } });
  assert.equal(dash.status, 200);
  const html = await dash.text();
  const csrf = /<meta name="docmint-csrf" content="([0-9a-f]{64})">/.exec(html)?.[1];
  assert.ok(csrf, 'the dashboard page should embed the CSRF token');
  const key = /<code id="api-key">([^<]+)<\/code>/.exec(html)?.[1] || null;
  return { email, cookie, session, csrf, key, html };
}

/** One call against the dashboard bridge, cookie plus CSRF token, as the page does it. */
function bridge(account, path, { method = 'GET', body } = {}) {
  const headers = { cookie: account.cookie, 'X-DocMint-CSRF': account.csrf };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return fetch(`${BASE}/dashboard/api/v1${path}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual',
  });
}

async function bridgeJson(account, path, options) {
  const res = await bridge(account, path, options);
  return { res, json: await res.json().catch(() => null) };
}

/* ------------------------------------------------------------------- page */

when('the dashboard page serves the templates section and a CSRF meta tag', async () => {
  const acc = await webAccount();
  const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: acc.cookie } });
  assert.equal(dash.status, 200);
  const html = await dash.text();
  assert.ok(html.includes('Templates'), 'the page lists the templates section');
  assert.match(html, /<meta name="docmint-csrf" content="[0-9a-f]{64}">/);
  assert.ok(html.includes('Test a render'), 'the page has the test-render section');
  assert.ok(html.includes('API keys'), 'the page has the keys section');
});

/* ----------------------------------------------------------------- bridge */

when('the bridge demands a session cookie and a CSRF token on every request', async () => {
  const acc = await webAccount();

  const noCookie = await fetch(`${BASE}/dashboard/api/v1/templates`);
  assert.equal(noCookie.status, 401);
  assert.equal((await noCookie.json()).error.code, 'missing_session');

  const noCsrf = await fetch(`${BASE}/dashboard/api/v1/templates`, { headers: { cookie: acc.cookie } });
  assert.equal(noCsrf.status, 403);
  assert.equal((await noCsrf.json()).error.code, 'invalid_csrf');

  const wrongCsrf = await fetch(`${BASE}/dashboard/api/v1/templates`, {
    headers: { cookie: acc.cookie, 'X-DocMint-CSRF': 'not-the-token' },
  });
  assert.equal(wrongCsrf.status, 403);

  // A token for a DIFFERENT session is a wrong token here, too.
  const other = await webAccount();
  const foreignCsrf = await fetch(`${BASE}/dashboard/api/v1/templates`, {
    headers: { cookie: acc.cookie, 'X-DocMint-CSRF': other.csrf },
  });
  assert.equal(foreignCsrf.status, 403);

  const { res, json } = await bridgeJson(acc, '/templates');
  assert.equal(res.status, 200);
  assert.deepEqual(json, { templates: [] });
});

when('a template uploaded over the bridge is listed, and invisible to other accounts', async () => {
  const acc = await webAccount();
  const name = `dash-${Date.now().toString(36)}`;

  // NAME_RE refuses markup for a name, and the validator's message echoes the
  // raw input; the page renders that message with textContent (checked below).
  const bad = await bridgeJson(acc, '/templates', {
    method: 'POST', body: { name: '<script>x</script>', file_base64: b64('invoice.docx') },
  });
  assert.equal(bad.res.status, 400);
  assert.equal(bad.json.error.code, 'bad_template_name');
  assert.ok(bad.json.error.message.includes('<script>x</script>'), 'the message echoes the raw input');

  const created = await bridgeJson(acc, '/templates', {
    method: 'POST', body: { name, file_base64: b64('invoice.docx') },
  });
  assert.equal(created.res.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.format, 'docx');

  const list = await bridgeJson(acc, '/templates');
  assert.ok(list.json.templates.some((t) => t.name === name && t.format === 'docx' && t.version === 1));

  const other = await webAccount();
  const otherList = await bridgeJson(other, '/templates');
  assert.ok(!otherList.json.templates.some((t) => t.name === name), 'templates are per-account');
});

/* --------------------------------------------------------------- escaping */

when('a script-bearing key label is stored but never reaches server-rendered HTML raw', async () => {
  const acc = await webAccount();
  assert.ok(acc.key, 'the welcome page shows the first key once, for the bearer checks');
  const xss = '<img src=x onerror=alert(1)>';

  const created = await bridgeJson(acc, '/keys', { method: 'POST', body: { label: xss } });
  assert.equal(created.res.status, 201);

  const listed = await bridgeJson(acc, '/keys');
  assert.ok(listed.json.keys.some((k) => k.label === xss), 'the label is stored exactly as typed');

  const dash = await fetch(`${BASE}/dashboard`, { headers: { cookie: acc.cookie } });
  const html = await dash.text();
  assert.ok(!html.includes(xss), 'the raw label must never appear in the server-rendered page');
});

test('public/dashboard.js never turns a string into markup', async () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
  for (const token of ['innerHTML', 'outerHTML', 'insertAdjacentHTML']) {
    assert.ok(!source.includes(token), `dashboard.js must not use ${token}`);
  }
});

/* ------------------------------------------------------------------ render */

when('a render over the bridge spends exactly one credit, and a failed one none', async () => {
  const acc = await webAccount();
  assert.ok(acc.key, 'the welcome page shows the first key once, for the usage check');
  const name = `rend-${Date.now().toString(36)}`;

  const created = await bridgeJson(acc, '/templates', {
    method: 'POST', body: { name, file_base64: b64('invoice.docx') },
  });
  assert.equal(created.res.status, 201);

  const fields = await bridgeJson(acc, `/templates/${name}/fields`);
  assert.equal(fields.res.status, 200);
  assert.ok(fields.json.sample_data && typeof fields.json.sample_data === 'object');
  assert.ok(fields.json.fields.length > 0, 'the invoice fixture has fields');

  const before = await req('/v1/usage', { key: acc.key });
  const usedBefore = before.json.credits.used;

  const rendered = await bridge(acc, '/render', {
    method: 'POST', body: { template: name, data: fields.json.sample_data, output: 'document' },
  });
  assert.equal(rendered.status, 200);
  const bytes = Buffer.from(await rendered.arrayBuffer());
  assert.equal(bytes.subarray(0, 2).toString('latin1'), 'PK', 'an Office document is a zip');
  assert.match(rendered.headers.get('content-disposition') || '', /^attachment;\s*filename=/);
  const remainingHeader = rendered.headers.get('x-docmint-credits-remaining');
  assert.ok(remainingHeader !== null, 'the render reports the remaining credits');

  const after = await req('/v1/usage', { key: acc.key });
  assert.equal(after.json.credits.used, usedBefore + 1, 'one document render costs exactly one credit');
  assert.equal(Number(remainingHeader), after.json.credits.limit - after.json.credits.used);

  const failed = await bridgeJson(acc, '/render', {
    method: 'POST', body: { template: name, data: {}, output: 'document' },
  });
  assert.equal(failed.res.status, 422);
  assert.ok(failed.json.error.code, 'the 422 carries a machine code');
  assert.ok(failed.json.error.message, 'the 422 carries a readable message');
  assert.ok(failed.json.error.details?.field, 'the 422 names the missing field');
  assert.ok(failed.json.error.details?.location, 'the 422 names where it is');

  const final = await req('/v1/usage', { key: acc.key });
  assert.equal(final.json.credits.used, usedBefore + 1, 'the failed render was refunded');
});

/* ------------------------------------------------------------------- keys */

when('API keys can be listed, created and revoked over the bridge', async () => {
  const acc = await webAccount();
  assert.ok(acc.key, 'the welcome page shows the first key once, for the bearer check');

  const listed = await bridgeJson(acc, '/keys');
  assert.equal(listed.res.status, 200);
  assert.equal(listed.json.keys.length, 1, 'a fresh account has its default key');
  for (const k of listed.json.keys) {
    assert.ok(k.prefix.startsWith('dm_live_'));
    for (const field of Object.keys(k)) {
      assert.ok(['prefix', 'label', 'created_at', 'last_used_at'].includes(field),
        `GET /keys must not return ${field}`);
    }
  }
  assert.ok(!JSON.stringify(listed.json).includes('key_hash'), 'hashes never leave the server');

  // The same route answers through the bearer API unchanged.
  const viaBearer = await req('/v1/keys', { key: acc.key });
  assert.equal(viaBearer.res.status, 200);
  assert.equal(viaBearer.json.keys.length, 1);

  const created = await bridgeJson(acc, '/keys', { method: 'POST', body: { label: 'dashboard suite' } });
  assert.equal(created.res.status, 201);
  assert.ok(created.json.key.startsWith('dm_live_'), 'the full key is shown this once');

  const second = await bridgeJson(acc, '/keys');
  assert.equal(second.json.keys.length, 2);

  const prefix = created.json.key.slice(0, 16);
  const revoked = await bridgeJson(acc, `/keys/${encodeURIComponent(prefix)}`, { method: 'DELETE' });
  assert.equal(revoked.res.status, 200);

  const third = await bridgeJson(acc, '/keys');
  assert.equal(third.json.keys.length, 1);
});

/* --------------------------------------------------- 404 under the bridge */

when('signup and billing answer 404 under the bridge but stay live under /v1', async () => {
  const acc = await webAccount();
  const assertBlocked = async (path, { method = 'GET', body } = {}) => {
    const result = await bridgeJson(acc, path, { method, body });
    assert.equal(result.res.status, 404);
    assert.equal(result.json.error.code, 'unknown_endpoint');
    assert.equal(
      result.json.error.message,
      `There is no ${method} /dashboard/api/v1${path} endpoint.`,
    );
  };

  await assertBlocked('/signup', {
    method: 'POST', body: { email: 'bridge-blocked@docmint.test', password: 'password-long-enough' },
  });
  await assertBlocked('/Signup', {
    method: 'POST', body: { email: 'bridge-blocked@docmint.test', password: 'password-long-enough' },
  });
  await assertBlocked('/signup/', {
    method: 'POST', body: { email: 'bridge-blocked@docmint.test', password: 'password-long-enough' },
  });

  await assertBlocked('/billing');
  await assertBlocked('/Billing');
  await assertBlocked('/billing/');
  await assertBlocked('/billing/checkout', { method: 'POST', body: {} });
  await assertBlocked('/Billing/checkout', { method: 'POST', body: {} });
  await assertBlocked('/billing/checkout/', { method: 'POST', body: {} });
  await assertBlocked('/billing/plans');
  await assertBlocked('/BILLING/plans');
  await assertBlocked('/billing/plans/');
  await assertBlocked('/billing/portal', { method: 'POST', body: {} });
  await assertBlocked('/Billing/portal', { method: 'POST', body: {} });
  await assertBlocked('/billing/portal/', { method: 'POST', body: {} });

  // The bearer surface itself is untouched.
  assert.equal((await req('/v1/billing/plans')).res.status, 200);
  assert.equal((await req('/v1/Billing/plans')).res.status, 200);
  assert.equal((await req('/v1/billing/plans/')).res.status, 200);
});
