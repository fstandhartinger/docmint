'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { render, inspect, toExcelSerial, rewriteFormula } = require('../src/render/xlsx');
const { readZip } = require('../src/ooxml/zip');
const {
  fixture, writeOut, tinyPng, partText, partNames, cells, toCsvRows, toCsvSheets, money,
} = require('./helpers/xlsx-fixtures');

const INVOICE_DATA = (items) => ({
  invoice: { number: 'INV-2026-0007', date: '2026-02-14' },
  customer: { name: 'Acme GmbH' },
  user: { name: 'Flo' },
  items,
});

const LINES = [
  { description: 'Consulting', qty: 10, price: 150, note: 'On site' },
  { description: 'Licence', qty: 2, price: 99.5, note: 'Annual' },
  { description: 'Support', qty: 1, price: 250 },
  { description: 'Travel', qty: 3, price: 12.35, note: 'Berlin' },
  { description: 'Hosting', qty: 12, price: 8.4 },
];

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test('inspect lists every tag with its sheet and cell, and needs no data', async () => {
  const found = await inspect(fixture('invoice.xlsx'));
  assert.equal(found.format, 'xlsx');

  const at = (expr) => found.tags.find((t) => t.expr === expr);
  assert.equal(at('invoice.number').location, 'Invoice!A1');
  assert.equal(at('description').location, 'Invoice!A5');
  assert.equal(at('items').kind, 'section');
  // The Summary sheet is named by its workbook name, not "sheet2".
  assert.equal(at('items|count').location, 'Summary!B3');

  assert.deepEqual(found.fields, [
    'customer.name', 'description', 'invoice.date', 'invoice.number',
    'items', 'note', 'price', 'qty', 'user.name',
  ]);
  assert.ok(found.parts.includes('xl/worksheets/sheet1.xml'));
});

test('inspect reaches text inside a drawing and never throws on a field it cannot resolve', async () => {
  const found = await inspect(fixture('textbox.xlsx'));
  const shape = found.tags.find((t) => t.expr === 'shape.line');
  assert.ok(shape, 'the placeholder split across two a:t runs must still be found');
  assert.equal(shape.location, 'Sheet1, shape text 1');
  assert.ok(found.fields.includes('badge'));
});

// ---------------------------------------------------------------------------
// The shared string table
// ---------------------------------------------------------------------------

test('one shared string used by two cells renders differently in each, and the table is left alone', async () => {
  const src = fixture('shared-cell.xlsx');
  // The premise of the test: LibreOffice really did store one entry for both cells.
  const sst = partText(src, 'xl/sharedStrings.xml');
  assert.match(sst, /uniqueCount="3"/);
  assert.match(sst, /count="4"/);

  const { buffer, stats } = await render(src, { name: 'Root', items: [{ name: 'One' }, { name: 'Two' }] }, {});
  assert.equal(partText(buffer, 'xl/sharedStrings.xml'), sst,
    'sharedStrings.xml must come through byte-for-byte; orphan entries are harmless, edits are not');
  assert.ok(!stats.parts.includes('xl/sharedStrings.xml'));

  const rows = toCsvRows(writeOut('shared-cell.xlsx', buffer));
  assert.deepEqual(rows, [['Hello Root', ''], ['', 'Hello One'], ['', 'Hello Two']]);
});

test('a placeholder split across rich-text runs is found, and keeps the run formatting', async () => {
  // The template has {cus} + {tomer.name} in two <r> runs with different fonts.
  assert.match(partText(fixture('invoice.xlsx'), 'xl/sharedStrings.xml'), /<t xml:space="preserve">\{cus<\/t>/);

  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES), {});
  const c = cells(buffer).B2;
  assert.equal(c.t, 'inlineStr');
  assert.equal(c.text, 'Acme GmbH');
  const xml = partText(buffer, 'xl/worksheets/sheet1.xml');
  assert.match(xml.slice(xml.indexOf('<c r="B2"')), /^<c r="B2"[^>]*><is><r><rPr><b val="true"\/>/,
    'the replacement goes into the run that held the first character, so its bold survives');
});

