'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { render, inspect, probeImage } = require('../src/render/pptx');
const { readZip, readText } = require('../src/ooxml/zip');
const { findElements, attr } = require('../src/ooxml/xml');
const H = require('./helpers/pptx-fixtures');

// ---------------------------------------------------------------------------
// The data. Every number a fixture prints is derived from these objects in the
// assertions too, so a template that hard-codes a total cannot pass.
// ---------------------------------------------------------------------------

const REPORT_DATA = () => ({
  title: 'Q3 Review',
  subtitle: 'Quarterly numbers',
  client: { name: 'Acme GmbH' },
  notes: 'Open with the churn number.',
  logo: H.PNG_64x32,
  rows: [
    { sku: 'A-1', qty: 2, amount: 150 },
    { sku: 'B-2', qty: 1, amount: 99.5 },
    { sku: 'C-3', qty: 5, amount: 12.25 },
  ],
  findings: [
    { label: 'Churn', detail: 'down 2pt', owner: 'Ada' },
    { label: 'ARR', detail: 'up 8%', owner: 'Bo' },
  ],
});

const CHAPTERS_DATA = () => ({
  deck: 'Field Guide',
  chapters: [
    { name: 'Setup', points: ['install', 'configure'] },
    { name: 'Usage', points: ['run'] },
    { name: 'Limits', points: ['memory', 'time', 'disk'] },
  ],
});

const CARDS_DATA = () => ({
  title: 'Deck of Cards',
  cards: [
    { label: 'One', body: 'first' },
    { label: 'Two', body: 'second' },
    { label: 'Three', body: 'third' },
    { label: 'Four', body: 'fourth' },
  ],
});

const NESTED_DATA = () => ({
  regions: [
    { name: 'EMEA', offices: [{ city: 'Berlin', staff: ['Ada', 'Bo'] }, { city: 'Paris', staff: ['Cy'] }] },
    { name: 'APAC', offices: [{ city: 'Tokyo', staff: ['Dee'] }] },
  ],
  address: 'Acme GmbH\n12 Example Street\n10115 Berlin',
  rawrun: '<a:r><a:rPr lang="en-US" b="1"/><a:t>RAWBOLD</a:t></a:r>',
  pic: `data:image/png;base64,${H.PNG_64x32.toString('base64')}`,
});

const eur = (n) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'EUR' }).format(n);

// ---------------------------------------------------------------------------
// values across split runs
// ---------------------------------------------------------------------------

test('replaces a value whose tag LibreOffice split across three runs', async () => {
  // fixtures/report.pptx really does store {title} as {ti|tle|} because the
  // .fodp bolds the middle. Proof that the fixture has the shape we claim:
  const src = H.part(H.fixture('report'), 'ppt/slides/slide1.xml');
  const runs = findElements(src, 'a:t').map((el) => src.slice(el.contentStart, el.contentEnd));
  assert.ok(runs.includes('{ti') && runs.includes('tle'), 'fixture is meant to have a split tag');

  const { buffer } = await render(H.fixture('report'), REPORT_DATA(), {});
  assert.match(H.slideText(buffer, 0), /Q3 Review/);
  assert.match(H.slideText(buffer, 0), /Quarterly numbers for Acme GmbH/);
});

test('replaces a value when every run holds a single character', async () => {
  const shredded = H.shredRuns(H.fixture('report'), 'ppt/slides/slide1.xml');
  const src = H.part(shredded, 'ppt/slides/slide1.xml');
  assert.ok(findElements(src, 'a:t').length > 30, 'the shredder should have produced one run per character');

  const { buffer } = await render(shredded, REPORT_DATA(), {});
  assert.match(H.slideText(buffer, 0), /Q3 Review/);
  assert.ok(!H.allText(buffer).includes('{'), 'no tag may survive');
});

test('keeps the formatting of the run that held the tag', async () => {
  const { buffer } = await render(H.fixture('report'), REPORT_DATA(), {});
  const xml = H.part(buffer, 'ppt/slides/slide1.xml');
  const run = findElements(xml, 'a:r')
    .map((r) => xml.slice(r.start, r.end))
    .find((r) => r.includes('Q3 Review'));
  assert.ok(run.includes('<a:rPr'), 'the replacement must inherit the placeholder run properties');
});

