'use strict';

const { names } = require('./template/formatters');
const { codePlaceholders, IMAGE_BYTES_KEYS } = require('./render/codes');
const { DATA_KEYS, URL_KEYS } = require('./render/image-input');
const { PDF_PASSWORD_MIN_LENGTH, PDF_PASSWORD_MAX_LENGTH } = require('./input');

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

/**
 * The image capability of an image placeholder, identical in DOCX, XLSX and
 * PPTX: bytes from the data (base64 or a data: URI) or one of the code
 * placeholders the service draws itself. A URL in the data is never fetched —
 * the bytes for it come through the request's images option, keyed by the URL
 * or by the tag path, in all three formats alike. The keys are read out of
 * src/render/image-input.js, the one contract all three renderers resolve
 * placeholders through; codes is the canonical list from src/render/codes.js —
 * test/capabilities-parity.test.js checks both against the docs in both
 * directions. bytes.keys are the keys that mark an object as image bytes or a
 * URL; data_keys and url_keys say which is which.
 */
const imageCapabilities = () => ({
  tag: '{%tag}',
  bytes: {
    supplied_as: 'base64 or a data: URI on the tag value — same keys in Word, Excel and PowerPoint — or bytes for a URL through the request\'s images option, keyed by the URL or by the tag path',
    keys: [...IMAGE_BYTES_KEYS],
    data_keys: [...DATA_KEYS],
    url_keys: [...URL_KEYS],
    // The URL keys are accepted only so they can be refused precisely: DocMint
    // never downloads anything. Bytes for a URL go through the images option.
    url_not_fetched: true,
  },
  codes: codePlaceholders(),
});

/**
 * The encryption LibreOffice applies when EncryptFile is set, as measured on
 * a produced file: `qpdf --show-encryption` reports the PDF standard security
 * handler at revision 3, which is 128-bit RC4. Published so a client knows what it is getting — an
 * open password that keeps casual readers out, stated plainly rather than
 * oversold.
 */
const PDF_PASSWORD_ENCRYPTION = 'RC4-128 (PDF standard security handler revision 3, as applied by LibreOffice 7.4)';

/**
 * The PDF open-password capability, read out of the same constants the
 * validator in src/input.js enforces, so the published limits and the enforced
 * limits are one object. The field name and the endpoints it works on are
 * part of the contract: a client should be able to switch on `field` and
 * `endpoints` rather than hard-coding them.
 */
const pdfPasswordCapability = () => ({
  field: 'pdf_password',
  min_length: PDF_PASSWORD_MIN_LENGTH,
  max_length: PDF_PASSWORD_MAX_LENGTH,
  endpoints: ['/v1/render'],
  encryption: PDF_PASSWORD_ENCRYPTION,
});

module.exports = { formatterNames, DESCRIPTIONS, imageCapabilities, pdfPasswordCapability, PDF_PASSWORD_ENCRYPTION };
