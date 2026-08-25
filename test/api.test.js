'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { req, account, b64, fixture, serverUp, BASE } = require('./helpers');

/**
 * The HTTP surface, exercised end to end. These need a running server; they skip
 * rather than fail when there is not one, because a red suite that only means
 * "you did not start the server" trains people to ignore red suites.
 */
let up = null;

/**
 * node:test's `skip` option takes a value, not a predicate — passing a function
 * makes every test skip unconditionally, which is exactly what happened the first
 * time this file ran and is a very easy way to ship a suite that proves nothing.
 * So the check happens inside the test, where it can be dynamic.
 */
const when = (name, fn) => test(name, async (t) => {
  if (up === null) up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  await fn(t);
});

/** The three-line-item invoice used throughout, with the arithmetic done here. */
function invoiceData() {
  const items = [
    { description: 'Discovery workshop', qty: 2, unit_price: 850 },
    { description: 'Integration build', qty: 14, unit_price: 145.5 },
    { description: 'Out-of-hours cover', qty: 3, unit_price: 99.99 },
  ];
  for (const i of items) i.line_total = Math.round(i.qty * i.unit_price * 100) / 100;
  return {
    data: {
      company: 'Northwind Consulting Ltd',
      invoice_no: 'INV-TEST-1',
      issued: '2026-08-25',
      customer: { name: 'Acme GmbH', address: 'Industriestrasse 4' },
      items,
      paid: false,
      terms_days: 30,
      notes: ['Thank you.'],
      logo: null,
    },
    total: items.reduce((s, i) => s + i.line_total, 0),
  };
}

when('healthz says whether PDF conversion is actually available', async () => {
  const { res, json } = await req('/healthz');
  assert.equal(res.status, 200);
  assert.equal(json.ok, true);
  assert.equal(typeof json.pdf.available, 'boolean');
});

when('capabilities is generated from the code, not from a list someone typed', async () => {
  const { json } = await req('/v1/capabilities');
  const names = json.formatters.map((f) => f.name);
  // These exist in src/template/formatters.js; if one is removed this fails,
  // which is the point - the published capability list cannot drift.
  for (const n of ['currency', 'sumProduct', 'groupBy', 'date', 'default']) {
    assert.ok(names.includes(n), `capabilities should list ${n}`);
  }
  assert.deepEqual(json.formats.map((f) => f.id).sort(), ['docx', 'pptx', 'xlsx']);
  assert.deepEqual(json.credits, { document: 1, pdf: 2, both: 2 });
});

when('a template can be uploaded, listed, versioned and deleted', async () => {
  const { key } = await account();
  const name = `t${Date.now().toString(36)}`;

  const up1 = await req('/v1/templates', { method: 'POST', key, body: { name, file_base64: b64('invoice.docx') } });
  assert.equal(up1.res.status, 201);
  assert.equal(up1.json.format, 'docx');
  assert.equal(up1.json.version, 1);

  // Re-uploading identical bytes must not burn a version: a workflow that syncs
  // its template on every run would otherwise fill the history with copies.
  const up2 = await req('/v1/templates', { method: 'POST', key, body: { name, file_base64: b64('invoice.docx') } });
  assert.equal(up2.json.unchanged, true);
  assert.equal(up2.json.version, 1);

  const up3 = await req(`/v1/templates/${name}`, { method: 'PUT', key, body: { file_base64: b64('letterhead.docx') } });
  assert.equal(up3.json.version, 2, 'different bytes are a new version');

  const versions = await req(`/v1/templates/${name}/versions`, { key });
  assert.equal(versions.json.current, 2);
  assert.equal(versions.json.versions.length, 2);

  const back = await req(`/v1/templates/${name}/rollback`, { method: 'POST', key, body: { version: 1 } });
  assert.equal(back.json.version, 3);
  assert.equal(back.json.restored_from, 1);

  const file = await req(`/v1/templates/${name}/file`, { key, raw: true });
  assert.equal(file.buffer.subarray(0, 2).toString(), 'PK');

  const del = await req(`/v1/templates/${name}`, { method: 'DELETE', key });
  assert.equal(del.json.deleted, true);
});

when('a template of a different format cannot silently replace one', async () => {
  const { key } = await account();
  const name = `f${Date.now().toString(36)}`;
  await req('/v1/templates', { method: 'POST', key, body: { name, file_base64: b64('invoice.docx') } });
  const { res, json } = await req(`/v1/templates/${name}`, { method: 'PUT', key, body: { file_base64: b64('invoice.xlsx') } });
  assert.equal(res.status, 409);
  assert.equal(json.error.code, 'template_format_changed');
  await req(`/v1/templates/${name}`, { method: 'DELETE', key });
});

when('the fields endpoint returns a sample that actually renders', async () => {
  const { key } = await account();
  const insp = await req('/v1/inspect', { method: 'POST', key, body: { template_base64: b64('invoice.docx') } });
  assert.equal(insp.res.status, 200);
  assert.ok(insp.json.fields.length > 0);
  assert.ok(insp.json.sample_data);

  // The claim the product is sold on: the sample we hand you works.
  const { res } = await req('/v1/render', {
    method: 'POST', key, raw: true,
    body: { template_base64: b64('invoice.docx'), data: insp.json.sample_data },
  });
  assert.equal(res.status, 200, 'sample_data from inspect must render');
});