test('never writes the word undefined or leaves a tag behind', async () => {
  for (const [name, data] of [['report', REPORT_DATA()], ['nested', NESTED_DATA()], ['cards', CARDS_DATA()]]) {
    const { buffer } = await render(H.fixture(name), data, {});
    const text = H.allText(buffer);
    assert.ok(!text.includes('undefined'), `${name} leaked "undefined"`);
    assert.ok(!/\{[#^/%@!]?[A-Za-z_$]/.test(text), `${name} left a tag unrendered: ${text}`);
  }
});

// ---------------------------------------------------------------------------
// the missing-field contract
// ---------------------------------------------------------------------------

test('a missing field fails with the field name and the slide and shape', async () => {
  const data = REPORT_DATA();
  delete data.title;
  await assert.rejects(() => render(H.fixture('report'), data, {}), (err) => {
    assert.equal(err.name, 'TemplateError');
    assert.equal(err.code, 'placeholder_unresolved');
    assert.equal(err.field, 'title');
    assert.equal(err.location, 'slide 1, shape "Title 1"');
    assert.match(err.message, /title/);
    return true;
  });
});

test('a typo gets a did-you-mean', async () => {
  const data = REPORT_DATA();
  data.titel = data.title;
  delete data.title;
  await assert.rejects(() => render(H.fixture('report'), data, {}), (err) => {
    assert.match(err.hint, /titel/);
    return true;
  });
});

test('a missing loop names the slide and shape it loops in', async () => {
  const data = REPORT_DATA();
  delete data.findings;
  await assert.rejects(() => render(H.fixture('report'), data, {}), (err) => {
    assert.equal(err.code, 'section_unresolved');
    assert.equal(err.field, 'findings');
    assert.equal(err.location, 'slide 3, shape "Body 6"');
    return true;
  });
});

test('a missing field inside a table cell names the row and cell', async () => {
  const data = REPORT_DATA();
  data.rows = [{ sku: 'A-1', qty: 2 }];
  await assert.rejects(() => render(H.fixture('report'), data, {}), (err) => {
    assert.equal(err.field, 'amount');
    assert.equal(err.location, 'slide 2, table "Items 5", row 2, cell 3');
    return true;
  });
});

test('a present-but-null value renders as empty rather than failing', async () => {
  const data = REPORT_DATA();
  data.subtitle = null;
  const { buffer } = await render(H.fixture('report'), data, {});
  assert.match(H.slideText(buffer, 0), /^\s*for Acme GmbH$/m);
});

test('onMissing empty and keep behave as the contract says', async () => {
  const data = REPORT_DATA();
  delete data.title;

  const empty = await render(H.fixture('report'), data, { onMissing: 'empty' });
  assert.ok(!H.slideText(empty.buffer, 0).includes('{title}'));

  const keep = await render(H.fixture('report'), data, { onMissing: 'keep' });
  assert.match(H.slideText(keep.buffer, 0), /\{title\}/);
});

// ---------------------------------------------------------------------------
// sections
// ---------------------------------------------------------------------------

test('a paragraph loop repeats the paragraphs and deletes the marker lines', async () => {
  const data = REPORT_DATA();
  const { buffer } = await render(H.fixture('report'), data, {});
  const paras = H.slideTexts(buffer)[2].filter((p) => p.trim() !== '');
  const bullets = paras.filter((p) => /^\d+\. /.test(p));
  assert.equal(bullets.length, data.findings.length);
  data.findings.forEach((f, i) => {
    assert.equal(bullets[i], `${i + 1}. ${f.label} - ${f.detail}`);
  });
  assert.ok(!paras.some((p) => p.includes('{')), 'marker paragraphs must be gone');
});

test('an inverted section renders only when the value is empty', async () => {
  const withData = await render(H.fixture('report'), REPORT_DATA(), {});
  assert.ok(!H.allText(withData.buffer).includes('Nothing to report'));

  const empty = REPORT_DATA();
  empty.findings = [];
  const without = await render(H.fixture('report'), empty, {});
  assert.match(H.slideText(without.buffer, 2), /Nothing to report\./);
});

test('an empty loop still leaves a paragraph behind, because PowerPoint needs one', async () => {
  const data = REPORT_DATA();
  data.findings = [];
  const { buffer } = await render(H.fixture('report'), data, {});
  const xml = H.part(buffer, H.slideParts(buffer)[2]);
  for (const body of findElements(xml, 'p:txBody')) {
    const inner = xml.slice(body.start, body.end);
    assert.ok(findElements(inner, 'a:p').length >= 1, 'every txBody must keep at least one a:p');
  }
});

test('three levels of nesting resolve, with ../ reaching outwards', async () => {
  const data = NESTED_DATA();
  const { buffer } = await render(H.fixture('nested'), data, {});
  const text = H.slideText(buffer, 0);

  const expected = [];
  for (const r of data.regions) {
    expected.push(r.name);
    for (const o of r.offices) {
      expected.push(`${o.city}:`);
      for (const s of o.staff) expected.push(`- ${s} (${o.city}, ${r.name})`);
    }
  }
  for (const line of expected) assert.ok(text.includes(line), `missing "${line}" in:\n${text}`);
});

test('inline sections nest inside one paragraph and keep the surrounding runs', async () => {
  const data = NESTED_DATA();
  const { buffer } = await render(H.fixture('nested'), data, {});
  const want = `[${data.regions
    .map((r) => `${r.name}(${r.offices.map((o) => o.city).join('; ')})`)
    .join(' | ')}]`;
  assert.ok(H.slideText(buffer, 0).includes(want), `expected ${want}`);
});

test('an inverted section fires for an absent key and not for a present one', async () => {
  const { buffer } = await render(H.fixture('nested'), NESTED_DATA(), {});
  const text = H.slideText(buffer, 0);
  assert.ok(text.includes('no ghosts here'), 'absent key must render the inverted body');
  assert.ok(!text.includes('no regions at all'), 'present non-empty key must not');
});

test('a comment tag disappears and a raw tag becomes markup', async () => {
  const { buffer } = await render(H.fixture('nested'), NESTED_DATA(), {});
  const xml = H.part(buffer, H.slideParts(buffer)[1]);
  assert.ok(H.slideText(buffer, 1).includes('Kept text'));
  assert.ok(!H.slideText(buffer, 1).includes('this vanishes'));
  assert.ok(/<a:rPr[^>]*b="1"[^>]*\/><a:t>RAWBOLD<\/a:t>/.test(xml), 'raw XML must be inserted as a run, not escaped');
});

test('a newline in a value becomes an a:br between runs', async () => {
  const data = NESTED_DATA();
  const { buffer } = await render(H.fixture('nested'), data, {});
  const xml = H.part(buffer, H.slideParts(buffer)[1]);
  const breaks = findElements(xml, 'a:br').length;
  assert.equal(breaks, data.address.split('\n').length - 1);
  assert.ok(!xml.includes(''), 'the internal break marker must not survive');
});

// ---------------------------------------------------------------------------
// table rows
// ---------------------------------------------------------------------------

test('a row loop produces one a:tr per array element', async () => {
  for (const n of [1, 3, 7]) {
    const data = REPORT_DATA();
    data.rows = Array.from({ length: n }, (_, i) => ({ sku: `S-${i}`, qty: i + 1, amount: (i + 1) * 10.5 }));
    const { buffer } = await render(H.fixture('report'), data, {});
    // header + n data rows + totals row
    assert.equal(H.tableRowCount(buffer, 1), n + 2, `expected ${n + 2} rows for ${n} items`);
    const text = H.slideText(buffer, 1);
    for (const row of data.rows) assert.ok(text.includes(row.sku), `row ${row.sku} missing`);
  }
});

test('the table total is computed from the data, not typed into the template', async () => {
  const data = REPORT_DATA();
  const { buffer } = await render(H.fixture('report'), data, { currency: 'EUR' });
  const total = data.rows.reduce((a, r) => a + r.amount, 0);
  const text = H.slideText(buffer, 1);
  assert.ok(text.includes(eur(total)), `expected total ${eur(total)} in:\n${text}`);
  assert.ok(text.includes(String(data.rows.length)), 'row count must appear');
  for (const r of data.rows) assert.ok(text.includes(eur(r.amount)), `line total ${eur(r.amount)} missing`);
});

test('a loop inside a table cell nests inside the row loop', async () => {
  const data = NESTED_DATA();
  const { buffer } = await render(H.fixture('nested'), data, {});
  assert.equal(H.tableRowCount(buffer, 2), data.regions.length + 1);
  const text = H.slideText(buffer, 2);
  for (const r of data.regions) {
    assert.ok(text.includes(r.offices.map((o) => o.city).join(', ')), 'inner inline loop must render');
    assert.ok(text.includes(String(r.offices.length)), 'count formatter must render');
  }
});

test('an empty row loop removes the template row and keeps the table valid', async () => {
  const data = REPORT_DATA();
  data.rows = [];
  const { buffer } = await render(H.fixture('report'), data, {});
  assert.equal(H.tableRowCount(buffer, 1), 2, 'header and totals rows remain');
});

// ---------------------------------------------------------------------------
// slide loops
// ---------------------------------------------------------------------------

function assertPackageIsSound(buffer) {
  const zip = readZip(buffer);
  const pres = readText(zip.byName.get('ppt/presentation.xml'));
  const ct = readText(zip.byName.get('[Content_Types].xml'));
  const rels = findElements(readText(zip.byName.get('ppt/_rels/presentation.xml.rels')), 'Relationship')
    .map((el) => ({ id: attr(el.openTag, 'Id'), target: attr(el.openTag, 'Target') }));
  const byId = new Map(rels.map((r) => [r.id, r.target]));

  const lst = findElements(pres, 'p:sldIdLst')[0];
  const ids = [];
  for (const s of findElements(pres.slice(lst.contentStart, lst.contentEnd), 'p:sldId')) {
    const rid = attr(s.openTag, 'r:id');
    const id = Number(attr(s.openTag, 'id'));
    assert.ok(byId.has(rid), `presentation.xml uses ${rid} with no relationship`);
    assert.ok(id >= 256 && id < 2147483648, `slide id ${id} out of range`);
    ids.push(id);
    const target = `ppt/${byId.get(rid).replace(/^\.\//, '')}`;
    assert.ok(zip.byName.has(target), `slide part ${target} missing from the zip`);
    assert.ok(ct.includes(`PartName="/${target}"`), `no content type for ${target}`);
  }
  assert.equal(new Set(ids).size, ids.length, 'slide ids must be unique');

  // An Override naming a part that is not in the package is an OPC violation.
  // LibreOffice writes one per .rels part, so deleting a slide has to take two.
  for (const el of findElements(ct, 'Override')) {
    const name = attr(el.openTag, 'PartName').replace(/^\//, '');
    assert.ok(zip.byName.has(name), `[Content_Types].xml declares "${name}", which is not in the package`);
  }

  for (const e of zip.entries) {
    if (!/^ppt\/(slides|notesSlides)\/[^/]+\.xml$/.test(e.name)) continue;
    assert.ok(ct.includes(`PartName="/${e.name}"`), `no content type for ${e.name}`);
    const relsName = e.name.replace(/\/([^/]+)$/, '/_rels/$1.rels');
    const relsEntry = zip.byName.get(relsName);
    if (!relsEntry) continue;
    for (const el of findElements(readText(relsEntry), 'Relationship')) {
      if (attr(el.openTag, 'TargetMode') === 'External') continue;
      const t = attr(el.openTag, 'Target');
      const base = e.name.split('/').slice(0, -1);
      const segs = [...base];
      for (const seg of t.split('/')) {
        if (seg === '.' || seg === '') continue;
        if (seg === '..') segs.pop();
        else segs.push(seg);
      }
      assert.ok(zip.byName.has(segs.join('/')), `${relsName} dangles at "${t}"`);
    }
  }
  return ids.length;
}

test('a slide loop spanning several slides repeats the whole span', async () => {
  const data = CHAPTERS_DATA();
  const { buffer, stats } = await render(H.fixture('chapters'), data, {});

  // intro + (title slide + detail slide) per chapter + outro; the two marker
  // slides carried nothing else and are gone.
  const expected = 1 + (2 * data.chapters.length) + 1;
  assert.equal(H.slideCount(buffer), expected);
  assert.equal(stats.slides, expected);
  assert.equal(assertPackageIsSound(buffer), expected);

  const texts = H.slideTexts(buffer).map((p) => p.join('\n'));
  assert.match(texts[0], /Field Guide/);
  data.chapters.forEach((c, i) => {
    assert.ok(texts[1 + (i * 2)].includes(`Chapter ${i + 1} of ${data.chapters.length}: ${c.name}`));
    assert.ok(texts[2 + (i * 2)].includes(`${c.name} details`));
    for (const p of c.points) assert.ok(texts[2 + (i * 2)].includes(`- ${p}`), `point ${p} missing`);
  });
  assert.match(texts[texts.length - 1], /End of Field Guide/);
});

test('the single-slide form repeats that one slide per element', async () => {
  const data = CARDS_DATA();
  const { buffer } = await render(H.fixture('cards'), data, {});
  const expected = 1 + data.cards.length;
  assert.equal(H.slideCount(buffer), expected);
  assertPackageIsSound(buffer);

  const texts = H.slideTexts(buffer).map((p) => p.join('\n'));
  data.cards.forEach((c, i) => {
    assert.ok(texts[i + 1].includes(c.label));
    assert.ok(texts[i + 1].includes(c.body));
    assert.ok(texts[i + 1].includes(`Card ${i + 1} of ${data.cards.length} in ${data.title}`));
  });
  assert.ok(!texts.join('\n').includes('{#cards}'), 'the marker shapes must be removed');
});

test('a duplicated slide gets its own notes slide, rendered in its own scope', async () => {
  const data = CARDS_DATA();
  const { buffer } = await render(H.fixture('cards'), data, {});
  data.cards.forEach((c, i) => {
    assert.equal(H.notesText(buffer, i + 1), `Speaker notes for ${c.label}`);
  });
  // One notes part per card, and not one shared between them.
  const notes = H.partNames(buffer).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  assert.equal(notes.length, data.cards.length);
});

test('an empty array deletes the looped slides and their parts', async () => {
  const data = CHAPTERS_DATA();
  data.chapters = [];
  const { buffer } = await render(H.fixture('chapters'), data, {});
  assert.equal(H.slideCount(buffer), 2, 'only the intro and the outro survive');
  assertPackageIsSound(buffer);
  const before = H.partNames(H.fixture('chapters')).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  const after = H.partNames(buffer).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n));
  assert.equal(before.length, 6);
  assert.equal(after.length, 2, 'the removed slide parts must leave the package too');
});

test('an empty slide loop deletes the slide and its notes part', async () => {
  const data = CARDS_DATA();
  data.cards = [];
  const { buffer } = await render(H.fixture('cards'), data, {});
  assert.equal(H.slideCount(buffer), 1);
  assert.equal(H.partNames(buffer).filter((n) => n.includes('notesSlides/notesSlide')).length, 0);
  assertPackageIsSound(buffer);
});

test('{^x} works as a slide loop too: the slide appears only when x is empty', async () => {
  const zip = readZip(H.fixture('cards'));
  const marker = zip.byName.get('ppt/slides/slide2.xml');
  const { writeEntry: we, writeZip: wz } = require('../src/ooxml/zip');
  we(marker, readText(marker).replace('{#cards}', '{^cards}'));
  const inverted = wz(zip);

  // An inverted section pushes no loop metadata — there is no iteration to
  // number — so the slide's {$index1} has nothing to resolve to here.
  const opts = { onMissing: 'empty' };
  const shown = await render(inverted, { title: 'T', cards: [], label: 'L', body: 'B' }, opts);
  assert.equal(H.slideCount(shown.buffer), 2, 'an empty array shows the slide once');
  assertPackageIsSound(shown.buffer);

  const hidden = await render(inverted, { title: 'T', cards: [{ label: 'x', body: 'y' }] }, opts);
  assert.equal(H.slideCount(hidden.buffer), 1, 'a non-empty array hides it');
  assertPackageIsSound(hidden.buffer);
});

test('removing every slide is refused rather than emitting a deck a reader cannot open', async () => {
  const buffer = H.fixture('cards');
  // cards.pptx keeps a cover slide, so build the degenerate case by hand: a
  // deck whose only slide is the looped one.
  const zip = readZip(buffer);
  const pres = readText(zip.byName.get('ppt/presentation.xml'));
  const lst = findElements(pres, 'p:sldIdLst')[0];
  const ids = findElements(pres.slice(lst.contentStart, lst.contentEnd), 'p:sldId');
  const onlyLoop = pres.slice(0, lst.contentStart)
    + pres.slice(lst.contentStart, lst.contentEnd).slice(ids[1].start, ids[1].end)
    + pres.slice(lst.contentEnd);
  const { writeEntry: we, writeZip: wz } = require('../src/ooxml/zip');
  we(zip.byName.get('ppt/presentation.xml'), onlyLoop);
  await assert.rejects(() => render(wz(zip), { title: 'x', cards: [] }, {}), (err) => {
    assert.equal(err.code, 'package_invariant');
    assert.match(err.message, /no slides left/);
    return true;
  });
});

test('an unclosed slide loop is reported, not silently ignored', async () => {
  const buffer = H.fixture('chapters');
  const zip = readZip(buffer);
  // Blank the {/chapters} marker so nothing closes the loop.
  const closing = zip.byName.get('ppt/slides/slide5.xml');
  writeEntryText(closing, readText(closing).replace('{/chapters}', 'nothing here'));
  const { writeZip: wz } = require('../src/ooxml/zip');
  await assert.rejects(() => render(wz(zip), CHAPTERS_DATA(), {}), (err) => {
    assert.equal(err.code, 'section_unbalanced');
    assert.match(err.message, /chapters/);
    return true;
  });
});

function writeEntryText(entry, text) {
  const { writeEntry: we } = require('../src/ooxml/zip');
  we(entry, text);
}

// ---------------------------------------------------------------------------
// images
// ---------------------------------------------------------------------------

test('probeImage reads PNG, JPEG and GIF dimensions', () => {
  assert.deepEqual(probeImage(H.PNG_64x32), { ext: 'png', mime: 'image/png', width: 64, height: 32 });
  assert.deepEqual(probeImage(H.JPEG_8x5), { ext: 'jpeg', mime: 'image/jpeg', width: 8, height: 5 });
  assert.deepEqual(probeImage(H.GIF_6x3), { ext: 'gif', mime: 'image/gif', width: 6, height: 3 });
  assert.equal(probeImage(Buffer.from('not an image')), null);
});

test('an image tag alone in a shape becomes a picture sized to that shape', async () => {
  const before = H.part(H.fixture('report'), 'ppt/slides/slide1.xml');
  const logoSp = findElements(before, 'p:sp')
    .map((sp) => before.slice(sp.start, sp.end))
    .find((sp) => sp.includes('{%logo}'));
  const off = findElements(logoSp, 'a:off')[0];
  const ext = findElements(logoSp, 'a:ext')[0];
  const box = {
    x: Number(attr(off.openTag, 'x')),
    y: Number(attr(off.openTag, 'y')),
    cx: Number(attr(ext.openTag, 'cx')),
    cy: Number(attr(ext.openTag, 'cy')),
  };

  const { buffer, stats } = await render(H.fixture('report'), REPORT_DATA(), {});
  assert.equal(stats.images, 1);
  const xml = H.part(buffer, 'ppt/slides/slide1.xml');
  assert.ok(!xml.includes('{%logo}'));
  const pics = findElements(xml, 'p:pic');
  assert.equal(pics.length, 1);

  const pic = xml.slice(pics[0].start, pics[0].end);
  const pExt = findElements(pic, 'a:ext')[0];
  const cx = Number(attr(pExt.openTag, 'cx'));
  const cy = Number(attr(pExt.openTag, 'cy'));
  // 64x32 at 96 DPI, fitted into the shape's box with the aspect ratio kept.
  const scale = Math.min(box.cx / (64 * 9525), box.cy / (32 * 9525));
  assert.equal(cx, Math.round(64 * 9525 * scale));
  assert.equal(cy, Math.round(32 * 9525 * scale));
  assert.ok(cx <= box.cx && cy <= box.cy, 'the picture must stay inside the placeholder box');

  // The bytes, the relationship and the content type all have to be there.
  const media = H.partNames(buffer).filter((n) => n.startsWith('ppt/media/'));
  assert.equal(media.length, 1);
  const rid = /r:embed="([^"]+)"/.exec(pic)[1];
  const rels = H.part(buffer, 'ppt/slides/_rels/slide1.xml.rels');
  assert.ok(rels.includes(`Id="${rid}"`), 'the picture relationship must exist');
  assert.match(H.part(buffer, '[Content_Types].xml'), /Extension="png"/);
});

