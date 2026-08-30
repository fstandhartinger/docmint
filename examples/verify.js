#!/usr/bin/env node
'use strict';
/**
 * Fills the three example templates, converts the results to PDF (and to CSV for
 * the workbook, so LibreOffice evaluates the formulas), and then checks every
 * number that appears in the output against an independent recomputation from
 * the sample data.
 *
 * "Independent" is the point. The template computes its totals with
 * {items|sumProduct:...}; this file adds the same numbers up in plain JavaScript
 * and asserts the formatted string is present in the rendered text. If the
 * formatter pipeline, the row expansion or the spreadsheet formula rewriting
 * ever breaks, an assertion here fails rather than a customer noticing that
 * their invoice totals only its first line.
 *
 *   node examples/verify.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { fill } = require(path.join(__dirname, '..', 'src', 'render'));
const { readZip, readText } = require(path.join(__dirname, '..', 'src', 'ooxml', 'zip'));

const HERE = __dirname;
const OUT = path.join(HERE, 'out');
const IMAGE = 'docmint-lo-examples';
const OPTS = { locale: 'en-GB', currency: 'EUR', timezone: 'UTC' };

const quiet = { info() {}, warn() {}, error() {}, debug() {}, child() { return quiet; } };

let checks = 0;
const failures = [];
function ok(cond, what) {
  checks += 1;
  if (!cond) failures.push(what);
}
function section(name) { process.stdout.write(`\n-- ${name}\n`); }
function note(s) { process.stdout.write(`   ${s}\n`); }

const money = (n) => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'EUR' }).format(n);
const pct = (n, d = 1) => new Intl.NumberFormat('en-GB', { style: 'percent', minimumFractionDigits: d, maximumFractionDigits: d }).format(n);
const thousands = (n) => new Intl.NumberFormat('en-GB').format(n);
const round2 = (n) => Math.round(n * 100) / 100;

function docker(script) {
  return execFileSync('sudo', ['docker', 'run', '--rm', '-m', '1g',
    '-v', `${OUT}:/w`, '-e', 'HOME=/tmp', IMAGE, 'bash', '-c', script],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function chown(files) {
  execFileSync('sudo', ['chown', `${process.getuid()}:${process.getgid()}`, ...files]);
}

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(HERE, f), 'utf8'));

async function fillTo(template, dataFile, outName, data) {
  const buf = fs.readFileSync(path.join(HERE, template));
  const payload = data || readJson(dataFile);
  const res = await fill(buf, payload, { ...OPTS, log: quiet });
  fs.writeFileSync(path.join(OUT, outName), res.buffer);
  return res;
}

/** A CSV row splitter that respects the quoting LibreOffice emits. */
function csvRows(text) {
  const rows = [];
  let row = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cur += '"'; i += 1; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cur); cur = ''; } else if (c === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; } else if (c !== '\r') cur += c;
  }
  row.push(cur);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

