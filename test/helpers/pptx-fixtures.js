'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { readZip, readText, writeEntry, writeZip } = require('../../src/ooxml/zip');
const { findElements, attr, applyEdits, escapeXml, decodeXml } = require('../../src/ooxml/xml');
const { flatten } = require('../../src/ooxml/runs');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const OUT = path.join(ROOT, 'out');

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, `${name}.pptx`));

function part(buffer, name) {
  const zip = readZip(buffer);
  const entry = zip.byName.get(name);
  if (!entry) throw new Error(`no part "${name}" in the package`);
  return readText(entry);
}

const hasPart = (buffer, name) => readZip(buffer).byName.has(name);

const partNames = (buffer) => readZip(buffer).entries.map((e) => e.name);

/** Slide part names in the order p:sldIdLst puts them, which is the order a reader shows them. */
function slideParts(buffer) {
  const zip = readZip(buffer);
  const pres = readText(zip.byName.get('ppt/presentation.xml'));
  const relsXml = readText(zip.byName.get('ppt/_rels/presentation.xml.rels'));
  const byId = new Map(findElements(relsXml, 'Relationship')
    .map((el) => [attr(el.openTag, 'Id'), attr(el.openTag, 'Target')]));
  const lst = findElements(pres, 'p:sldIdLst')[0];
  if (!lst || lst.selfClosing) return [];
  return findElements(pres.slice(lst.contentStart, lst.contentEnd), 'p:sldId')
    .map((s) => byId.get(attr(s.openTag, 'r:id')))
    .map((t) => `ppt/${t.replace(/^\.\//, '')}`);
}

const slideCount = (buffer) => slideParts(buffer).length;

/** All the visible text of one slide, paragraph by paragraph. */
function paragraphTexts(xml) {
  return findElements(xml, 'a:p').map((p) => flatten(xml.slice(p.start, p.end), 'a:t').text);
}

function slideTexts(buffer) {
  const zip = readZip(buffer);
  return slideParts(buffer).map((name) => paragraphTexts(readText(zip.byName.get(name))));
}

const slideText = (buffer, index) => slideTexts(buffer)[index].join('\n');

const allText = (buffer) => slideTexts(buffer).map((p) => p.join('\n')).join('\n');

function notesText(buffer, slideIndex) {
  const zip = readZip(buffer);
  const slide = slideParts(buffer)[slideIndex];
  const relsName = slide.replace(/\/([^/]+)$/, '/_rels/$1.rels');
  const relsEntry = zip.byName.get(relsName);
  if (!relsEntry) return null;
  const rel = findElements(readText(relsEntry), 'Relationship')
    .map((el) => ({ type: attr(el.openTag, 'Type'), target: attr(el.openTag, 'Target') }))
    .find((r) => r.type.endsWith('/notesSlide'));
  if (!rel) return null;
  const target = `ppt/${rel.target.replace(/^\.\.\//, '')}`;
  return paragraphTexts(readText(zip.byName.get(target))).join('\n');
}

/**
 * Re-splits every run of a part so each run holds a single character.
 *
 * The fixtures already arrive from LibreOffice with placeholders split across
 * runs, but only where the .fodp asked for it. This is the pathological case —
 * `{title}` as seven runs — and it is the one a naive run-by-run implementation
 * fails on while still passing every other test in the file.
 */
function shredRuns(buffer, partName) {
  const zip = readZip(buffer);
  const entry = zip.byName.get(partName);
  const xml = readText(entry);
  const edits = [];
  for (const r of findElements(xml, 'a:r')) {
    const runXml = xml.slice(r.start, r.end);
    const tEl = findElements(runXml, 'a:t')[0];
    if (!tEl || tEl.selfClosing) continue;
    const text = decodeXml(runXml.slice(tEl.contentStart, tEl.contentEnd));
    if (text.length < 2) continue;
    const rPrEl = findElements(runXml, 'a:rPr')[0];
    const rPr = rPrEl ? runXml.slice(rPrEl.start, rPrEl.end) : '';
    const pieces = [...text]
      .map((ch) => `<a:r>${rPr}<a:t xml:space="preserve">${escapeXml(ch)}</a:t></a:r>`)
      .join('');
    edits.push({ start: r.start, end: r.end, text: pieces });
  }
  writeEntry(entry, applyEdits(xml, edits));
  return writeZip(zip);
}