test('an image tag sharing a shape with text is added at its intrinsic size', async () => {
  const { buffer, stats } = await render(H.fixture('nested'), NESTED_DATA(), {});
  assert.equal(stats.images, 1);
  const xml = H.part(buffer, H.slideParts(buffer)[1]);
  const pics = findElements(xml, 'p:pic');
  assert.equal(pics.length, 1);
  const pic = xml.slice(pics[0].start, pics[0].end);
  const pExt = findElements(pic, 'a:ext')[0];
  assert.equal(Number(attr(pExt.openTag, 'cx')), 64 * 9525);
  assert.equal(Number(attr(pExt.openTag, 'cy')), 32 * 9525);
  assert.ok(H.slideText(buffer, 1).includes('Logo:'), 'the surrounding text stays');
});

test('an explicit width and height override the intrinsic size', async () => {
  const data = NESTED_DATA();
  data.pic = { data: H.PNG_64x32.toString('base64'), width: 200, height: 100 };
  const { buffer } = await render(H.fixture('nested'), data, {});
  const xml = H.part(buffer, H.slideParts(buffer)[1]);
  const pic = xml.slice(findElements(xml, 'p:pic')[0].start, findElements(xml, 'p:pic')[0].end);
  const pExt = findElements(pic, 'a:ext')[0];
  assert.equal(Number(attr(pExt.openTag, 'cx')), 200 * 9525);
  assert.equal(Number(attr(pExt.openTag, 'cy')), 100 * 9525);
});