// ---------------------------------------------------------------------------
// Type fidelity
// ---------------------------------------------------------------------------

test('a whole-cell placeholder that resolves to a number becomes a real numeric cell', async () => {
  const { buffer } = await render(fixture('types.xlsx'), {
    a: 10, b: 20.5, c: '30', price: 1234.567, active: true, when: '2026-02-14',
    code: 'X-9', nothing: null, items: [{ amount: 1.5 }, { amount: 2.25 }],
  }, {});
  const c = cells(buffer);

  assert.deepEqual({ t: c.B1.t, v: c.B1.v }, { t: null, v: '10' });
  assert.deepEqual({ t: c.B2.t, v: c.B2.v }, { t: null, v: '20.5' });
  assert.equal(c.B1.s, '0', 'the style index must survive so the number format does');

  // A string that looks like a number stays a string: turning "007" into 7 would
  // quietly destroy part numbers and postcodes.
  assert.equal(c.B3.t, 'inlineStr');

  assert.deepEqual({ t: c.B6.t, v: c.B6.v }, { t: 'b', v: '1' }, 'a boolean becomes t="b"');
  assert.equal(c.B5.t, 'inlineStr', 'currency returns a formatted string, so the cell stays text');
  assert.equal(c.B11.v, '1234.6', 'round hands back a numeric string and still yields a number cell');
  assert.equal(c.B12.v, '3.75', 'sum yields a number cell');
  assert.equal(c.B13.t, null, 'a null renders as a genuinely blank cell, not an empty string');
  assert.equal(c.B13.v, null);
});

test('a date-formatted cell gets the Excel serial; a {|date:} cell keeps the chosen text', async () => {
  const { buffer } = await render(fixture('types.xlsx'), {
    a: 1, b: 2, c: 3, price: 1, active: false, when: '2026-02-14',
    code: 'c', nothing: null, items: [],
  }, {});
  const c = cells(buffer);
  assert.equal(c.B8.t, null);
  assert.equal(c.B8.v, String(toExcelSerial('2026-02-14')));
  assert.equal(c.B9.t, 'inlineStr');
  assert.equal(c.B9.text, '14.02.2026');

  const rows = toCsvRows(writeOut('types.xlsx', buffer));
  const byLabel = Object.fromEntries(rows.map((r) => [r[0], r[1]]));
  assert.equal(byLabel['date cell'], '14.02.2026', 'the serial is displayed by the cell format');
  assert.equal(byLabel['date text'], '14.02.2026');
});

test('SUM over placeholder cells recalculates — the proof the cells are numbers and not text', async () => {
  const { buffer } = await render(fixture('types.xlsx'), {
    a: 10, b: 20.5, c: '30', price: 1, active: true, when: '2026-02-14',
    code: 'c', nothing: null, items: [],
  }, {});
  const rows = toCsvRows(writeOut('types-sum.xlsx', buffer));
  const sum = money(rows.find((r) => r[0] === 'sum')[1]);
  // 10 + 20.5; the string "30" is not a number and Excel does not add it either.
  assert.equal(sum, 30.5, 'a text cell would have made this 0');
});

test('toExcelSerial counts days from 1899-12-30', () => {
  assert.equal(toExcelSerial('1900-01-01'), 2);
  assert.equal(toExcelSerial('2026-02-14'), 46067);
  assert.equal(toExcelSerial(new Date(Date.UTC(2026, 1, 14, 12, 0, 0))), 46067.5);
  assert.equal(toExcelSerial('not a date'), null);
});

// ---------------------------------------------------------------------------
// Row loops — geometry
// ---------------------------------------------------------------------------