/** Number of `<a:tr>` rows in the first table of a slide part. */
function tableRowCount(buffer, slideIndex) {
  const zip = readZip(buffer);
  const xml = readText(zip.byName.get(slideParts(buffer)[slideIndex]));
  const tbl = findElements(xml, 'a:tbl')[0];
  if (!tbl) return 0;
  return findElements(xml.slice(tbl.start, tbl.end), 'a:tr').length;
}

// ---------------------------------------------------------------------------
// LibreOffice round-trip — the only proof that matters
// ---------------------------------------------------------------------------

let loAvailable = null;

/** True when the docmint-lo-probe image and pdfinfo are both usable here. */
function libreOfficeAvailable() {
  if (loAvailable !== null) return loAvailable;
  try {
    execFileSync('sudo', ['-n', 'docker', 'image', 'inspect', 'docmint-lo-probe'], { stdio: 'ignore' });
    execFileSync('pdfinfo', ['-v'], { stdio: 'ignore' });
    loAvailable = true;
  } catch {
    loAvailable = false;
  }
  return loAvailable;
}

/**
 * Converts a rendered deck with headless LibreOffice and reports what came out.
 *
 * A slide loop that claims to have produced four slides has produced nothing at
 * all if a reader cannot open the file, so every structural assertion in this
 * suite is backed by a page count from an actual renderer.
 */
function toPdf(buffer, name) {
  fs.mkdirSync(OUT, { recursive: true });
  const pptx = path.join(OUT, `${name}.pptx`);
  fs.writeFileSync(pptx, buffer);
  execFileSync(path.join(ROOT, 'scripts', 'lo.sh'), ['pdf', pptx], { stdio: 'pipe' });
  const pdf = path.join(OUT, `${name}.pdf`);
  if (!fs.existsSync(pdf)) throw new Error(`LibreOffice produced no PDF for ${name}.pptx`);
  const info = execFileSync('pdfinfo', [pdf], { encoding: 'utf8' });
  const pages = Number(/^Pages:\s+(\d+)$/m.exec(info)[1]);
  const text = execFileSync('pdftotext', [pdf, '-'], { encoding: 'utf8' });
  return { pages, text, pdf, pptx };
}

/** A 64x32 PNG, and its JPEG and GIF equivalents, small enough to inline. */
const PNG_64x32 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAKUlEQVR42u3NMQEAAAgDoC252UwGF'
  + 'yRgcrcpEAgEAoFAIBAIBAKBQPCXBzq5AAG0z2WKAAAAAElFTkSuQmCC', 'base64');

const GIF_6x3 = Buffer.from('R0lGODdhBgADAIAAAP///wAAACwAAAAABgADAAACBIQRqAUAOw==', 'base64');

/** Minimal baseline JPEG, 8x5, built by hand so the SOF0 dimensions are known. */
const JPEG_8x5 = (() => {
  const soi = Buffer.from([0xff, 0xd8]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x05, 0x00, 0x08, 0x03,
    0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01]);
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, sof, eoi]);
})();

const tmpFile = (suffix) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'docmint-')), suffix);

module.exports = {
  ROOT,
  FIXTURES,
  OUT,
  fixture,
  part,
  hasPart,
  partNames,
  slideParts,
  slideCount,
  slideTexts,
  slideText,
  allText,
  notesText,
  paragraphTexts,
  shredRuns,
  tableRowCount,
  libreOfficeAvailable,
  toPdf,
  tmpFile,
  PNG_64x32,
  GIF_6x3,
  JPEG_8x5,
};
