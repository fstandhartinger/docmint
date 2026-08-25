'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { readZip, readText } = require('../../src/ooxml/zip');
const { findElements, attr, decodeXml } = require('../../src/ooxml/xml');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(ROOT, 'fixtures');
const OUT = path.join(ROOT, 'out');

const fixture = (name) => fs.readFileSync(path.join(FIXTURES, name));

function outPath(name) {
  fs.mkdirSync(OUT, { recursive: true });
  return path.join(OUT, name);
}

function writeOut(name, buffer) {
  const p = outPath(name);
  fs.writeFileSync(p, buffer);
  return p;
}

/** A real 2x2 PNG, built here so the fixtures stay text-only in git. */
function tinyPng(width = 2, height = 2) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32 ? zlib.crc32(td) : crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const raw = Buffer.concat(Array.from({ length: height }, () => Buffer.concat([
    Buffer.from([0]), Buffer.alloc(width * 3, 0x40),
  ])));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

const partText = (buffer, name) => {
  const zip = readZip(buffer);
  const entry = zip.byName.get(name);
  return entry ? readText(entry) : null;
};

const partNames = (buffer) => readZip(buffer).entries.map((e) => e.name);

/**
 * Cells of a sheet as `{ B7: {t, s, v, f, text} }`, so a test can assert on the
 * cell's *type* and not only on the text a viewer happens to show.
 */
function cells(buffer, sheetPart = 'xl/worksheets/sheet1.xml') {
  const xml = partText(buffer, sheetPart);
  const out = {};
  const sd = findElements(xml, 'sheetData')[0];
  const inner = xml.slice(sd.contentStart, sd.contentEnd);
  for (const rowEl of findElements(inner, 'row')) {
    const body = rowEl.selfClosing ? '' : inner.slice(rowEl.contentStart, rowEl.contentEnd);
    for (const cEl of findElements(body, 'c')) {
      const cInner = cEl.selfClosing ? '' : body.slice(cEl.contentStart, cEl.contentEnd);
      const v = findElements(cInner, 'v')[0];
      const f = findElements(cInner, 'f')[0];
      out[attr(cEl.openTag, 'r')] = {
        t: attr(cEl.openTag, 't'),
        s: attr(cEl.openTag, 's'),
        v: v ? decodeXml(cInner.slice(v.contentStart, v.contentEnd)) : null,
        f: f && !f.selfClosing ? decodeXml(cInner.slice(f.contentStart, f.contentEnd)) : null,
        text: findElements(cInner, 't').map((t) => decodeXml(cInner.slice(t.contentStart, t.contentEnd))).join(''),
      };
    }
  }
  return out;
}

/**
 * Runs the file through LibreOffice and returns the first sheet as rows of
 * strings.
 *
 * This is the only check that proves a formula still works. LibreOffice
 * recalculates on load, so a SUM whose range was extended correctly shows the
 * right total in the CSV and one that was left two rows long shows a wrong one —
 * something no amount of XML inspection can tell you.
 */
function toCsvRows(filePath) {
  const script = path.join(ROOT, 'scripts', 'lo.sh');
  const csv = execFileSync(script, ['csv', filePath], { encoding: 'utf8' }).trim();
  return fs.readFileSync(csv, 'utf8').replace(/\r\n/g, '\n').trimEnd().split('\n').map(splitCsv);
}

/** Same, but every sheet, keyed by sheet name. */
function toCsvSheets(filePath) {
  const dir = fs.mkdtempSync(path.join(OUT, 'lo-'));
  const abs = path.resolve(filePath);
  execFileSync('sudo', ['docker', 'run', '--rm', '-m', '512m',
    '-v', `${path.dirname(abs)}:/w`, '-v', `${dir}:/o`, '-e', 'HOME=/tmp', 'docmint-lo-probe',
    'soffice', '--headless', '--norestore', '--convert-to',
    'csv:Text - txt - csv (StarCalc):44,34,76,1,,0,false,true,true,false,false,-1',
    '--outdir', '/o', `/w/${path.basename(abs)}`], { stdio: 'ignore' });
  execFileSync('sudo', ['chown', '-R', `${process.getuid()}:${process.getgid()}`, dir]);
  const base = path.basename(abs, path.extname(abs));
  const out = {};
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.csv')) continue;
    const name = f.slice(base.length + 1, -4);
    out[name] = fs.readFileSync(path.join(dir, f), 'utf8')
      .replace(/\r\n/g, '\n').trimEnd().split('\n').map(splitCsv);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  return out;
}

function splitCsv(line) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i += 1; continue; }
      if (c === '"') { quoted = false; continue; }
      cur += c;
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  out.push(cur);
  return out;
}

/** "1,949.00 $" -> 1949 — LibreOffice writes the cell's *formatted* value. */
const money = (s) => Number(String(s).replace(/[^0-9.\-]/g, ''));

module.exports = {
  FIXTURES, OUT, fixture, outPath, writeOut, tinyPng, partText, partNames, cells,
  toCsvRows, toCsvSheets, money,
};
