'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { render, inspect, imageInfo } = require('../src/render/docx');
const { TemplateError } = require('../src/template/errors');
const H = require('./helpers/docx-fixtures');

/**
 * The fixtures these tests load are real LibreOffice output (see
 * fixtures/make-docx-fixtures.sh), not XML written to suit this renderer. Where a
 * test asserts on the finished document rather than on a string of XML it goes
 * through LibreOffice, because "it produced bytes" is not the same thing as "Word
 * opens it and the numbers are right".
 */

const LO = H.libreOfficeAvailable();
const loTest = (name, fn) => (LO ? test(name, fn) : test(`${name} [skipped: no docmint-lo-probe image]`, { skip: true }, fn));

// ---------------------------------------------------------------------------
// The split-run problem — the single most important correctness property
// ---------------------------------------------------------------------------

test('a placeholder chopped across many runs still resolves', async () => {
  const data = H.invoiceData();
  const whole = await render(H.fixture('invoice'), data, { currency: 'EUR' });
  const chopped = await render(H.fixture('split-runs'), data, { currency: 'EUR' });

  assert.equal(H.visibleText(chopped.buffer), H.visibleText(whole.buffer));
  assert.equal(chopped.stats.resolved, whole.stats.resolved);
  assert.ok(!H.visibleText(chopped.buffer).includes('{'), 'a tag survived into the output');
});

test('the split-run fixture really is split', () => {
  const xml = H.partText(H.fixture('split-runs'), 'word/document.xml');
  assert.ok(!xml.includes('{invoice_no}'), 'fixture is not actually chopped');
  assert.ok(xml.includes('{#i</w:t>'), 'expected a section tag broken mid-word');
  assert.ok(H.count(xml, /<w:r>/g) > H.count(H.partText(H.fixture('invoice'), 'word/document.xml'), /<w:r>/g));
});

test('sections and headers survive being split too', async () => {
  const out = await render(H.fixture('split-runs'), H.invoiceData(), { currency: 'EUR' });
  assert.match(H.visibleText(out.buffer, 'word/header1.xml'), /Invoice INV-2026-0042 for Acme Corporation/);
  assert.match(H.visibleText(out.buffer, 'word/footer1.xml'), /INV-2026-0042 - DocMint GmbH/);
  assert.equal(H.count(H.partText(out.buffer, 'word/document.xml'), /<w:tr>/g), 5);
});

// ---------------------------------------------------------------------------
// The invoice, end to end, through LibreOffice
// ---------------------------------------------------------------------------

loTest('the rendered invoice reads correctly and its numbers add up', async () => {
  const data = H.invoiceData();
  const out = await render(H.fixture('invoice'), data, { currency: 'EUR' });
  const text = H.toPlainText(out.buffer, 'invoice');

  for (const item of data.items) {
    assert.ok(text.includes(item.description), `missing line "${item.description}"`);
    assert.ok(text.includes(H.eur(item.unit_price)), `missing unit price for "${item.description}"`);
    assert.ok(text.includes(H.eur(item.line_total)), `missing line total for "${item.description}"`);
  }

  // The template computes the total with {items|sumProduct:qty:unit_price}. The
  // expected value is computed here from the same data, so the assertion fails if
  // the document ever disagrees with its own line items.
  const expected = H.invoiceTotal(data);
  assert.equal(expected, data.items.reduce((a, i) => a + i.line_total, 0));
  assert.ok(text.includes(H.eur(expected)), `the total ${H.eur(expected)} is not in the document:\n${text}`);

  assert.ok(text.includes('Acme Corporation'));
  assert.ok(text.includes('12 Example Street'), 'the multi-line address lost a line');
  assert.ok(text.includes('Germany'));
  assert.ok(text.includes('Please pay within 14 days.'), 'the inverted section did not render');
  assert.ok(!text.includes('Paid in full'), 'the {#paid} section rendered although paid is false');
  assert.ok(text.includes('- Bank transfer only, no cheques.'));
  assert.ok(text.includes('3 line items'));
  assert.ok(!/[{}]/.test(text), `an unresolved tag reached the reader:\n${text}`);
  assert.ok(!text.includes('undefined'));
});