test('a {url} image is refused with an actionable error rather than a broken deck', async () => {
  for (const value of [{ url: 'https://example.com/logo.png' }, 'https://example.com/logo.png']) {
    const data = NESTED_DATA();
    data.pic = value;
    await assert.rejects(() => render(H.fixture('nested'), data, {}), (err) => {
      assert.equal(err.code, 'image_url_unsupported');
      assert.match(err.hint, /base64/);
      return true;
    });
  }
});

test('a null image renders nothing and a missing one fails loudly', async () => {
  const nulled = NESTED_DATA();
  nulled.pic = null;
  const { buffer, stats } = await render(H.fixture('nested'), nulled, {});
  assert.equal(stats.images, 0);
  assert.equal(findElements(H.part(buffer, H.slideParts(buffer)[1]), 'p:pic').length, 0);

  const missing = NESTED_DATA();
  delete missing.pic;
  await assert.rejects(() => render(H.fixture('nested'), missing, {}), (err) => {
    assert.equal(err.code, 'image_unresolved');
    assert.equal(err.location, 'slide 2, shape "InlineImage 7"');
    return true;
  });
});

test('an unsupported image format is refused rather than embedded', async () => {
  const data = NESTED_DATA();
  data.pic = Buffer.from('%PDF-1.4 this is not a bitmap').toString('base64');
  await assert.rejects(() => render(H.fixture('nested'), data, {}), (err) => {
    assert.equal(err.code, 'image_unsupported_format');
    return true;
  });
});