const NO_TAGS = /\{\{?[#^/%@!]?[A-Za-z_][A-Za-z0-9_.|:]*\}\}?/;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (/\.(png|pdf|csv)$/.test(f)) fs.unlinkSync(path.join(OUT, f));

  // ---------------------------------------------------------------- fill
  const invoiceData = readJson('invoice.data.json');
  const inv = await fillTo('invoice.docx', 'invoice.data.json', 'invoice.docx');
  const paidData = JSON.parse(JSON.stringify(invoiceData));
  paidData.paid = true;
  const invPaid = await fillTo('invoice.docx', null, 'invoice-paid.docx', paidData);
  const sheet = await fillTo('sales-report.xlsx', 'sales-report.data.json', 'sales-report.xlsx');
  const deck = await fillTo('quarterly-deck.pptx', 'quarterly-deck.data.json', 'quarterly-deck.pptx');

  // ------------------------------------------------------------- convert
  const csvFilter = 'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,true,-1';
  docker([
    'cd /w',
    'for f in invoice.docx invoice-paid.docx sales-report.xlsx quarterly-deck.pptx; do',
    '  soffice --headless --norestore --convert-to pdf --outdir /w "/w/$f" >/dev/null 2>&1;',
    'done',
    `soffice --headless --norestore --convert-to "${csvFilter}" --outdir /w /w/sales-report.xlsx >/dev/null 2>&1`,
    'for f in invoice sales-report quarterly-deck invoice-paid; do pdftotext -layout "/w/$f.pdf" "/w/$f.txt"; done',
    'pdftoppm -png -r 130 -f 1 -l 1 /w/invoice.pdf /w/invoice-page',
    'pdftoppm -png -r 130 /w/sales-report.pdf /w/sales-report-page',
    'pdftoppm -png -r 110 /w/quarterly-deck.pdf /w/quarterly-deck-page',
    'for f in invoice sales-report quarterly-deck invoice-paid; do echo "PAGES $f $(pdfinfo /w/$f.pdf | sed -n \'s/^Pages: *//p\')"; done',
  ].join('\n'));
  chown(fs.readdirSync(OUT).map((f) => path.join(OUT, f)));

  const pageCount = {};
  for (const f of ['invoice', 'sales-report', 'quarterly-deck', 'invoice-paid']) {
    pageCount[f] = Number(execFileSync('sudo', ['docker', 'run', '--rm', '-v', `${OUT}:/w`, '-e', 'HOME=/tmp', IMAGE,
      'bash', '-c', `pdfinfo /w/${f}.pdf | sed -n 's/^Pages: *//p'`], { encoding: 'utf8' }).trim());
  }
  const text = (f) => fs.readFileSync(path.join(OUT, `${f}.txt`), 'utf8');

  // =========================================================== 1. invoice
  section('invoice.docx');
  const items = invoiceData.items;
  const subtotal = round2(items.reduce((s, i) => s + i.qty * i.unit_price, 0));
  const vat = round2(items.reduce((s, i) => s + i.qty * i.unit_price * i.vat_rate, 0));
  const total = round2(items.reduce((s, i) => s + i.qty * i.unit_price * i.vat_factor, 0));
  const invText = text('invoice');

  for (const [n, i] of items.entries()) {
    ok(round2(i.qty * i.unit_price) === i.line_total,
      `item ${n + 1}: line_total ${i.line_total} != qty*unit_price ${round2(i.qty * i.unit_price)}`);
    ok(round2(1 + i.vat_rate) === i.vat_factor, `item ${n + 1}: vat_factor != 1 + vat_rate`);
    ok(i.vat_rate === invoiceData.vat_rate, `item ${n + 1}: vat_rate differs from the invoice vat_rate`);
    ok(invText.includes(money(i.line_total)), `line total ${money(i.line_total)} missing from the PDF`);
    ok(invText.includes(money(i.unit_price)), `unit price ${money(i.unit_price)} missing from the PDF`);
  }
  ok(round2(items.reduce((s, i) => s + i.line_total, 0)) === subtotal, 'sum of line_total != sumProduct(qty, unit_price)');
  ok(round2(subtotal * invoiceData.vat_rate) === vat, 'VAT is not the stated percentage of the subtotal');
  ok(round2(subtotal + vat) === total, 'total != subtotal + VAT');
  ok(invText.includes(money(subtotal)), `subtotal ${money(subtotal)} missing`);
  ok(invText.includes(money(vat)), `VAT ${money(vat)} missing`);
  ok(invText.includes(money(total)), `total ${money(total)} missing`);
  ok(invText.includes(pct(invoiceData.vat_rate, 0)), `VAT rate ${pct(invoiceData.vat_rate, 0)} missing`);
  ok(invText.includes(`${items.length} line items`), 'the {items|count} line is missing');
  ok(pageCount.invoice === 1, `the invoice is ${pageCount.invoice} pages; it should fit on one`);
  // the invoice number has to appear in the body, the running header and the footer
  const invNoCount = (invText.match(new RegExp(invoiceData.invoice_no, 'g')) || []).length;
  ok(invNoCount >= 4, `invoice number appears ${invNoCount} times; expected it in the header, footer and body`);
  ok(invText.includes('Page 1 of 1'), 'the footer page numbering is missing');
  ok(invText.includes('OVERDUE'), 'the {^paid} branch did not render');
  ok(!invText.includes('PAID IN FULL'), 'the {#paid} branch rendered even though paid is false');
  ok(text('invoice-paid').includes('PAID IN FULL'), 'flipping paid to true did not render the {#paid} branch');
  ok(!text('invoice-paid').includes('OVERDUE'), 'flipping paid to true still rendered the {^paid} branch');
  ok(!invText.includes('undefined'), 'the word "undefined" reached the document');
  ok(!NO_TAGS.test(invText), 'an unresolved placeholder reached the document');
  ok(inv.stats.images === 1, `expected 1 image, got ${inv.stats.images}`);
  ok(inv.warnings.length === 0, `the fill produced ${inv.warnings.length} warnings`);
  ok(invPaid.warnings.length === 0, 'the paid variant produced warnings');
  note(`subtotal ${money(subtotal)}  VAT ${pct(invoiceData.vat_rate, 0)} ${money(vat)}  total ${money(total)}`);
  note(`${inv.stats.tags} tags, ${inv.stats.resolved} resolved, ${inv.stats.sections} sections, ${inv.stats.images} image, 1 page`);

  // ===================================================== 2. sales workbook
  section('sales-report.xlsx');
  const rep = readJson('sales-report.data.json');
  const rows = rep.rows;
  const tUnits = rows.reduce((s, r) => s + r.units, 0);
  const tRev = round2(rows.reduce((s, r) => s + r.revenue, 0));
  const tPrior = round2(rows.reduce((s, r) => s + r.prior_revenue, 0));
  const growth = tRev / tPrior - 1;

  const detail = csvRows(fs.readFileSync(path.join(OUT, 'sales-report-Monthly sales.csv'), 'utf8'));
  const summary = csvRows(fs.readFileSync(path.join(OUT, 'sales-report-Summary.csv'), 'utf8'));
  const dataRows = detail.slice(5, 5 + rows.length);
  const totalRow = detail[5 + rows.length];

  ok(dataRows.length === rows.length, `expected ${rows.length} data rows, found ${dataRows.length}`);
  rows.forEach((r, i) => {
    const got = dataRows[i];
    ok(got[0] === r.region && got[1] === r.rep && got[2] === r.channel, `row ${i + 1}: wrong region/rep/channel`);
    ok(got[3] === thousands(r.units), `row ${i + 1}: units ${got[3]} != ${thousands(r.units)}`);
    ok(got[4] === money(r.revenue), `row ${i + 1}: revenue ${got[4]} != ${money(r.revenue)}`);
    ok(got[5] === money(r.prior_revenue), `row ${i + 1}: prior ${got[5]} != ${money(r.prior_revenue)}`);
    ok(got[6] === pct(r.revenue / r.prior_revenue - 1), `row ${i + 1}: growth ${got[6]} != ${pct(r.revenue / r.prior_revenue - 1)}`);
    ok(got[7] === pct(r.revenue / tRev), `row ${i + 1}: share ${got[7]} != ${pct(r.revenue / tRev)}`);
    ok(round2(r.units * r.unit_price) === r.revenue, `row ${i + 1}: revenue != units * unit_price`);
  });
  ok(totalRow[0] === `Total — ${rows.length} lines`, `total row label is "${totalRow[0]}"`);
  ok(totalRow[3] === thousands(tUnits), `SUM of units is ${totalRow[3]}, expected ${thousands(tUnits)}`);
  ok(totalRow[4] === money(tRev), `SUM of revenue is ${totalRow[4]}, expected ${money(tRev)} - the SUM did not follow the expanded rows`);
  ok(totalRow[5] === money(tPrior), `SUM of prior year is ${totalRow[5]}, expected ${money(tPrior)}`);
  ok(totalRow[6] === pct(growth), `total growth is ${totalRow[6]}, expected ${pct(growth)}`);
  ok(totalRow[7] === pct(1), `the share column sums to ${totalRow[7]}, expected ${pct(1)}`);

  const keyRows = detail.slice(5 + rows.length + 1);
  const find = (label) => (keyRows.find((r) => r[0] === label) || [])[4];
  ok(find('Lines in this report') === String(rows.length), 'the {rows|count} key figure is wrong');
  ok(find('Average revenue per unit') === money(round2(tRev / tUnits)),
    `average revenue per unit is ${find('Average revenue per unit')}, expected ${money(round2(tRev / tUnits))}`);
  const bestRep = rows.reduce((a, b) => (b.revenue > a.revenue ? b : a)).rep;
  ok(find('Best-performing rep by revenue') === bestRep, `INDEX/MATCH returned "${find('Best-performing rep by revenue')}", expected "${bestRep}"`);

  const regions = rep.regions;
  const sRows = summary.slice(4, 4 + regions.length);
  ok(sRows.length === regions.length, `summary has ${sRows.length} rows, expected ${regions.length}`);
  regions.forEach((g, i) => {
    ok(sRows[i][0] === g.name, `summary row ${i + 1}: wrong region`);
    ok(sRows[i][1] === g.reps.join(', '), `summary row ${i + 1}: reps "${sRows[i][1]}" != "${g.reps.join(', ')}"`);
    ok(sRows[i][3] === money(g.revenue), `summary row ${i + 1}: revenue ${sRows[i][3]} != ${money(g.revenue)}`);
    const back = rows.filter((r) => r.region === g.name);
    ok(round2(back.reduce((s, r) => s + r.revenue, 0)) === g.revenue, `region ${g.name}: roll-up disagrees with the detail rows`);
    ok(back.reduce((s, r) => s + r.units, 0) === g.units, `region ${g.name}: unit roll-up disagrees with the detail rows`);
  });
  const sTotal = summary[4 + regions.length];
  ok(sTotal[3] === money(tRev), `summary total ${sTotal[3]} != ${money(tRev)}`);
  const topRegion = regions.reduce((a, b) => (b.revenue > a.revenue ? b : a)).name;
  const sKeys = summary.slice(4 + regions.length + 1);
  const sFind = (label) => (sKeys.find((r) => r[0] === label) || [])[3];
  ok(sFind('Top region by revenue') === topRegion, `top region is "${sFind('Top region by revenue')}", expected "${topRegion}"`);
  ok(sFind('Agrees with the detail sheet') === 'Yes', 'the cross-sheet check says the two sheets disagree');

  // the values must be real numbers, not text, or SUM() would have returned zero
  const zip = readZip(fs.readFileSync(path.join(OUT, 'sales-report.xlsx')));
  const sheet1 = readText(zip.byName.get('xl/worksheets/sheet1.xml'));
  const revCells = [...sheet1.matchAll(/<c r="E(\d+)"([^>]*)>/g)].filter((m) => Number(m[1]) >= 6 && Number(m[1]) <= 5 + rows.length);
  ok(revCells.length === rows.length, `expected ${rows.length} revenue cells, found ${revCells.length}`);
  ok(revCells.every((m) => !/t="(inlineStr|s|str)"/.test(m[2])), 'a revenue cell was written as text rather than as a number');
  ok(/<pane [^>]*state="frozen"/.test(sheet1), 'the frozen header row did not survive the fill');
  // the banding and the red-negative rule are conditional formats over the loop
  // body; both have to widen with it or only the first row keeps them
  const lastRow = 5 + rows.length;
  const wantBand = Array.from({ length: rows.length }, (_, i) => `A${6 + i}:H${6 + i}`).join(' ');
  const wantNeg = Array.from({ length: rows.length }, (_, i) => `G${6 + i}`).join(' ');
  const sqrefs = [...sheet1.matchAll(/<conditionalFormatting sqref="([^"]*)"/g)].map((m) => m[1]);
  ok(sqrefs.includes(wantBand), `the row banding covers ${JSON.stringify(sqrefs[0])}, expected rows 6..${lastRow}`);
  ok(sqrefs.includes(wantNeg), `the negative-growth format covers ${JSON.stringify(sqrefs[1])}, expected G6..G${lastRow}`);
  ok(!text('sales-report').includes('undefined'), 'the word "undefined" reached the workbook');
  ok(!NO_TAGS.test(text('sales-report')), 'an unresolved placeholder reached the workbook');
  ok(sheet.warnings.length === 0, `the fill produced ${sheet.warnings.length} warnings`);
  note(`${rows.length} rows expanded; SUM(revenue) ${money(tRev)}, SUM(units) ${thousands(tUnits)}, growth ${pct(growth)}, shares ${pct(1)}`);
  note(`summary: ${regions.length} regions, top ${topRegion}, cross-sheet check "Yes"`);

  // ============================================================ 3. deck
  section('quarterly-deck.pptx');
  const dk = readJson('quarterly-deck.data.json');
  const expectedSlides = 2 + dk.regions.length + 1;
  const deckText = text('quarterly-deck');
  const dRev = round2(dk.regions.reduce((s, r) => s + r.revenue, 0));
  const dPrior = round2(dk.regions.reduce((s, r) => s + r.prior, 0));
  const dUnits = dk.regions.reduce((s, r) => s + r.units, 0);

  ok(pageCount['quarterly-deck'] === expectedSlides,
    `the deck has ${pageCount['quarterly-deck']} slides, expected ${expectedSlides} (title + scorecard + ${dk.regions.length} regions + priorities)`);
  ok(deck.stats.slides === expectedSlides, `stats.slides is ${deck.stats.slides}, expected ${expectedSlides}`);
  ok(round2(dRev / dPrior - 1) === round2(dk.group_growth) || Math.abs(dRev / dPrior - 1 - dk.group_growth) < 1e-6,
    'group_growth is not the group revenue over the group prior year');
  ok(deckText.includes(money(dRev)), `the scorecard total ${money(dRev)} is missing`);
  ok(deckText.includes(thousands(dUnits)), `the scorecard unit total ${thousands(dUnits)} is missing`);
  ok(deckText.includes(pct(dk.group_growth)), `the group growth ${pct(dk.group_growth)} is missing`);
  dk.regions.forEach((r, i) => {
    // growth and share are stored rounded to six decimals, so they are compared at that precision.
    ok(Math.abs(r.revenue / r.prior - 1 - r.growth) < 1e-6, `${r.name}: growth field does not match revenue/prior`);
    ok(Math.abs(r.revenue / dRev - r.share) < 1e-6, `${r.name}: share field does not match revenue/group revenue`);
    ok(deckText.includes(money(r.revenue)), `${r.name}: revenue ${money(r.revenue)} missing from the deck`);
    ok(deckText.includes(pct(r.growth)), `${r.name}: growth ${pct(r.growth)} missing from the deck`);
    ok(deckText.includes(`Region ${i + 1} of ${dk.regions.length}`), `the "Region ${i + 1} of ${dk.regions.length}" footer is missing`);
    for (const h of r.highlights) ok(deckText.includes(h.slice(0, 40)), `${r.name}: a highlight bullet is missing`);
  });
  ok(!deckText.includes('undefined'), 'the word "undefined" reached the deck');
  ok(!NO_TAGS.test(deckText), 'an unresolved placeholder reached the deck');
  ok(deck.warnings.length === 0, `the fill produced ${deck.warnings.length} warnings`);

  const dzip = readZip(fs.readFileSync(path.join(OUT, 'quarterly-deck.pptx')));
  // the scorecard table's cell styling is written into the template by
  // src/style-deck-table.js; row cloning has to carry it onto every generated row
  const scorecard = readText(dzip.byName.get('ppt/slides/slide2.xml'));
  const navyCells = (scorecard.match(/<a:srgbClr val="12395B"\/>/g) || []).length;
  const bodyRules = (scorecard.match(/<a:lnB w="6350"/g) || []).length;
  ok(navyCells >= 5, `expected the 5 header cells to keep the navy fill, found ${navyCells} navy references`);
  ok(bodyRules === 5 * dk.regions.length, `expected ${5 * dk.regions.length} body-row rules, found ${bodyRules}`);

  const notes = dzip.entries.map((e) => e.name).filter((n) => /^ppt\/notesSlides\/notesSlide\d+\.xml$/.test(n));
  ok(notes.length === expectedSlides, `expected ${expectedSlides} notes slides, found ${notes.length}`);
  const notesText = notes.map((n) => readText(dzip.byName.get(n))).join('\n');
  for (const r of dk.regions) ok(notesText.includes(r.question), `${r.name}: the speaker-note question was not cloned onto its slide`);
  note(`${expectedSlides} slides, ${notes.length} notes slides, ${deck.stats.tags} tags all resolved`);
  note(`scorecard total ${money(dRev)} / ${thousands(dUnits)} units / ${pct(dk.group_growth)}`);

  // ------------------------------------------------------- landing images
  const shots = {
    'invoice.png': 'invoice-page-1.png',
    'sales-report.png': 'sales-report-page-1.png',
    'sales-report-summary.png': 'sales-report-page-2.png',
    'quarterly-deck.png': 'quarterly-deck-page-1.png',
    'quarterly-deck-table.png': 'quarterly-deck-page-2.png',
    'quarterly-deck-region.png': 'quarterly-deck-page-3.png',
  };
  for (const [dst, src] of Object.entries(shots)) {
    const from = path.join(OUT, src);
    ok(fs.existsSync(from), `page image ${src} was not produced`);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(HERE, dst));
  }

  section('result');
  if (failures.length) {
    for (const f of failures) process.stdout.write(`   FAIL ${f}\n`);
    process.stdout.write(`\n${failures.length} of ${checks} checks failed\n`);
    process.exit(1);
  }
  process.stdout.write(`   ${checks} checks passed\n`);
  process.stdout.write(`   images written: ${Object.keys(shots).join(', ')}\n`);
}

main().catch((e) => {
  process.stderr.write(`${e.stack || e.message}\n`);
  process.exit(1);
});