when('a rendered invoice contains a total computed from the data', async () => {
  const { key } = await account();
  const { data, total } = invoiceData();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: { template_base64: b64('invoice.docx'), data, currency: 'EUR', locale: 'en-GB' },
  });
  assert.equal(res.status, 200);
  const buffer = Buffer.from(json.document.base64, 'base64');
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');

  const { readZip, readText } = require('../src/ooxml/zip');
  const text = readText(readZip(buffer).byName.get('word/document.xml')).replace(/<[^>]*>/g, ' ');
  const expected = total.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  assert.ok(text.includes(expected), `the document should contain the computed total ${expected}`);
  assert.ok(!text.includes('undefined'), 'no document may ever contain the word undefined');
});

when('a missing field is refused, by name, with where it is', async () => {
  const { key } = await account();
  const { data } = invoiceData();
  delete data.invoice_no;
  const { res, json } = await req('/v1/render', {
    method: 'POST', key, body: { template_base64: b64('invoice.docx'), data },
  });
  assert.equal(res.status, 422);
  assert.equal(json.error.code, 'placeholder_unresolved');
  assert.equal(json.error.details.field, 'invoice_no');
  assert.ok(json.error.details.location, 'the error must say where in the document');
  assert.ok(json.error.hint, 'the error must say what to change');
  assert.ok(json.error.request_id);
});

when('a failed render costs nothing', async () => {
  const { key } = await account();
  const before = (await req('/v1/usage', { key })).json.credits.used;
  const { data } = invoiceData();
  delete data.invoice_no;
  await req('/v1/render', { method: 'POST', key, body: { template_base64: b64('invoice.docx'), data } });
  const after = (await req('/v1/usage', { key })).json.credits.used;
  assert.equal(after, before, 'credits taken for a render that failed must be refunded');
});

when('a mistyped field is named, with the field that was meant', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    body: { template_base64: b64('invoice.docx'), data: {}, fileName: 'x.docx' },
  });
  assert.equal(res.status, 400);
  assert.equal(json.error.code, 'unknown_field');
  assert.match(json.error.message, /filename/);
});

when('things that are not Office files are refused by name', async () => {
  const { key } = await account();
  const cases = [
    [Buffer.from('%PDF-1.4 not really'), 'template_is_pdf'],
    [Buffer.from('hello world'), 'template_not_office'],
    [Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]), 'template_is_legacy_office'],
  ];
  for (const [buf, code] of cases) {
    const { json } = await req('/v1/render', {
      method: 'POST', key, body: { template_base64: buf.toString('base64'), data: {} },
    });
    assert.equal(json.error.code, code, `expected ${code}, got ${json.error.code}`);
    assert.ok(json.error.hint, `${code} should say what to do instead`);
  }
});

when('output=both returns the Office file and the PDF in one call', async () => {
  const { key } = await account();
  const { data } = invoiceData();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    body: { template_base64: b64('invoice.docx'), data, output: 'both', filename: 'inv-{invoice_no}', currency: 'EUR' },
  });
  if (res.status === 501) return; // no LibreOffice on this instance; healthz says so
  assert.equal(res.status, 200);
  assert.equal(json.document.filename, 'inv-INV-TEST-1.docx', 'the filename may itself use placeholders');
  assert.equal(json.pdf.filename, 'inv-INV-TEST-1.pdf');
  assert.equal(Buffer.from(json.pdf.base64, 'base64').subarray(0, 5).toString(), '%PDF-');
  assert.ok(json.pdf.pages >= 1);
  assert.equal(json.credits.used, 2, 'a PDF costs one credit more than the Office file');
});

when('a tag inside a loop that resolved from outside it is reported', async () => {
  const { key } = await account();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: {
      template_base64: b64('invoice.xlsx'),
      data: {
        customer: { name: 'C' }, invoice: { number: 'N', date: '2026-01-01' }, user: { name: 'U' },
        items: [{ description: 'A', qty: 1, price: 2 }],
        note: 'Net 30.',           // {note} is written INSIDE the {#items} loop
      },
    },
  });
  assert.equal(res.status, 200);
  const w = json.warnings.find((x) => x.code === 'resolved_from_outer_scope');
  assert.ok(w, 'a field read from outside the loop must be reported');
  assert.equal(w.field, 'note');
  assert.ok(w.location, 'the warning must say which cell');
});

when('unknown endpoints answer with something useful', async () => {
  const { json, res } = await req('/v1/nonsense');
  assert.equal(res.status, 404);
  assert.equal(json.error.code, 'unknown_endpoint');
  assert.ok(json.error.docs);
});

when('an unauthenticated request is told exactly what is missing', async () => {
  const { res, json } = await req('/v1/templates');
  assert.equal(res.status, 401);
  assert.equal(json.error.code, 'missing_api_key');
  assert.ok(json.error.hint.includes('Authorization'));
});

when('a key that is not ours is rejected as such', async () => {
  const { json } = await req('/v1/templates', { key: 'not_a_docmint_key' });
  assert.equal(json.error.code, 'invalid_api_key');
  assert.ok(json.error.hint.includes('dm_live_'));
});

when('billing reports honestly whether a plan can actually be bought', async () => {
  const { json } = await req('/v1/billing/plans');
  assert.equal(typeof json.billing_available, 'boolean');
  for (const p of json.plans) {
    if (p.price_usd === 0) assert.equal(p.purchasable, false);
    // A plan is only purchasable when Stripe is configured AND it has a price id.
    if (p.purchasable) assert.equal(json.billing_available, true);
  }
});