test('an image tag inside a table cell still produces a picture', async () => {
  // Injected rather than baked into the fixture: it is a corner nobody authors
  // on purpose, and it used to throw because a table cell reported its images
  // differently from a text box.
  const zip = readZip(H.fixture('nested'));
  const slide = zip.byName.get(H.slideParts(H.fixture('nested'))[2]);
  const { writeEntry: we, writeZip: wz } = require('../src/ooxml/zip');
  we(slide, readText(slide).replace('<a:t>Count</a:t>', '<a:t>Count {%pic}</a:t>'));

  const { buffer, stats } = await render(wz(zip), NESTED_DATA(), {});
  assert.equal(stats.images, 2);
  const xml = H.part(buffer, H.slideParts(buffer)[2]);
  assert.equal(findElements(xml, 'p:pic').length, 1);
  assert.ok(H.slideText(buffer, 2).includes('Count'), 'the cell keeps its text');
});

test('the image bytes go in verbatim, once', async () => {
  const { buffer } = await render(H.fixture('report'), REPORT_DATA(), {});
  const zip = readZip(buffer);
  const media = zip.entries.filter((e) => e.name.startsWith('ppt/media/'));
  assert.equal(media.length, 1);
  const { readEntry } = require('../src/ooxml/zip');
  assert.ok(readEntry(media[0]).equals(H.PNG_64x32), 'the source bytes must be stored unchanged');
});

