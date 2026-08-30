#!/usr/bin/env node
'use strict';
/**
 * Restyles the scorecard table in the built deck.
 *
 * LibreOffice Impress throws away <style:style style:family="table-cell"> when it
 * reads a flat-ODF presentation: the run properties survive, but the cell fill,
 * padding and vertical alignment do not, and every cell comes out of the export
 * carrying Impress's own default table blue (729fcf). Verified by unzipping the
 * converted .pptx and reading <a:tcPr>.
 *
 * The fill lives per cell in <a:tcPr>, with no table-style reference to fight, so
 * the build writes the intended <a:tcPr> straight into the template. The renderer
 * clones a whole <a:tr> per array element, so styling the template's three rows
 * styles every row the fill produces.
 *
 *   node src/style-deck-table.js quarterly-deck.pptx ppt/slides/slide2.xml
 */
const fs = require('fs');
const path = require('path');
const zipPath = path.join(__dirname, '..', '..', 'src', 'ooxml', 'zip.js');
const { readZip, readText, writeEntry, writeZip } = require(zipPath);

const NAVY = '12395B';
const TINT = 'EEF3F8';
const RULE = 'DCE3EA';
const EMU_PT = 12700;

const noLines = '<a:lnL><a:noFill/></a:lnL><a:lnR><a:noFill/></a:lnR>';
const line = (side, pt, colour) =>
  `<a:ln${side} w="${Math.round(pt * EMU_PT)}" cap="flat" cmpd="sng" algn="ctr">`
  + `<a:solidFill><a:srgbClr val="${colour}"/></a:solidFill><a:prstDash val="solid"/></a:ln${side}>`;

/** header, body, total — in the order the template writes them. */
const ROW_STYLES = [
  { fill: `<a:solidFill><a:srgbClr val="${NAVY}"/></a:solidFill>`, top: '<a:lnT><a:noFill/></a:lnT>', bottom: '<a:lnB><a:noFill/></a:lnB>' },
  { fill: '<a:noFill/>', top: '<a:lnT><a:noFill/></a:lnT>', bottom: line('B', 0.5, RULE) },
  { fill: `<a:solidFill><a:srgbClr val="${TINT}"/></a:solidFill>`, top: line('T', 1, NAVY), bottom: '<a:lnB><a:noFill/></a:lnB>' },
];

const tcPrFor = (i) => {
  const s = ROW_STYLES[Math.min(i, ROW_STYLES.length - 1)];
  return '<a:tcPr marL="108000" marR="108000" marT="72000" marB="72000" anchor="ctr">'
    + `${noLines}${s.top}${s.bottom}${s.fill}</a:tcPr>`;
};

const [file, part] = process.argv.slice(2);
if (!file || !part) {
  process.stderr.write('usage: style-deck-table.js <deck.pptx> <ppt/slides/slideN.xml>\n');
  process.exit(2);
}

const zip = readZip(fs.readFileSync(file));
const entry = zip.byName.get(part);
if (!entry) throw new Error(`${file} has no ${part}`);
let xml = readText(entry);

const tblStart = xml.indexOf('<a:tbl>');
const tblEnd = xml.indexOf('</a:tbl>', tblStart);
if (tblStart === -1 || tblEnd === -1) throw new Error(`${part} has no <a:tbl>`);

let tbl = xml.slice(tblStart, tblEnd);
let row = -1;
let cells = 0;
tbl = tbl.replace(/<a:tr\b[^>]*>|<a:tcPr\b[^>]*(?:\/>|>[\s\S]*?<\/a:tcPr>)/g, (m) => {
  if (m.startsWith('<a:tr')) { row += 1; return '<a:tr h="342000">'; }
  cells += 1;
  return tcPrFor(row);
});
// A cell body anchored top looks wrong next to a centred one; the export writes
// anchor="t" on every <a:bodyPr>.
tbl = tbl.replace(/(<a:bodyPr\b[^>]*)anchor="t"/g, '$1anchor="ctr"');

xml = xml.slice(0, tblStart) + tbl + xml.slice(tblEnd);
writeEntry(entry, xml);
fs.writeFileSync(file, writeZip(zip));
process.stdout.write(`${part}: restyled ${row + 1} rows, ${cells} cells\n`);