test('a row loop repeats its whole span and moves everything below it', async () => {
  const { buffer, stats } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES), {});
  const c = cells(buffer);

  // Two rows per item, five items, starting at row 5.
  assert.equal(c.A5.text, 'Consulting');
  assert.equal(c.A6.text, 'On site');
  assert.equal(c.A13.text, 'Hosting');
  assert.equal(c.A15.text, 'Subtotal');
  assert.equal(c.A18.text, 'Prepared by Flo');

  assert.equal(stats.sections, 2);
  assert.ok(stats.tags > 0 && stats.resolved >= stats.tags);

  const xml = partText(buffer, 'xl/worksheets/sheet1.xml');
  assert.match(xml, /<dimension ref="A1:D18"\/>/);
  // Row 3 is empty in the template and stays empty; the {^items} row existed and
  // rendered zero times, so it closes up instead of leaving a hole.
  assert.ok(!Object.keys(c).some((r) => r.endsWith('3')));
  assert.equal(c.A17, undefined, 'the inverted row leaves no blank line behind');
});

test('merged ranges inside the loop are repeated, and ones below it move', async () => {
  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES.slice(0, 3)), {});
  const xml = partText(buffer, 'xl/worksheets/sheet1.xml');
  const merges = [...xml.matchAll(/<mergeCell ref="([^"]+)"\/>/g)].map((m) => m[1]);
  assert.deepEqual(merges, ['A1:B1', 'A6:D6', 'A8:D8', 'A10:D10']);
  assert.match(xml, /<mergeCells count="4">/);
});

test('autofilter, conditional formatting, data validation and hyperlinks all follow the rows', async () => {
  const { buffer } = await render(fixture('invoice-extras.xlsx'),
    INVOICE_DATA([{ description: 'A', qty: 1, price: 2 }, { description: 'B', qty: 3, price: 4 }]), {});
  const xml = partText(buffer, 'xl/worksheets/sheet1.xml');

  assert.match(xml, /<autoFilter ref="A4:D8"\/>/);
  assert.match(xml, /<conditionalFormatting sqref="D5:D6 D7:D8 A12">/);
  assert.match(xml, /<dataValidation [^>]*sqref="B5 B7">/);
  assert.equal((xml.match(/<hyperlink ref="/g) || []).length, 2,
    'a hyperlink on a looped row has to appear once per generated row');
  assert.match(xml, /<hyperlink ref="A7" r:id="rIdLink"\/>/);
});

test('a section that renders zero times leaves one blank row where a formula covered it', async () => {
  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA([]), {});
  const c = cells(buffer);
  assert.equal(c.A6, undefined, 'the loop body collapses to a single blank row');
  assert.equal(c.A7.text, 'Subtotal');
  assert.equal(c.D7.f, 'SUM(D5:D5)',
    'the SUM keeps a real range: pointing it at the row that moved up would be circular');
  assert.equal(c.A10.text, 'No line items were supplied.', 'the {^items} branch fires');

  const rows = toCsvRows(writeOut('invoice-empty.xlsx', buffer));
  assert.equal(money(rows.find((r) => r[0] === 'Subtotal')[3]), 0);
  assert.equal(money(rows.find((r) => r[0] === 'Total')[3]), 0);
});

// ---------------------------------------------------------------------------
// Row loops — formulas. The part that makes an invoice template actually work.
// ---------------------------------------------------------------------------

test('the SUM over the loop equals the total computed from the same data', async () => {
  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES), {});
  const path = writeOut('invoice.xlsx', buffer);

  const expected = LINES.reduce((acc, l) => acc + l.qty * l.price, 0);
  const rounded = (n) => Math.round(n * 100) / 100;

  const rows = toCsvRows(path);
  const find = (label) => rows.find((r) => r[0] === label);

  assert.equal(money(find('Subtotal')[3]), rounded(expected));
  assert.equal(money(find('VAT 19%')[3]), rounded(expected * 0.19));
  assert.equal(money(find('Total')[3]), rounded(expected * 1.19));

  // And every line total is its own row's product, so the per-copy translation
  // of B5*C5 landed on the right rows rather than all pointing at the first.
  LINES.forEach((line, i) => {
    assert.equal(money(rows[4 + i * 2][3]), rounded(line.qty * line.price), `line ${i + 1}`);
  });
});