// ---------------------------------------------------------------------------
// inspect
// ---------------------------------------------------------------------------

test('inspect lists every tag with its kind and location, without any data', async () => {
  const info = await inspect(H.fixture('report'));
  assert.equal(info.format, 'pptx');
  assert.ok(info.parts.includes('ppt/slides/slide1.xml'));
  assert.ok(info.parts.includes('ppt/notesSlides/notesSlide1.xml'));

  // `title` appears on the cover and again in the speaker notes, so take the
  // first occurrence rather than letting a Map keep only the last.
  const byExpr = (expr) => info.tags.find((t) => t.expr === expr);
  assert.equal(byExpr('title').kind, 'value');
  assert.equal(byExpr('title').location, 'slide 1, shape "Title 1"');
  assert.equal(byExpr('logo').kind, 'image');
  assert.equal(byExpr('rows').kind, 'section');
  assert.equal(byExpr('sku').location, 'slide 2, table "Items 5", row 2, cell 1');
  assert.equal(byExpr('notes').location, 'slide 1 notes, shape "Notes 1"');

  for (const f of ['title', 'subtitle', 'client.name', 'notes', 'logo', 'rows', 'sku', 'qty', 'findings']) {
    assert.ok(info.fields.includes(f), `fields should mention ${f}`);
  }
  assert.equal(new Set(info.fields).size, info.fields.length, 'fields must be distinct');
  assert.ok(!info.fields.some((f) => f.startsWith('$')), 'loop metadata is not a data path');
});

