'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const delay = ms => new Promise(r => setTimeout(r, ms));
function transport(dns) {
  const module = { exports: {} }, base = path.join(__dirname, '../src');
  vm.runInNewContext(fs.readFileSync(path.join(base, 'net.js'), 'utf8'), {
    module, exports: module.exports,
    require: n => n === './config' ? { config: { allowPrivateNetwork: !dns } }
      : n === 'node:dns' && dns ? { promises: dns }
      : require(n.startsWith('./') ? path.join(base, n) : n),
    URL, AbortSignal, AbortController, fetch, setTimeout, clearTimeout, Date, Promise,
  });
  return module.exports;
}
test('actual HTTP redirects share one total attempt deadline, not one per hop', async () => {
  let hits = 0;
  const server = http.createServer(async (req, res) => {
    for await (const c of req) {} hits++; await delay(450);
    const hop = Number(req.url.slice(1));
    res.writeHead(hop < 3 ? 307 : 204, hop < 3 ? { location: '/' + (hop + 1) } : {}); res.end();
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  try {
    const start = Date.now();
    const result = await transport().postJson(`http://127.0.0.1:${server.address().port}/0`, { body: '{}', timeoutMs: 500 });
    assert.equal(result.ok, false, '450ms redirect chain must exceed the single 500ms attempt deadline');
    assert(Date.now() - start < 1000); assert(hits <= 2);
  } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('validation DNS wait is included in deadline and cannot send later', async () => {
  const net = transport({ lookup: () => new Promise(() => {}) });
  const start = Date.now();
  const result = await Promise.race([
    net.postJson('http://fixture.example.invalid/hook', { body: '{}', timeoutMs: 100 }),
    delay(700).then(() => ({ timedOut: true })),
  ]);
  assert.equal(result.timedOut, undefined, 'unresolved DNS must not outlive delivery lease');
  assert.equal(result.ok, false); assert(Date.now() - start < 500);
});
