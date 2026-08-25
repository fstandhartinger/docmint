'use strict';

/**
 * Chops every placeholder in a .docx across several runs, the way Word does.
 *
 * Word splits a run for reasons that have nothing to do with how the text looks:
 * the author clicked into the middle of a word, spellcheck ran, the file came back
 * from Google Docs, a language attribute changed. The result is that a placeholder
 * typed as one word is stored as three or four separate <w:r> elements, and a
 * renderer that scans run by run finds nothing and silently emits the template
 * unchanged.
 *
 * A fixture converted straight out of LibreOffice keeps each placeholder in one
 * run, so it cannot catch that regression. This takes such a file and produces the
 * pathological version: every text node that contains a brace is exploded into
 * 3-character runs, half of them carrying different formatting so the split is
 * real rather than cosmetic.
 *
 *   node fixtures/split-runs.js fixtures/invoice.docx fixtures/split-runs.docx
 */

const fs = require('node:fs');
const path = require('node:path');
const { readZip, readText, writeEntry, writeZip } = require('../src/ooxml/zip');

const RUN_RE = /<w:r>(<w:rPr>.*?<\/w:rPr>)?(<w:t(?:\s[^>]*)?>)([^<]*)<\/w:t><\/w:r>/g;

function chop(xml) {
  return xml.replace(RUN_RE, (whole, rPr, tOpen, text) => {
    if (!text.includes('{')) return whole;
    const props = rPr || '<w:rPr></w:rPr>';
    const emphasised = props.replace('</w:rPr>', '<w:b/></w:rPr>');
    const out = [];
    for (let i = 0; i < text.length; i += 3) {
      const part = text.slice(i, i + 3);
      // xml:space="preserve" on every piece: a chunk that is a single space would
      // otherwise be dropped by Word and the placeholder would silently change.
      const open = /xml:space/.test(tOpen) ? tOpen : tOpen.replace('>', ' xml:space="preserve">');
      out.push(`<w:r>${(i / 3) % 2 ? emphasised : props}${open}${part}</w:t></w:r>`);
    }
    return out.join('');
  });
}

function main() {
  const [src, dst] = process.argv.slice(2);
  if (!src || !dst) {
    process.stderr.write('usage: split-runs.js <in.docx> <out.docx>\n');
    process.exit(2);
  }
  const zip = readZip(fs.readFileSync(src));
  let touched = 0;
  for (const entry of zip.entries) {
    if (!/^word\/(document|header\d*|footer\d*)\.xml$/.test(entry.name)) continue;
    const xml = readText(entry);
    const out = chop(xml);
    if (out !== xml) { writeEntry(entry, out); touched += 1; }
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.writeFileSync(dst, writeZip(zip));
  process.stdout.write(`${path.basename(dst)} (${touched} parts chopped into 3-character runs)\n`);
}

main();