test('inspect never throws on a deck whose data does not exist yet', async () => {
  for (const name of ['report', 'chapters', 'cards', 'nested']) {
    const info = await inspect(H.fixture(name));
    assert.ok(Array.isArray(info.tags) && info.tags.length > 0, `${name} should have tags`);
  }
});

// ---------------------------------------------------------------------------
// stats and options
// ---------------------------------------------------------------------------

test('stats name the parts that were touched and count what was done', async () => {
  const { stats } = await render(H.fixture('report'), REPORT_DATA(), {});
  assert.ok(stats.tags > 0 && stats.resolved > 0 && stats.sections > 0);
  assert.equal(stats.images, 1);
  assert.ok(stats.parts.includes('ppt/slides/slide1.xml'));
  assert.ok(stats.parts.includes('ppt/notesSlides/notesSlide1.xml'));
  assert.ok(stats.parts.includes('[Content_Types].xml'));
  assert.ok(!stats.parts.some((p) => p.includes('slideLayout')), 'layouts are left alone by default');
});

test('includeLayouts is opt-in and does not break the package', async () => {
  const { buffer, stats } = await render(H.fixture('report'), REPORT_DATA(), { includeLayouts: true });
  assertPackageIsSound(buffer);
  assert.ok(stats.parts.length > 0);
});

