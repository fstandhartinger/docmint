'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { names } = require('../src/template/formatters');
const { formatterNames, DESCRIPTIONS } = require('../src/capabilities');

/**
 * The published capability list is generated from the code so that a formatter
 * cannot be documented into existence. This test closes the other direction: a
 * formatter cannot come into existence undocumented either. Both halves are
 * needed, or the list drifts from the implementation in whichever direction
 * nobody is watching.
 */
test('every formatter in the code has a description, and vice versa', () => {
  const inCode = names();
  const described = Object.keys(DESCRIPTIONS);

  const undescribed = inCode.filter((n) => !DESCRIPTIONS[n]);
  assert.deepEqual(undescribed, [], `formatters with no description: ${undescribed.join(', ')}`);

  const phantom = described.filter((n) => !inCode.includes(n));
  assert.deepEqual(phantom, [], `descriptions for formatters that do not exist: ${phantom.join(', ')}`);

  assert.equal(formatterNames().length, inCode.length);
});

test('the condition formatters really do decide a section', () => {
  const { applyFormatters } = require('../src/template/formatters');
  const { passesFor } = require('../src/template/resolve');
  const ctx = { locale: 'en-US', currency: 'EUR', timezone: 'UTC', now: '2026-08-25T00:00:00Z' };

  const decide = (value, name, args) => passesFor(applyFormatters(value, [{ name, args }], ctx)).length;

  // The failure this exists to prevent: our own first example invoice printed
  // OVERDUE whenever the paid list was empty, regardless of the due date.
  assert.equal(decide('2026-09-24', 'past', []), 0, 'a future due date is not overdue');
  assert.equal(decide('2026-07-01', 'past', []), 1, 'a past due date is overdue');
  assert.equal(decide(4803.99, 'gte', ['1000']), 1);
  assert.equal(decide(999, 'gte', ['1000']), 0);
  assert.equal(decide([], 'empty', []), 1);
  assert.equal(decide([1], 'empty', []), 0);
});

test('a quantity is never mistaken for a date', () => {
  const { applyFormatters } = require('../src/template/formatters');
  const ctx = { locale: 'en-US', timezone: 'UTC' };
  // new Date(12) is twelve milliseconds after 1970, so an unguarded implementation
  // answers "yes, that is in the past" about a line-item quantity.
  assert.throws(() => applyFormatters(12, [{ name: 'past', args: [] }], ctx), /needs a date/);
  assert.throws(() => applyFormatters('abc', [{ name: 'past', args: [] }], ctx), /needs a date/);
});
