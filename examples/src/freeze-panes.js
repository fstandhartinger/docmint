#!/usr/bin/env node
'use strict';
/**
 * Freezes the header rows of the built workbook.
 *
 * LibreOffice drops the <office:settings> view block when it reads a flat-ODF
 * spreadsheet (verified: converting sales-report.fods to .ods produces a
 * settings.xml with no "Views" item-set at all), so a frozen pane cannot be
 * authored in the .fods source. The pane lives in the worksheet part rather than
 * in settings, so the build writes it there directly.
 *
 *   node src/freeze-panes.js sales-report.xlsx 5 4
 *
 * freezes 5 rows on the first sheet and 4 on the second. DocMint's XLSX renderer
 * never rewrites the part of a sheet above <sheetData>, so the pane survives the
 * fill unchanged — which is the point: the header row stays put in the delivered
 * workbook, not only in the template.
 */
const fs = require('fs');
const path = require('path');
const zipPath = path.join(__dirname, '..', '..', 'src', 'ooxml', 'zip.js');
const { readZip, readText, writeEntry, writeZip } = require(zipPath);

const [file, ...counts] = process.argv.slice(2);
if (!file || !counts.length) {
  process.stderr.write('usage: freeze-panes.js <workbook.xlsx> <rows-sheet1> [rows-sheet2 ...]\n');
  process.exit(2);
}

const zip = readZip(fs.readFileSync(file));
counts.forEach((n, i) => {
  const rows = Number(n);
  const name = `xl/worksheets/sheet${i + 1}.xml`;
  const entry = zip.byName.get(name);
  if (!entry) throw new Error(`${file} has no ${name}`);
  let xml = readText(entry);
  if (xml.includes('<pane ')) return;
  const pane = `<pane ySplit="${rows}" topLeftCell="A${rows + 1}" activePane="bottomLeft" state="frozen"/>`
    + `<selection pane="bottomLeft" activeCell="A${rows + 1}" sqref="A${rows + 1}"/>`;
  const before = xml;
  // The pane must be the first child of <sheetView>, ahead of any <selection>.
  xml = xml.replace(/(<sheetView\b[^>]*>)(?:<selection\b[^>]*\/>)*/, (m, open) => open + pane);
  if (xml === before) throw new Error(`${name}: no <sheetView> to freeze`);
  writeEntry(entry, xml);
  process.stdout.write(`${name}: frozen at row ${rows}\n`);
});
fs.writeFileSync(file, writeZip(zip));