test('an untouched part keeps its original bytes', async () => {
  const src = readZip(H.fixture('report'));
  const { buffer } = await render(H.fixture('report'), REPORT_DATA(), {});
  const out = readZip(buffer);
  const theme = 'ppt/theme/theme1.xml';
  assert.equal(readText(out.byName.get(theme)), readText(src.byName.get(theme)));
});

// ---------------------------------------------------------------------------
// LibreOffice: the deck has to actually open and paginate
// ---------------------------------------------------------------------------

const loSkip = { skip: H.libreOfficeAvailable() ? false : 'LibreOffice probe image or poppler not available' };

test('LibreOffice opens the rendered report and paginates it', loSkip, async () => {
  const { buffer } = await render(H.fixture('report'), REPORT_DATA(), { currency: 'EUR' });
  const pdf = H.toPdf(buffer, 'test-report');
  assert.equal(pdf.pages, 3);
  const data = REPORT_DATA();
  assert.match(pdf.text, /Q3 Review/);
  assert.ok(pdf.text.includes(eur(data.rows.reduce((a, r) => a + r.amount, 0))), 'the computed total must be on the slide');
  for (const r of data.rows) assert.ok(pdf.text.includes(r.sku));
  assert.ok(!pdf.text.includes('{'), 'no tag may reach the PDF');
});

test('a slide loop that says it made N slides really makes an N-page PDF', loSkip, async () => {
  for (const count of [1, 3, 5]) {
    const data = CHAPTERS_DATA();
    data.chapters = Array.from({ length: count }, (_, i) => ({ name: `C${i}`, points: [`p${i}`] }));
    const { buffer, stats } = await render(H.fixture('chapters'), data, {});
    const expected = 1 + (2 * count) + 1;
    assert.equal(stats.slides, expected);
    const pdf = H.toPdf(buffer, `test-chapters-${count}`);
    assert.equal(pdf.pages, expected, `${count} chapters should paginate to ${expected} pages`);
    for (let i = 0; i < count; i += 1) {
      assert.ok(pdf.text.includes(`Chapter ${i + 1} of ${count}: C${i}`), `chapter ${i} missing from the PDF`);
    }
  }
});

test('the single-slide loop paginates to one page per element', loSkip, async () => {
  const data = CARDS_DATA();
  const { buffer } = await render(H.fixture('cards'), data, {});
  const pdf = H.toPdf(buffer, 'test-cards');
  assert.equal(pdf.pages, 1 + data.cards.length);
  for (const c of data.cards) assert.ok(pdf.text.includes(c.label));
});

test('an embedded image survives the round trip into the PDF', loSkip, async () => {
  const { buffer } = await render(H.fixture('report'), REPORT_DATA(), {});
  const pdf = H.toPdf(buffer, 'test-image');
  const { execFileSync } = require('node:child_process');
  const list = execFileSync('pdfimages', ['-list', pdf.pdf], { encoding: 'utf8' });
  const row = list.split('\n').find((l) => /^\s+1\s+\d+\s+image/.test(l));
  assert.ok(row, `expected an image on page 1:\n${list}`);
  assert.match(row, /\b64\s+32\b/, 'the 64x32 source pixels must be what got embedded');
});

test('the nested deck opens and every level of the loop is on the page', loSkip, async () => {
  const data = NESTED_DATA();
  const { buffer } = await render(H.fixture('nested'), data, {});
  const pdf = H.toPdf(buffer, 'test-nested');
  assert.equal(pdf.pages, 3);
  for (const r of data.regions) {
    assert.ok(pdf.text.includes(r.name));
    for (const o of r.offices) {
      for (const s of o.staff) assert.ok(pdf.text.includes(`- ${s} (${o.city}, ${r.name})`), `${s} missing`);
    }
  }
  for (const line of data.address.split('\n')) assert.ok(pdf.text.includes(line), `address line "${line}" missing`);
});
