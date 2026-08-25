'use strict';
/*
 * Turns fixtures/sharedf.xlsx into fixtures/shared-formula.xlsx by rewriting the
 * D2/D3 formulas as one Excel-style shared-formula group.
 *
 * LibreOffice never emits <f t="shared" ref=".." si=".."/>, but Excel emits it
 * for any column of dragged formulas — which is exactly what the line-total
 * column of an invoice is. A follower cell in such a group carries no formula
 * text at all, only si; a renderer that copies the cell verbatim into a repeated
 * row produces a group whose ref no longer covers its members, and Excel then
 * reports the file as damaged. So the renderer materialises these before
 * expanding, and this fixture is how that path gets tested against the shape
 * Excel actually writes.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readZip, readText, writeEntry, writeZip } = require('../src/ooxml/zip');

const here = __dirname;
const zip = readZip(fs.readFileSync(path.join(here, 'sharedf.xlsx')));
const part = zip.byName.get('xl/worksheets/sheet1.xml');
let xml = readText(part);

const before = xml;
xml = xml.replace('<f aca="false">B2*C2</f>', '<f t="shared" ref="D2:D3" si="0" aca="false">B2*C2</f>');
xml = xml.replace('<f aca="false">B3*C3</f>', '<f t="shared" si="0" aca="false"/>');
if (xml === before) throw new Error('sharedf.xlsx no longer contains the expected formulas');

writeEntry(part, xml);
fs.writeFileSync(process.argv[2] || path.join(here, 'shared-formula.xlsx'), writeZip(zip));