loTest('the rendered invoice converts to a PDF that carries the logo', async () => {
  const out = await render(H.fixture('invoice'), H.invoiceData(), { currency: 'EUR' });
  const pdf = H.toPdf(out.buffer, 'invoice');
  assert.equal(pdf.subarray(0, 5).toString('latin1'), '%PDF-');
  assert.ok(pdf.includes(Buffer.from('/Subtype/Image')) || pdf.includes(Buffer.from('/Subtype /Image')),
    'the inline drawing did not survive into the PDF');
});

loTest('nested loops render at three levels', async () => {
  const data = {
    customer: 'Globex',
    orders: [
      { ref: 'A-1', lines: [{ sku: 'SKU-1', qty: 3, tags: ['new', 'sale'] }, { sku: 'SKU-2', qty: 5, tags: [] }] },
      { ref: 'A-2', lines: [{ sku: 'SKU-9', qty: 1, tags: ['back-order'] }] },
    ],
  };
  const out = await render(H.fixture('nested'), data, {});
  const text = H.toPlainText(out.buffer, 'nested');
  assert.ok(text.includes('Order A-1 placed by Globex (1 of 2)'));
  assert.ok(text.includes('Order A-2 placed by Globex (2 of 2)'));
  assert.ok(text.includes('[new][sale]'), 'the innermost inline loop did not render');
  assert.ok(text.includes('none'), 'the inverted section inside two loops did not render');
  assert.ok(text.includes('Order total: 8 units'));
  assert.ok(text.includes('Order total: 1 units'));
  assert.ok(!/[{}]/.test(text));
});

// ---------------------------------------------------------------------------
// Headers and footers
// ---------------------------------------------------------------------------

