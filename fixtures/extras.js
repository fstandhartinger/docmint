'use strict';
/*
 * Turns fixtures/invoice.xlsx into fixtures/invoice-extras.xlsx by adding the
 * sheet-level features that also carry cell ranges: an autofilter, a conditional
 * format over the loop body, a data validation on a looped cell, and a hyperlink
 * on a looped cell.
 *
 * These are injected rather than authored in the .fods because LibreOffice's ODF
 * writer does not round-trip all four into xlsx in the shape Excel writes them,
 * and the point of the fixture is to be the shape Excel writes. Every one of them
 * names a range that moves when rows are inserted, and a renderer that forgets
 * one produces a workbook whose banding, dropdown or link is silently attached to
 * the wrong rows.
 */
const fs = require('node:fs');
const path = require('node:path');
const { readZip, readText, writeEntry, addEntry, writeZip } = require('../src/ooxml/zip');

const here = __dirname;
const zip = readZip(fs.readFileSync(path.join(here, 'invoice.xlsx')));
const sheet = zip.byName.get('xl/worksheets/sheet1.xml');
let xml = readText(sheet);

// Order matters: CT_Worksheet wants autoFilter before mergeCells, and
// conditionalFormatting / dataValidations / hyperlinks after them.
xml = xml.replace('<mergeCells', '<autoFilter ref="A4:D6"/><mergeCells');
xml = xml.replace('<printOptions',
  '<conditionalFormatting sqref="D5:D6 A11"><cfRule type="cellIs" operator="greaterThan" dxfId="0" priority="1"><formula>100</formula></cfRule></conditionalFormatting>'
  + '<dataValidations count="1"><dataValidation type="whole" operator="greaterThan" allowBlank="1" sqref="B5"><formula1>0</formula1></dataValidation></dataValidations>'
  + '<hyperlinks><hyperlink ref="A5" r:id="rIdLink"/></hyperlinks>'
  + '<printOptions');
writeEntry(sheet, xml);

addEntry(zip, 'xl/worksheets/_rels/sheet1.xml.rels',
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
  + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
  + '<Relationship Id="rIdLink" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink"'
  + ' Target="https://example.com/" TargetMode="External"/></Relationships>');

// A conditional format needs a dxf to point at, or Excel calls the file damaged.
const styles = zip.byName.get('xl/styles.xml');
let sxml = readText(styles);
if (!sxml.includes('<dxfs')) {
  sxml = sxml.replace('<cellStyles', '<dxfs count="1"><dxf><font><b val="true"/></font></dxf></dxfs><cellStyles');
}
writeEntry(styles, sxml);

fs.writeFileSync(process.argv[2] || path.join(here, 'invoice-extras.xlsx'), writeZip(zip));
