'use strict';

const { names } = require('./template/formatters');

/**
 * The published capability list is read out of the code, not written by hand.
 *
 * The previous product in this family shipped documentation claiming features it
 * did not have. The cheapest permanent fix is to make the claim and the
 * implementation the same object: /v1/capabilities lists the formatters that
 * actually exist, so a formatter cannot be documented into existence.
 */

/** Short descriptions for the docs and for the node's help text. */
const DESCRIPTIONS = {
  upper: 'UPPER CASE', lower: 'lower case', title: 'Title Case', trim: 'remove surrounding spaces',
  number: 'group digits in the request locale: number:2 gives 1,234.57 in en-US', currency: 'currency:EUR gives \u20ac1,234.57 in en, 1.234,56 \u20ac in de-DE',
  percent: 'percent:1 turns 0.075 into 7.5%', round: 'round:2', ordinal: '1st, 2nd, 3rd (English)',
  date: 'date:YYYY-MM-DD, or date:long for the locale form',
  default: 'default:- supplies a value when the field is absent',
  join: 'join a list into text: join:, ',
  sum: 'sum:amount adds a field over a list', sumProduct: 'sumProduct:qty:price multiplies then adds',
  count: 'how many items', multiply: 'multiply:1.2', add: 'add:5', subtract: 'subtract:5', divide: 'divide:2',
  yesno: 'yesno:Paid:Unpaid', filter: 'filter:active keeps rows where the field is truthy',
  reject: 'reject:archived drops rows where the field is truthy',
  sort: 'sort:due_date or sort:total:desc', reverse: 'reverse the order',
  limit: 'limit:10', skip: 'skip:5', unique: 'unique:sku', groupBy: 'groupBy:category gives {key, items, count}',

  eq: 'true when equal: {#status|eq:shipped}Dispatched{/status}',
  ne: 'true when not equal',
  gt: 'true when greater: {#total|gt:1000}Free delivery{/total}',
  gte: 'true when greater or equal',
  lt: 'true when less',
  lte: 'true when less or equal',
  contains: 'text contains, or membership in a list',
  empty: 'true for an empty list, empty text, null or false',
  notEmpty: 'the inverse of empty',
  past: 'true when the date is before now: {#due|past}OVERDUE{/due}',
  future: 'true when the date is after now',
  before: 'before a given date: {#issued|before:2026-01-01}',
  after: 'after a given date',
  daysUntil: 'whole days from now until the date',
  daysSince: 'whole days from the date until now',
};

const formatterNames = () => names().map((n) => ({ name: n, does: DESCRIPTIONS[n] || null }));

module.exports = { formatterNames, DESCRIPTIONS };
