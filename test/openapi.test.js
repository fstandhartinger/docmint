'use strict';

/**
 * Parity test for /openapi.json. The spec is served at the site root (not
 * behind /v1), and every path/method it lists must exist in the /v1 router
 * and vice versa, so the machine contract and the router cannot drift.
 */

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');

function listen(app) {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function specEntries(spec) {
  const out = new Set();
  for (const [path, methods] of Object.entries(spec.paths || {})) {
    for (const method of Object.keys(methods)) {
      if (!['get', 'put', 'post', 'delete', 'patch', 'head', 'options'].includes(method)) continue;
      out.add(method.toUpperCase() + ' ' + path);
    }
  }
  return out;
}

function routerEntries(router) {
  const out = new Set();
  if (!router || !Array.isArray(router.stack)) return out;
  for (const layer of router.stack) {
    if (!layer.route) continue;
    let path = typeof layer.route.path === 'string' ? layer.route.path : '';
    path = path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
    for (const [m, on] of Object.entries(layer.route.methods || {})) {
      if (!on) continue;
      const M = m.toUpperCase();
      if (M === 'HEAD' || M === 'OPTIONS') continue;
      out.add(M + ' ' + path);
    }
  }
  return out;
}

test('openapi spec is served on /openapi.json', async () => {
  const { app } = require('../src/server');
  const { server, port } = await listen(app);
  try {
    const res = await fetch('http://127.0.0.1:' + port + '/openapi.json', { signal: AbortSignal.timeout(5000) });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.strictEqual(body.openapi, '3.1.0');
    assert.ok(body.info && body.info.title);
    assert.ok(Object.keys(body.paths || {}).length >= 5);
  } finally {
    server.close();
  }
});

test('spec and router list the same /v1 endpoints', () => {
  const specSet = specEntries(require('../src/openapi'));
  const routerSet = routerEntries(require('../src/api').router);
  const specOnly = [...specSet].filter((e) => !routerSet.has(e));
  const routerOnly = [...routerSet].filter((e) => !specSet.has(e));
  assert.deepStrictEqual(specOnly, [], 'spec lists routes the router lacks: ' + specOnly.join(', '));
  assert.deepStrictEqual(routerOnly, [], 'router routes missing from the spec: ' + routerOnly.join(', '));
});
