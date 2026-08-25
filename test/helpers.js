'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * These tests exercise real behaviour against a real server, a real database and
 * real Office bytes. Nothing about the shape of the code is asserted anywhere —
 * only what the service actually does when you call it.
 *
 * Point them at production with TEST_BASE_URL if you want to check a deploy; by
 * default they expect a local server. They create real accounts, so run them
 * against production sparingly.
 */
const BASE = (process.env.TEST_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');

async function req(pathname, { method = 'GET', key, body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  if (key) h.Authorization = `Bearer ${key}`;
  if (body !== undefined && !h['Content-Type']) h['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${pathname}`, {
    method,
    headers: h,
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  if (raw) return { res, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { res, text, json };
}

/**
 * A throwaway account. Signup is rate-limited to one per minute per address to
 * stop a runaway workflow filling the accounts table, so the tests share one
 * account rather than creating one each — which also matches how the thing is
 * actually used.
 */
let shared = null;
async function account() {
  if (shared) return shared;
  const email = `test-${crypto.randomBytes(6).toString('hex')}@docmint.test`;
  const { res, json } = await req('/v1/signup', {
    method: 'POST',
    body: { email, password: 'testpassword-long-enough' },
  });
  if (res.status !== 201 || !json?.api_key) {
    throw new Error(`signup failed: ${res.status} ${JSON.stringify(json)}`);
  }
  shared = { email, key: json.api_key, plan: json.plan };
  return shared;
}

const fixture = (name) => fs.readFileSync(path.join(__dirname, '..', 'fixtures', name));
const b64 = (name) => fixture(name).toString('base64');

/**
 * Is DOCMINT actually up at BASE?
 *
 * Checking only that /healthz answers 200 is not enough, and that is not a
 * hypothetical: another project on this machine serves /healthz on port 3000, so
 * the suite happily pointed itself at a completely different service and reported
 * fourteen failures that had nothing to do with this code. Ask a question only
 * DocMint can answer.
 */
async function serverUp() {
  try {
    const res = await fetch(`${BASE}/v1/capabilities`, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return false;
    const body = await res.json();
    const formats = (body.formats || []).map((f) => f.id).sort().join(',');
    if (formats !== 'docx,pptx,xlsx') {
      process.stderr.write(`\n[helpers] something is listening at ${BASE} but it is not DocMint; skipping\n`);
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

module.exports = { BASE, req, account, fixture, b64, serverUp };
