'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fill } = require('../src/render');
const H = require('./helpers/docx-fixtures');

test('macro-enabled Word output keeps its extension and MIME type', async () => {
  const template = H.patchPart(H.fixture('invoice'), '[Content_Types].xml', (xml) => xml.replace(
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml',
    'application/vnd.ms-word.document.macroEnabled.main+xml',
  ));

  const out = await fill(template, H.invoiceData(), { currency: 'EUR' });

  assert.equal(out.format, 'docx');
  assert.equal(out.outputExt, 'docm');
  assert.equal(out.outputMime, 'application/vnd.ms-word.document.macroEnabled.12');
  assert.equal(out.warnings.at(-1).code, 'macros_not_preserved');
  assert.match(out.warnings.at(-1).message, /macro-enabled extension and content type/);
});
