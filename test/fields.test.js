'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const renderer = require('../src/render');

const FIXTURES = path.join(__dirname, '..', 'fixtures');
const officeFixtures = () => fs.readdirSync(FIXTURES).filter((n) => /\.(docx|xlsx|pptx)$/.test(n));
const read = (name) => fs.readFileSync(path.join(FIXTURES, name));

/**
 * The property this whole file exists to protect:
 *
 *   the sample data the API hands you must actually render the template.
 *
 * Field discovery is the product's central claim — every competitor makes you
 * guess the field names, render, open the result in Word and guess again. A
 * discovery endpoint that returns a sample which then fails to render would be
 * worse than useless: it would be that same guessing game with an extra step and
 * an air of authority. So this is asserted against every fixture in the tree, and
 * a new fixture is covered the moment it is added.
 */
test('every fixture renders from the sample data inspect returns for it', async () => {
  const failures = [];
  for (const name of officeFixtures()) {
    const buffer = read(name);
    const info = await renderer.inspect(buffer);
    try {
      const out = await renderer.fill(buffer, info.sample_data, {});
      assert.ok(out.buffer.length > 0, `${name} produced no bytes`);
    } catch (e) {
      failures.push(`${name}: ${e.code} ${e.message}`);
    }
  }
  assert.deepEqual(failures, [], `sample_data failed to render:\n${failures.join('\n')}`);
});

test('discovery reports nesting, not a flat list', async () => {
  const info = await renderer.inspect(read('nested.docx'));
  const byName = (n, scope) => info.fields.find((f) => f.name === n && f.scope === scope);

  // orders -> lines -> tags, three levels, each reported against its parent.
  assert.ok(byName('orders', ''), 'orders should be a root field');
  assert.equal(byName('orders', '').repeating, true);
  assert.ok(byName('lines', 'orders'), 'lines should be scoped to orders');
  assert.ok(byName('sku', 'lines'), 'sku should be scoped to lines');

  // The sample data has to be shaped the same way, or it is not usable.
  assert.ok(Array.isArray(info.sample_data.orders));
  assert.ok(Array.isArray(info.sample_data.orders[0].lines));
  assert.equal(typeof info.sample_data.orders[0].lines[0].sku, 'string');
});

test('loop metadata is never reported as something the caller must send', async () => {
  for (const name of officeFixtures()) {
    const info = await renderer.inspect(read(name));
    for (const f of info.fields) {
      assert.ok(!f.name.startsWith('$'), `${name} reported loop metadata "${f.name}" as a field`);
      assert.notEqual(f.name, '.', `${name} reported "." as a field`);
    }
  }
});

test('types come from the formatters, including formatter arguments', async () => {
  const info = await renderer.inspect(read('invoice.docx'));
  const f = (n, scope = '') => info.fields.find((x) => x.name === n && x.scope === scope);

  assert.equal(f('issued').type, 'date', '{issued|date:...} is a date');
  assert.equal(f('items').type, 'array', '{#items} is a list');
  assert.equal(f('items').repeating, true);
  assert.equal(f('paid').type, 'boolean', '{#paid} with nothing inside it is a flag, not a list');
  assert.equal(f('paid').repeating, false);

  // {items|sumProduct:qty:unit_price} is a statement about the ROWS: it says each
  // one carries a numeric qty. Nothing else in the template says so.
  assert.equal(f('qty', 'items').type, 'number', 'qty is numeric because sumProduct multiplies it');
  assert.equal(f('unit_price', 'items').type, 'number');
});

test('an image tag is reported as a field, not silently dropped', async () => {
  const info = await renderer.inspect(read('invoice.docx'));
  const logo = info.fields.find((f) => f.name === 'logo');
  assert.ok(logo, 'the {%logo} image tag must appear in the field list');
  assert.equal(logo.type, 'image');
});

test('a field with a default is optional, one without is required', async () => {
  const info = await renderer.inspect(read('invoice.xlsx'));
  const note = info.fields.find((f) => f.name === 'note');
  assert.ok(note, 'note should be discovered');
  assert.equal(note.required, false, '{note|default:} is optional');

  const number = info.fields.find((f) => f.name === 'invoice.number');
  assert.equal(number.required, true);
});

test('inspect needs no data and never throws on a template it can read', async () => {
  for (const name of officeFixtures()) {
    const info = await renderer.inspect(read(name));
    assert.ok(['docx', 'xlsx', 'pptx'].includes(info.format), name);
    assert.ok(Array.isArray(info.fields), name);
    assert.ok(Array.isArray(info.tags), name);
    assert.equal(typeof info.sample_data, 'object', name);
  }
});

test('every discovered field names where in the document it is written', async () => {
  const info = await renderer.inspect(read('invoice.docx'));
  for (const f of info.fields) {
    assert.ok(f.locations.length > 0, `${f.name} has no location`);
    assert.equal(typeof f.locations[0], 'string');
  }
});