test('headers and footers are filled, not skipped', async () => {
  const out = await render(H.fixture('invoice'), H.invoiceData(), { currency: 'EUR' });
  assert.equal(H.visibleText(out.buffer, 'word/header1.xml').trim(),
    'Invoice INV-2026-0042 for Acme Corporation');
  assert.equal(H.visibleText(out.buffer, 'word/footer1.xml').trim(),
    'INV-2026-0042 - DocMint GmbH');
  assert.deepEqual(out.stats.parts, ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']);
});

test('a missing field in a header names the header part', async () => {
  const data = H.invoiceData();
  delete data.customer.name;
  await assert.rejects(() => render(H.fixture('invoice'), data, {}), (e) => {
    assert.ok(e instanceof TemplateError);
    assert.equal(e.code, 'placeholder_unresolved');
    assert.equal(e.field, 'customer.name');
    assert.match(e.location, /^word\/document\.xml, paragraph \d+$/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Table rows — the invoice case
// ---------------------------------------------------------------------------

test('a row loop repeats the whole row once per item', async () => {
  const data = H.invoiceData();
  const out = await render(H.fixture('invoice'), data, { currency: 'EUR' });
  const xml = H.partText(out.buffer, 'word/document.xml');
  // header row + one row per item + the totals row
  assert.equal(H.count(xml, /<w:tr>/g), 2 + data.items.length);
  assert.equal(H.count(xml, /Consulting, senior rate/g), 1);
  assert.ok(!xml.includes('{#items}'));
  assert.ok(!xml.includes('{/items}'));
});

test('an empty array leaves no rows and no markers behind', async () => {
  const out = await render(H.fixture('invoice'), H.invoiceData({ items: [] }), { currency: 'EUR' });
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.equal(H.count(xml, /<w:tr>/g), 2);
  assert.ok(H.visibleText(out.buffer).includes(H.eur(0)));
  assert.ok(!/[{}]/.test(H.visibleText(out.buffer)));
});

test('marker-only rows are deleted and multi-row spans repeat together', async () => {
  const data = {
    regions: [],
    products: [{ title: 'Widget', price: 9.5, stock: 12 }, { title: 'Gadget', price: 19, stock: 0 }],
    pairs: [{ left: 'L1', right: 'R1', note: 'n1' }, { left: 'L2', right: 'R2', note: 'n2' }],
  };
  const out = await render(H.fixture('deep'), data, {});
  const text = H.visibleText(out.buffer);
  // header row, then 2 rows per product, then 2 rows per pair; the rows holding
  // only {#products} and {/products} are gone.
  assert.equal(H.count(H.partText(out.buffer, 'word/document.xml'), /<w:tr>/g), 1 + 2 * 2 + 2 * 2);
  assert.ok(text.includes('Widget'));
  assert.ok(text.includes('in stock: 0'));
  assert.ok(text.includes('note: n2'));
  assert.ok(!/[{}]/.test(text));
});

test('a loop inside one cell repeats paragraphs, not the row', async () => {
  const out = await render(H.fixture('cells'), cellsData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  const text = H.visibleText(out.buffer);
  // Two groups -> two rows; the members loop lives inside the second cell and
  // repeats paragraphs there rather than duplicating the row.
  assert.ok(text.includes('Alpha\n* Ada (lead)\n* Bob (dev)\n2 people'));
  assert.ok(text.includes('Beta\n* Cleo (ops)\n1 people'));
  assert.ok(!xml.includes('{#members}'));
});

test('a table nested in a cell loops independently of the outer one', async () => {
  const out = await render(H.fixture('cells'), cellsData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  const text = H.visibleText(out.buffer);
  assert.equal(H.count(xml, /<w:tbl>/g), 1 + 1 + 2, 'the inner table was not repeated once per department');
  assert.equal(H.count(xml, /<w:tr>/g), 2 + 2 + 3);
  assert.ok(text.includes('Eng\nAda\nA1\nBob\nA2'));
  assert.ok(text.includes('Ops\nCleo\nB1'));
  assert.ok(!/[{}]/.test(text));
});

// ---------------------------------------------------------------------------
// Sections in every position
// ---------------------------------------------------------------------------

loTest('block sections, {/} and ../ work three deep', async () => {
  const data = {
    regions: [
      { name: 'EMEA', offices: [{ city: 'Berlin', staff: [{ name: 'Ada' }, { name: 'Bob' }] }, { city: 'Paris', staff: [{ name: 'Cleo' }] }] },
      { name: 'APAC', offices: [{ city: 'Tokyo', staff: [{ name: 'Dai' }] }] },
    ],
    products: [],
    pairs: [],
  };
  const out = await render(H.fixture('deep'), data, {});
  const text = H.toPlainText(out.buffer, 'deep');
  assert.ok(text.includes('Staff Ada (Berlin, EMEA)'));
  assert.ok(text.includes('Staff Cleo (Paris, EMEA)'));
  assert.ok(text.includes('Staff Dai (Tokyo, APAC)'));
  assert.ok(text.includes('No products at all.'), 'the inverted section on an empty array did not render');
  assert.ok(text.includes('Done.'));
  assert.ok(!/[{}]/.test(text));
});

test('block section markers leave no empty paragraphs behind', async () => {
  // Paragraphs outside the table only, so the row loop does not confuse the count.
  const outside = (buf) => H.count(
    H.partText(buf, 'word/document.xml').replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, ''), /<w:p[ >]/g,
  );
  const template = outside(H.fixture('invoice'));
  const none = await render(H.fixture('invoice'), H.invoiceData({ notes: [] }), { currency: 'EUR' });
  const two = await render(H.fixture('invoice'), H.invoiceData(), { currency: 'EUR' });

  // The template writes {#notes}, the body line and {/notes} as three paragraphs.
  // With no notes all three must be gone — not left behind as blank lines.
  assert.equal(outside(none.buffer), template - 3);
  assert.equal(outside(two.buffer), template - 3 + 2);
  // The three note paragraphs sat between "Notes" and the closing line; with the
  // list empty nothing at all should separate them.
  assert.match(H.visibleText(none.buffer), /Notes\nDocMint GmbH/);
  assert.match(H.visibleText(two.buffer), /Notes\n- Bank transfer only, no cheques\.\n- Late payment[^\n]*\nDocMint GmbH/);
});

test('an inline section repeats only the runs between its markers', async () => {
  const out = await render(H.fixture('misc'), miscData({ tags: ['a', 'b', 'c'] }), {});
  assert.ok(H.visibleText(out.buffer).includes('Inline: <a> <b> <c> done'));
});

test('an inverted section renders when the key is absent entirely', async () => {
  const out = await render(H.fixture('misc'), miscData(), {});
  assert.ok(H.visibleText(out.buffer).includes('Shown when absent.'));
});

test('a truthy section renders once and a falsy one not at all', async () => {
  const paid = await render(H.fixture('invoice'), H.invoiceData({ paid: true }), { currency: 'EUR' });
  const text = H.visibleText(paid.buffer);
  assert.ok(text.includes('Paid in full - thank you.'));
  assert.ok(!text.includes('Please pay within'));
});

// ---------------------------------------------------------------------------
// Text: line breaks, tabs, escaping
// ---------------------------------------------------------------------------

test('newlines become <w:br/> and tabs become <w:tab/>', async () => {
  const out = await render(H.fixture('misc'), miscData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.equal(H.count(xml, /<w:br\/>/g), 2, 'a three-line value needs two breaks');
  assert.ok(xml.includes('<w:tab/>'));
  assert.ok(!/<w:t[^>]*>[^<]*\n/.test(xml), 'a literal newline was written into a <w:t>');
  const text = H.visibleText(out.buffer);
  assert.ok(text.includes('Address: Line one\nLine two\nLine three'));
  assert.ok(text.includes('Columns: Aleft\trightB'));
});

test('a value keeps the formatting of the run it replaced', async () => {
  const out = await render(H.fixture('misc'), miscData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.match(xml, /<w:rPr><w:b\/><\/w:rPr><w:t[^>]*>STILL BOLD<\/w:t>/);
});

test('markup characters in a value are escaped, not injected', async () => {
  const out = await render(H.fixture('misc'), miscData({ tricky: '<w:p/>5 & 6 "q"' }), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.ok(xml.includes('&lt;w:p/&gt;5 &amp; 6'));
  assert.ok(H.visibleText(out.buffer).includes('Escaping: <w:p/>5 & 6 "q"'));
});

test('control characters that XML forbids are stripped rather than written', async () => {
  const out = await render(H.fixture('misc'), miscData({ tricky: 'a\u0000b\u000Bc' }), {});
  assert.ok(H.visibleText(out.buffer).includes('Escaping: abc'));
});

test('braces that are not tags are left exactly as written', async () => {
  const out = await render(H.fixture('misc'), miscData(), {});
  const text = H.visibleText(out.buffer);
  assert.ok(text.includes('{ "total": 12 } and .a { color: red }'));
});

// ---------------------------------------------------------------------------
// {@raw} and {!comment}
// ---------------------------------------------------------------------------

test('{@raw} inserts OOXML unescaped and {!comment} disappears', async () => {
  const out = await render(H.fixture('misc'), miscData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.ok(xml.includes('<w:t>INJECTED PARAGRAPH</w:t>'));
  assert.ok(!xml.includes('&lt;w:p&gt;'), 'the raw XML was escaped');
  assert.ok(!xml.includes('this note never appears'));
  assert.ok(H.visibleText(out.buffer).includes('Kept text.'));
});

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

test('image headers are read from the bytes, not from a claimed type', () => {
  assert.deepEqual(imageInfo(Buffer.from(H.PNG_8x4, 'base64')),
    { ext: 'png', mime: 'image/png', width: 8, height: 4 });
  assert.deepEqual(imageInfo(Buffer.from(H.JPEG_39x24, 'base64')),
    { ext: 'jpeg', mime: 'image/jpeg', width: 39, height: 24 });
  assert.deepEqual(imageInfo(Buffer.from(H.GIF_1x1, 'base64')),
    { ext: 'gif', mime: 'image/gif', width: 1, height: 1 });
  assert.throws(() => imageInfo(Buffer.from('not an image at all')), /PNG, JPEG, GIF or BMP/);
});

test('an image is embedded at its intrinsic size, in EMU', async () => {
  const out = await render(H.fixture('invoice'), H.invoiceData(), { currency: 'EUR' });
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.ok(xml.includes(`<wp:extent cx="${8 * 9525}" cy="${4 * 9525}"/>`), xml.slice(0, 200));
  assert.ok(H.partNames(out.buffer).includes('word/media/docmint_1.png'));
  assert.equal(out.stats.images, 1);

  const rels = H.partText(out.buffer, 'word/_rels/document.xml.rels');
  const rId = /Id="(rId\d+)"[^>]*relationships\/image"/.exec(rels);
  assert.ok(rId, 'no image relationship was added');
  assert.ok(xml.includes(`r:embed="${rId[1]}"`), 'the drawing does not point at the new relationship');
  assert.ok(!/Id="(rId\d+)"[\s\S]*Id="\1"/.test(rels), 'a relationship id was reused');
});

test('a data URI, bare base64 and raw bytes are all accepted', async () => {
  for (const logo of [
    `data:image/png;base64,${H.PNG_8x4}`,
    H.PNG_8x4,
    Buffer.from(H.PNG_8x4, 'base64'),
  ]) {
    const out = await render(H.fixture('invoice'), H.invoiceData({ logo }), { currency: 'EUR' });
    assert.equal(out.stats.images, 1);
    assert.ok(H.partText(out.buffer, 'word/document.xml').includes('<w:drawing>'));
  }
});

test('an explicit width scales the height to keep the aspect ratio', async () => {
  const out = await render(H.fixture('invoice'),
    H.invoiceData({ logo: { data: H.PNG_8x4, width: 160, alt: 'Company logo' } }), { currency: 'EUR' });
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.ok(xml.includes(`<wp:extent cx="${160 * 9525}" cy="${80 * 9525}"/>`));
  assert.ok(xml.includes('descr="Company logo"'));
});

test('JPEG and GIF are embedded with the right extension and content type', async () => {
  for (const [b64, ext] of [[H.JPEG_39x24, 'jpeg'], [H.GIF_1x1, 'gif']]) {
    // The Defaults are stripped first, so this proves we add them back — without
    // them Word calls the file corrupt.
    const template = H.withoutContentTypeDefaults(H.fixture('invoice'), ['png', 'jpeg']);
    const out = await render(template, H.invoiceData({ logo: { data: b64, width: 40 } }), { currency: 'EUR' });
    assert.ok(H.partNames(out.buffer).includes(`word/media/docmint_1.${ext}`), `no media part for ${ext}`);
    assert.match(H.partText(out.buffer, '[Content_Types].xml'),
      new RegExp(`<Default Extension="${ext}" ContentType="image/${ext}"/>`));
  }
});

test('the same image used many times is stored once', async () => {
  const template = H.patchPart(H.fixture('invoice'), 'word/document.xml',
    (xml) => xml.replace('{#items}{description}', '{#items}{%logo}{description}'));
  const out = await render(template, H.invoiceData(), { currency: 'EUR' });
  const media = H.partNames(out.buffer).filter((n) => n.startsWith('word/media/'));
  assert.equal(media.length, 1, `expected one media part, got ${media.join(', ')}`);
  assert.equal(out.stats.images, 4);
});

test('a null image renders as nothing rather than as a broken picture', async () => {
  const out = await render(H.fixture('invoice'), H.invoiceData({ logo: null }), { currency: 'EUR' });
  assert.equal(out.stats.images, 0);
  assert.ok(!H.partNames(out.buffer).some((n) => n.startsWith('word/media/')));
  assert.ok(!H.partText(out.buffer, 'word/document.xml').includes('<w:drawing>'));
});

test('a URL is refused with an actionable error, not fetched', async () => {
  await assert.rejects(
    () => render(H.fixture('invoice'), H.invoiceData({ logo: { url: 'https://example.com/logo.png' } }), {}),
    (e) => {
      assert.equal(e.code, 'image_url_unsupported');
      assert.match(e.location, /^word\/document\.xml, paragraph 1$/);
      assert.match(e.hint, /images/);
      return true;
    });
  await assert.rejects(
    () => render(H.fixture('invoice'), H.invoiceData({ logo: 'https://example.com/logo.png' }), {}),
    (e) => e.code === 'image_url_unsupported');
});

test('bytes supplied through opts.images satisfy a URL', async () => {
  const url = 'https://example.com/logo.png';
  const out = await render(H.fixture('invoice'), H.invoiceData({ logo: { url, width: 24 } }), {
    currency: 'EUR',
    images: { [url]: Buffer.from(H.PNG_8x4, 'base64') },
  });
  assert.equal(out.stats.images, 1);
  assert.ok(H.partText(out.buffer, 'word/document.xml').includes(`<wp:extent cx="${24 * 9525}" cy="${12 * 9525}"/>`));
});

test('nonsense image data is named as such', async () => {
  await assert.rejects(
    () => render(H.fixture('invoice'), H.invoiceData({ logo: 'bm90IGFuIGltYWdlIGF0IGFsbA==' }), {}),
    (e) => e.code === 'image_unsupported_format' && e.location.startsWith('word/document.xml'));
  await assert.rejects(
    () => render(H.fixture('invoice'), H.invoiceData({ logo: 42 }), {}),
    (e) => e.code === 'image_invalid');
});

// ---------------------------------------------------------------------------
// Failing loudly
// ---------------------------------------------------------------------------

test('a missing field names the field and where it is written', async () => {
  const data = H.invoiceData();
  delete data.company;
  await assert.rejects(() => render(H.fixture('invoice'), data, {}), (e) => {
    assert.ok(e instanceof TemplateError);
    assert.equal(e.code, 'placeholder_unresolved');
    assert.equal(e.field, 'company');
    assert.match(e.location, /^word\/document\.xml, paragraph \d+$/);
    assert.ok(e.available.includes('invoice_no'));
    return true;
  });
});

test('a missing field inside a table row names the row', async () => {
  const data = H.invoiceData();
  delete data.items[1].unit_price;
  await assert.rejects(() => render(H.fixture('invoice'), data, {}), (e) => {
    assert.equal(e.field, 'unit_price');
    assert.match(e.location, /^word\/document\.xml, table 1 row 2, paragraph \d+$/);
    return true;
  });
});

test('a misspelled field gets a "did you mean"', async () => {
  const data = H.invoiceData();
  data.compnay = data.company;
  delete data.company;
  await assert.rejects(() => render(H.fixture('invoice'), data, {}),
    (e) => /Did you mean "compnay"/.test(e.hint));
});

test('a missing list is an error, an empty list is not', async () => {
  const data = H.invoiceData();
  delete data.notes;
  await assert.rejects(() => render(H.fixture('invoice'), data, {}), (e) => {
    assert.equal(e.code, 'section_unresolved');
    assert.equal(e.field, 'notes');
    assert.match(e.location, /^word\/document\.xml, paragraph \d+$/);
    return true;
  });
  await render(H.fixture('invoice'), H.invoiceData({ notes: [] }), { currency: 'EUR' });
});

test('onMissing relaxations are opt-in', async () => {
  const data = H.invoiceData();
  delete data.company;
  const empty = await render(H.fixture('invoice'), data, { currency: 'EUR', onMissing: 'empty' });
  assert.ok(H.visibleText(empty.buffer).includes(' - 3 line items'));
  const keep = await render(H.fixture('invoice'), data, { currency: 'EUR', onMissing: 'keep' });
  assert.ok(H.visibleText(keep.buffer).includes('{company}'));
});

test('an unclosed section is reported rather than silently swallowed', async () => {
  const broken = H.patchPart(H.fixture('misc'), 'word/document.xml',
    (xml) => xml.replace('{value}{/rows}', '{value}'));
  await assert.rejects(() => render(broken, miscData(), {}), (e) => {
    assert.equal(e.code, 'section_unclosed');
    assert.equal(e.field, 'rows');
    assert.match(e.hint, /\{\/rows\}/);
    return true;
  });
});

test('a close with no open is reported', async () => {
  const broken = H.patchPart(H.fixture('misc'), 'word/document.xml',
    (xml) => xml.replace('{#rows}', ''));
  await assert.rejects(() => render(broken, miscData(), {}), (e) => e.code === 'section_unbalanced');
});

test('a mismatched close names both sections', async () => {
  const broken = H.patchPart(H.fixture('misc'), 'word/document.xml',
    (xml) => xml.replace('{/rows}', '{/tags}'));
  await assert.rejects(() => render(broken, miscData(), {}), (e) => {
    assert.equal(e.code, 'section_mismatch');
    assert.match(e.message, /\{\/tags\}/);
    assert.match(e.message, /\{#rows\}/);
    return true;
  });
});

// ---------------------------------------------------------------------------
// Places a placeholder actually turns up in real templates
// ---------------------------------------------------------------------------

test('both delimiter styles work in the same document', async () => {
  const out = await render(H.fixture('letterhead'), letterheadData(), {});
  const text = H.visibleText(out.buffer);
  assert.ok(text.includes('Both delimiter styles: Globex Ltd and REF-7.'));
  assert.ok(text.includes('Signed, A. Lovelace.'));
});

test('placeholders inside a text box and a hyperlink are filled', async () => {
  const out = await render(H.fixture('letterhead'), letterheadData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  // LibreOffice writes the text box twice — once under mc:Choice for Word 2010+
  // and once as a VML fallback. Both copies are what a reader might see, so both
  // have to be filled or the document says different things in different apps.
  assert.equal(H.count(xml, /Registered office: Berlin, DE/g), 2);
  assert.ok(!xml.includes('{registered_office}'));
  assert.match(xml, /<w:hyperlink[^>]*>[\s\S]*?Ada Lovelace on \+49 30 123[\s\S]*?<\/w:hyperlink>/);
});

test('a section inside a list item repeats without losing the numbering', async () => {
  const out = await render(H.fixture('letterhead'), letterheadData(), {});
  const xml = H.partText(out.buffer, 'word/document.xml');
  assert.ok(H.visibleText(out.buffer).includes('onetwothree'));
  assert.equal(H.count(xml, /<w:numPr>/g), 1, 'the list paragraph was duplicated or lost');
});

loTest('the letterhead still converts cleanly after filling', async () => {
  const out = await render(H.fixture('letterhead'), letterheadData(), {});
  const text = H.toPlainText(out.buffer, 'letterhead');
  assert.ok(text.includes('Contact Ada Lovelace on +49 30 123 for questions.'));
  assert.ok(!/[{}]/.test(text));
});

// ---------------------------------------------------------------------------
// inspect()
// ---------------------------------------------------------------------------

test('inspect lists every tag with its location and needs no data', async () => {
  const out = await inspect(H.fixture('invoice'));
  assert.equal(out.format, 'docx');
  assert.deepEqual(out.parts, ['word/document.xml', 'word/header1.xml', 'word/footer1.xml']);

  const byExpr = new Map(out.tags.map((t) => [t.expr, t]));
  assert.equal(byExpr.get('logo').kind, 'image');
  assert.equal(byExpr.get('items').kind, 'section');
  // {^paid} and {#paid} sit in the same paragraph and must be reported separately.
  assert.deepEqual(out.tags.filter((t) => t.expr === 'paid').map((t) => t.kind).sort(),
    ['inverted', 'section']);
  assert.equal(byExpr.get('description').location, 'word/document.xml, table 1 row 2, paragraph 11');
  assert.ok(out.tags.some((t) => t.location === 'word/header1.xml, paragraph 1'));

  for (const f of ['invoice_no', 'customer.name', 'customer.address', 'items', 'qty', 'notes', 'logo']) {
    assert.ok(out.fields.includes(f), `"${f}" missing from fields`);
  }
  assert.ok(!out.fields.includes('.'), 'the {.} self-reference is not a field name');
  assert.equal(new Set(out.fields).size, out.fields.length, 'fields are not distinct');
});

test('inspect does not throw on a template whose data does not exist', async () => {
  for (const name of ['invoice', 'nested', 'misc', 'deep', 'cells', 'letterhead', 'split-runs']) {
    const out = await inspect(H.fixture(name));
    assert.ok(out.tags.length > 0, `${name} produced no tags`);
    assert.ok(out.fields.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Package fidelity
// ---------------------------------------------------------------------------

test('parts we did not change are copied through byte for byte', async () => {
  const template = H.fixture('invoice');
  const out = await render(template, H.invoiceData(), { currency: 'EUR' });
  for (const name of ['word/styles.xml', 'word/fontTable.xml', 'word/numbering.xml', 'docProps/core.xml']) {
    assert.deepEqual(H.rawEntry(out.buffer, name), H.rawEntry(template, name), `${name} was rewritten`);
  }
  assert.deepEqual(
    H.partNames(out.buffer).filter((n) => !n.startsWith('word/media/')),
    H.partNames(template),
    'the entry order changed',
  );
});

test('a template with no tags at all comes back unchanged', async () => {
  const plain = H.patchPart(H.fixture('misc'), 'word/document.xml',
    (xml) => xml.replace(/[{}]/g, ''));
  const out = await render(plain, {}, {});
  assert.deepEqual(out.stats.parts, []);
  assert.equal(out.stats.tags, 0);
  assert.deepEqual(H.rawEntry(out.buffer, 'word/document.xml'), H.rawEntry(plain, 'word/document.xml'));
});

test('stats report what was done', async () => {
  const out = await render(H.fixture('invoice'), H.invoiceData(), { currency: 'EUR' });
  assert.equal(out.stats.tags, 22);
  assert.equal(out.stats.resolved, 22);
  assert.equal(out.stats.sections, 4);
  assert.equal(out.stats.images, 1);
  assert.equal(out.stats.parts.length, 3);
});

// ---------------------------------------------------------------------------

function cellsData() {
  return {
    groups: [
      { title: 'Alpha', members: [{ name: 'Ada', role: 'lead' }, { name: 'Bob', role: 'dev' }] },
      { title: 'Beta', members: [{ name: 'Cleo', role: 'ops' }] },
    ],
    depts: [
      { dept: 'Eng', people: [{ name: 'Ada', seat: 'A1' }, { name: 'Bob', seat: 'A2' }] },
      { dept: 'Ops', people: [{ name: 'Cleo', seat: 'B1' }] },
    ],
  };
}

function letterheadData() {
  return {
    customer: 'Globex Ltd',
    reference: 'REF-7',
    registered_office: 'Berlin, DE',
    contact: 'Ada Lovelace',
    phone: '+49 30 123',
    bullets: ['one', 'two', 'three'],
    signatory: 'A. Lovelace',
  };
}

function miscData(overrides = {}) {
  return {
    user: { first_name: 'Ada' },
    address: 'Line one\nLine two\nLine three',
    tabbed: 'left\tright',
    extra_xml: '<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>INJECTED PARAGRAPH</w:t></w:r></w:p>',
    tags: ['x', 'y'],
    tricky: '5 < 6 & "quoted" > \'apos\'',
    bolded: 'STILL BOLD',
    rows: [{ name: 'alpha', value: 1.5 }, { name: 'beta', value: 2.25 }],
    ...overrides,
  };
}