test('a formula below the loop follows the row it pointed at rather than sliding by its own offset', async () => {
  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES.slice(0, 3)), {});
  const c = cells(buffer);
  assert.equal(c.D11.f, 'SUM(D5:D10)', 'the range end extends over every generated row');
  assert.equal(c.D12.f, 'D11*0.19', 'D7 moved to D11, so the reference does too');
  assert.equal(c.D13.f, 'D11+D12');
  assert.equal(c.D5.f, 'B5*C5');
  assert.equal(c.D9.f, 'B9*C9');
  assert.equal(c.D5.v, null, 'the stale cached value is dropped so the viewer recalculates');
  assert.match(partText(buffer, 'xl/workbook.xml'), /fullCalcOnLoad="1"/);
});

test('a formula on another sheet that points into the loop is rewritten too', async () => {
  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES), {});
  assert.equal(cells(buffer, 'xl/worksheets/sheet2.xml').B2.f, 'Invoice!D17');

  const sheets = toCsvSheets(writeOut('invoice-x.xlsx', buffer));
  const expected = Math.round(LINES.reduce((a, l) => a + l.qty * l.price, 0) * 1.19 * 100) / 100;
  assert.equal(money(sheets.Summary.find((r) => r[0] === 'Amount due')[1]), expected);
  assert.equal(sheets.Summary.find((r) => r[0] === 'Lines')[1], String(LINES.length));
});

test('a shared-formula group is materialised before the rows are repeated', async () => {
  const src = fixture('shared-formula.xlsx');
  assert.match(partText(src, 'xl/worksheets/sheet1.xml'), /<f t="shared" si="0" aca="false"\/>/);

  const rows = [{ name: 'A', qty: 2, price: 3 }, { name: 'B', qty: 4, price: 5 }, { name: 'C', qty: 1, price: 100 }];
  const { buffer } = await render(src, { rows }, {});
  const c = cells(buffer);
  assert.equal(c.D2.f, 'B2*C2');
  assert.equal(c.D4.f, 'B4*C4');
  assert.equal(c.D5.f, 'B5*C5', 'the follower that carried only si is now a formula of its own');
  assert.equal(c.D6.f, 'SUM(D2:D5)');
  assert.ok(!partText(buffer, 'xl/worksheets/sheet1.xml').includes('t="shared"'));

  const csv = toCsvRows(writeOut('shared-formula.xlsx', buffer));
  const expected = rows.reduce((a, r) => a + r.qty * r.price, 0) + 2 * 5;
  assert.equal(money(csv.find((r) => r[0] === 'Total')[3]), expected);
});

test('a subtotal inside an outer loop covers only its own iteration', async () => {
  const { buffer } = await render(fixture('nested.xlsx'), {
    depts: [
      { name: 'Eng', staff: [{ name: 'A', salary: 100 }, { name: 'B', salary: 200 }] },
      { name: 'Ops', staff: [{ name: 'C', salary: 50 }] },
    ],
  }, {});
  const c = cells(buffer);
  assert.equal(c.B4.f, 'SUM(B2:B3)');
  assert.equal(c.B6.f, 'SUM(B6:B6)');

  const rows = toCsvRows(writeOut('nested.xlsx', buffer));
  const subtotals = rows.filter((r) => r[0] === 'Subtotal').map((r) => money(r[1]));
  assert.deepEqual(subtotals, [300, 50]);
});

test('rewriteFormula leaves absolute rows, strings and function names alone', () => {
  const map = (row) => row + 10;
  assert.equal(rewriteFormula('SUM(D5:D6)+$D$5', map), 'SUM(D15:D16)+$D$5');
  assert.equal(rewriteFormula('LOG10(A1)', map), 'LOG10(A11)');
  assert.equal(rewriteFormula('IF(A1="B2",A2,0)', map), 'IF(A11="B2",A12,0)');
  assert.equal(rewriteFormula("'Other Sheet'!A1", () => null), "'Other Sheet'!A1");
});

// ---------------------------------------------------------------------------
// Drawings
// ---------------------------------------------------------------------------

test('text in a shape is filled, including a placeholder split across runs', async () => {
  const { buffer, stats } = await render(fixture('textbox.xlsx'), {
    title: 'Q1 report', shape: { line: 'Confidential' }, badge: tinyPng(8, 8),
  }, {});
  const drawing = partText(buffer, 'xl/drawings/drawing1.xml');
  assert.match(drawing, /<a:t>Confidential<\/a:t>/);
  assert.ok(!drawing.includes('{sha'));
  assert.equal(cells(buffer).A1.text, 'Cell tag Q1 report');
  assert.ok(stats.parts.includes('xl/drawings/drawing1.xml'));
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test('{%img} builds the media part, the drawing, both relationship parts and the content types', async () => {
  const png = tinyPng(64, 32);
  const { buffer, stats } = await render(fixture('images.xlsx'), { logo: png, company: 'Acme' }, {});
  assert.equal(stats.images, 1);

  const names = partNames(buffer);
  assert.ok(names.includes('xl/media/image1.png'));
  assert.ok(names.includes('xl/drawings/drawing1.xml'));
  assert.ok(names.includes('xl/drawings/_rels/drawing1.xml.rels'));
  assert.ok(names.includes('xl/worksheets/_rels/sheet1.xml.rels'));

  const media = readZip(buffer).byName.get('xl/media/image1.png');
  assert.equal(Buffer.compare(media.data, png), 0);

  assert.match(partText(buffer, '[Content_Types].xml'), /PartName="\/xl\/drawings\/drawing1.xml"/);
  assert.match(partText(buffer, 'xl/worksheets/sheet1.xml'), /<drawing r:id="rId\d+"\/><\/worksheet>/);

  const drawing = partText(buffer, 'xl/drawings/drawing1.xml');
  // B1: column index 1, row index 0. 64x32 px at 96 dpi is 609600 x 304800 EMU.
  assert.match(drawing, /<xdr:col>1<\/xdr:col>/);
  assert.match(drawing, /<xdr:row>0<\/xdr:row>/);
  assert.match(drawing, /<xdr:ext cx="609600" cy="304800"\/>/);
  assert.equal(cells(buffer).B1.text, '', 'the placeholder text is removed from the cell');

  // It has to survive a real load, not just look right.
  const rows = toCsvRows(writeOut('images.xlsx', buffer));
  assert.equal(rows[1][1], 'Acme');
});

test('{%img} appends to a drawing the sheet already had', async () => {
  const { buffer, stats } = await render(fixture('textbox.xlsx'), {
    title: 'T', shape: { line: 'L' },
    badge: { data: tinyPng(20, 20).toString('base64'), width: 40, height: 40 },
  }, {});
  assert.equal(stats.images, 1);
  const drawing = partText(buffer, 'xl/drawings/drawing1.xml');
  assert.equal((drawing.match(/<xdr:wsDr/g) || []).length, 1);
  assert.match(drawing, /<xdr:twoCellAnchor/, 'the text box that was already there stays');
  assert.match(drawing, /<xdr:oneCellAnchor>/);
  assert.match(drawing, /cx="381000" cy="381000"/, 'the caller-supplied 40x40 px wins over the file header');
  assert.equal((partText(buffer, 'xl/worksheets/sheet1.xml').match(/<drawing /g) || []).length, 1);
});

test('an image URL is refused with an actionable error rather than a broken file', async () => {
  await assert.rejects(
    () => render(fixture('images.xlsx'), { logo: 'https://example.com/logo.png', company: 'A' }, {}),
    (e) => e.code === 'image_url_unsupported' && e.location === 'Cover!B1',
  );
});

// ---------------------------------------------------------------------------
// The missing-field contract
// ---------------------------------------------------------------------------

test('a missing field fails with the sheet and cell it is written in', async () => {
  await assert.rejects(
    () => render(fixture('invoice.xlsx'), INVOICE_DATA([{ descriptionn: 'x', qty: 1, price: 2 }]), {}),
    (e) => {
      assert.equal(e.name, 'TemplateError');
      assert.equal(e.code, 'placeholder_unresolved');
      assert.equal(e.field, 'description');
      assert.equal(e.location, 'Invoice!A5');
      assert.match(e.hint, /Did you mean "descriptionn"/);
      return true;
    },
  );
});

test('a missing section names the cell that opens it', async () => {
  await assert.rejects(
    () => render(fixture('invoice.xlsx'), {
      invoice: { number: 'X', date: '2026-01-01' }, customer: { name: 'C' }, user: { name: 'U' },
    }, {}),
    (e) => e.code === 'section_unresolved' && e.location === 'Invoice!A5',
  );
});

test('a present-but-null value renders empty, and onMissing relaxations work', async () => {
  const base = { invoice: { number: 'X', date: '2026-01-01' }, customer: { name: null }, items: [] };

  const empty = await render(fixture('invoice.xlsx'), base, { onMissing: 'empty' });
  assert.equal(cells(empty.buffer).B2.text, '', 'null is the caller saying "nothing here"');
  assert.equal(cells(empty.buffer).A18, undefined);

  const keep = await render(fixture('invoice.xlsx'), base, { onMissing: 'keep' });
  const kept = Object.values(cells(keep.buffer)).map((c) => c.text).join(' ');
  assert.match(kept, /\{user\.name\}/, 'keep leaves the tag visible for template debugging');
});

test('an unbalanced section is reported against the cell that opened it', async () => {
  const zip = readZip(fixture('shared-cell.xlsx'));
  const sheet = zip.byName.get('xl/worksheets/sheet1.xml');
  const { readText, writeEntry } = require('../src/ooxml/zip');
  const { writeZip } = require('../src/ooxml/zip');
  writeEntry(sheet, readText(sheet).replace('<c r="C2" s="0" t="s"><v>2</v></c>', ''));
  await assert.rejects(
    () => render(writeZip(zip), { name: 'x', items: [] }, {}),
    (e) => e.code === 'section_unbalanced' && e.location === 'Reuse!A2',
  );
});

// ---------------------------------------------------------------------------
// Package fidelity
// ---------------------------------------------------------------------------

test('parts that were not touched come through byte-for-byte', async () => {
  const src = fixture('invoice.xlsx');
  const { buffer, stats } = await render(src, INVOICE_DATA(LINES), {});
  assert.deepEqual(partNames(buffer), partNames(src), 'no part is added, dropped or reordered');

  for (const name of ['xl/styles.xml', 'xl/sharedStrings.xml', 'docProps/app.xml', '[Content_Types].xml']) {
    assert.ok(!stats.parts.includes(name));
    assert.equal(partText(buffer, name), partText(src, name), name);
  }
  // The rendered file has to be re-readable by our own reader, which is the
  // cheapest proof the central directory and the local headers still agree.
  assert.equal(readZip(buffer).entries.length, readZip(src).entries.length);
});

test('cell styles survive the conversion to inline strings and numbers', async () => {
  const before = cells(fixture('invoice.xlsx'));
  const { buffer } = await render(fixture('invoice.xlsx'), INVOICE_DATA(LINES.slice(0, 1)), {});
  const after = cells(buffer);
  assert.equal(after.A1.s, before.A1.s);
  assert.equal(after.C5.s, before.C5.s, 'the currency format on the unit price must not be lost');
  assert.equal(after.D1.s, before.D1.s, 'nor the date format on the invoice date');
});
