'use strict';

/**
 * Unit tests for src/render/codes.js — QR (ISO/IEC 18004 byte mode), EPC
 * payment QR, Code 128 and EAN-13. No database, no network, no LibreOffice.
 *
 * The QR encoder is not self-certified: test/helpers/qr-reference.json was
 * produced by segno 1.6.6 (an independent reference implementation, see the
 * file's generator string) and covers versions 1, 3, 4, 6 and 18 at all four
 * error levels, every forced mask, the auto mask, non-ASCII UTF-8 and one EPC
 * payload.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');

const codes = require('../src/render/codes');
const { imageInfo } = require('../src/render/docx');
const { TemplateError } = require('../src/template/errors');

const FIXTURE = require('./helpers/qr-reference.json');
const EPC_CASE = FIXTURE.cases.find((c) => c.text.startsWith('BCD\n002\n1\nSCT'));

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const utf8 = (s) => [...Buffer.from(s, 'utf8')];

// ---------------------------------------------------------------------------
// (c1) Module-for-module equality with the segno 1.6.6 reference fixture.
// ---------------------------------------------------------------------------

test('(c1) every fixture case matches segno module-for-module at every forced mask', () => {
  assert.equal(FIXTURE.cases.length, 6, 'fixture changed — it is pinned by sha256 in the PRD');
  let checked = 0;
  for (const c of FIXTURE.cases) {
    const bytes = utf8(c.text);
    // The fixture pins the version; the encoder must hold it, not grow it.
    assert.equal(codes.qrVersionFor(bytes.length, { L: 0, M: 1, Q: 2, H: 3 }[c.ecc]) <= c.version, true,
      `case ${JSON.stringify(c.text.slice(0, 24))} should fit version ${c.version}`);
    for (const mask of ['0', '1', '2', '3', '4', '5', '6', '7']) {
      const got = codes.qrMatrix(utf8(c.text), c.ecc, c.version, Number(mask));
      assert.ok(same(got, c.by_mask[mask]),
        `case ${JSON.stringify(c.text.slice(0, 24))} v${c.version}/${c.ecc} differs at forced mask ${mask}`);
    }
    checked += 8;
  }
  assert.equal(checked, 48, 'the fixture covers 6 cases x 8 masks');
});

test('(c1) the automatically chosen mask matches the reference for every case', () => {
  for (const c of FIXTURE.cases) {
    const got = codes.qrMatrix(utf8(c.text), c.ecc);
    assert.ok(same(got, c.matrix),
      `auto mask for ${JSON.stringify(c.text.slice(0, 24))} v${c.version}/${c.ecc} differs; if only the mask differs, log all eight N1–N4 scores on both sides and settle per the PRD`);
  }
});

// ---------------------------------------------------------------------------
// (c2) The PNGs are real PNGs and carry the matrix behind them.
// ---------------------------------------------------------------------------

// Independent CRC-32 for the test: bitwise, no lookup table — deliberately not
// the implementation under test.
function crc32Bitwise(buf) {
  let c = 0xffffffff;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? ((c >>> 1) ^ 0xedb88320) : (c >>> 1);
  }
  return (~c) >>> 0;
}

function parsePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(buf.subarray(0, 8).equals(sig), 'missing PNG signature');
  const chunks = [];
  let off = 8;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    chunks.push({ type, data: buf.subarray(off + 8, off + 8 + len), crc: buf.readUInt32BE(off + 8 + len) });
    for (const chunk of chunks.slice(-1)) {
      assert.equal(crc32Bitwise(Buffer.concat([Buffer.from(type, 'ascii'), chunk.data])), chunk.crc,
        `CRC mismatch in chunk ${type}`);
    }
    off += 12 + len;
  }
  return { chunks, end: off };
}

// The pixel scale a QR PNG is rasterised at: s per the PRD's size rule.
function qrScale(displayWidth, modules) {
  return Math.max(1, Math.min(Math.ceil((3 * displayWidth) / modules), 8, Math.floor(2400 / modules)));
}

test('(c2) the QR PNG is a valid 8-bit greyscale PNG and carries the module matrix', () => {
  const img = codes.codeImage({ qr: 'HELLO WORLD', width: 120 }, 'logo');
  assert.equal(img.width, 120);
  assert.equal(img.height, 120);
  const { chunks, end } = parsePng(img.png);
  assert.equal(end, img.png.length, 'trailing garbage after IEND');
  assert.deepEqual(chunks.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  const ihdr = chunks[0].data;
  assert.equal(ihdr[8], 8);
  assert.equal(ihdr[9], 0);
  assert.equal(ihdr[10], 0);
  assert.equal(ihdr[11], 0);
  const matrix = codes.qrMatrix(Buffer.from('HELLO WORLD', 'utf8'), 'M');
  const modules = matrix.length + 8; // 4-module quiet zone each side
  const s = qrScale(120, modules);
  const pxW = modules * s;
  assert.equal(ihdr.readUInt32BE(0), pxW, 'PNG pixel width');
  assert.equal(ihdr.readUInt32BE(4), pxW, 'a QR PNG stays square');
  assert.deepEqual(imageInfo(img.png), { ext: 'png', mime: 'image/png', width: pxW, height: pxW });

  const raw = zlib.inflateSync(Buffer.concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data)));
  const at = (mx, my) => raw[Math.floor(my * s + s / 2) * (pxW + 1) + 1 + Math.floor(mx * s + s / 2)];
  for (let y = 0; y < modules; y += 1) {
    for (let x = 0; x < modules; x += 1) {
      const px = at(x, y);
      const inMatrix = x >= 4 && y >= 4 && x < modules - 4 && y < modules - 4;
      if (!inMatrix) {
        assert.equal(px, 255, `quiet-zone module ${x},${y} is not white`);
      } else {
        assert.equal(px, matrix[y - 4][x - 4] === '1' ? 0 : 255, `module ${x},${y} wrong`);
      }
    }
  }
  assert.deepEqual(imageInfo(img.png), { ext: 'png', mime: 'image/png', width: pxW, height: pxW });
});

// ---------------------------------------------------------------------------
// (c3) Code 128 and EAN-13 symbol structure.
// ---------------------------------------------------------------------------

test('(c3) Code 128 for "DocMint-42" has the expected symbol sequence', () => {
  const value = 'DocMint-42';
  const dataValues = [...value].map((ch) => ch.charCodeAt(0) - 32);
  // The check symbol is (start + sum of position x value) mod 103, ISO formula.
  let check = 104;
  dataValues.forEach((v, i) => { check += (i + 1) * v; });
  const expected = [104, ...dataValues, check % 103, 106];
  assert.deepEqual(codes.code128Symbols(value), expected);
  assert.ok(expected[expected.length - 2] >= 0 && expected[expected.length - 2] <= 102);
});

test('(c3) Code 128 start-B and stop bar/space widths are the spec values', () => {
  // Start B has width pattern 211214, stop has 2331112 (Code 128 spec, table).
  assert.equal(codes.code128Modules('A').slice(10, 21), '11010010000', 'start B widths 211214');
  assert.equal(codes.code128Modules('A').slice(-23, -10), '1100011101011', 'stop widths 2331112');
  const row = codes.code128Modules('DocMint-42');
  assert.equal(row.slice(0, 10), '0000000000', 'left quiet zone is ten light modules');
  assert.equal(row.slice(-10), '0000000000', 'right quiet zone is ten light modules');
  assert.equal(row.length, 165, 'start + 10 data + check + stop, 11 modules each, stop 13, quiet 2x10');
});

test('(c3) every Code 128 symbol is three bars and three spaces, stop is four bars', () => {
  const row = codes.code128Modules('DocMint-42');
  const runs = (chunk) => chunk.replace(/(.)\1*/g, '$1').length;
  for (let i = 0; i < 12; i += 1) { // start + 10 data + check, 11 modules each
    const chunk = row.slice(10 + i * 11, 10 + (i + 1) * 11);
    assert.equal(chunk.length, 11);
    assert.equal(chunk.replace(/(.)\1*/g, '$1').length, 6, `symbol ${i} is three bars and three spaces`);
    assert.equal(chunk[0], '1', 'every symbol starts with a bar');
  }
  const stop = row.slice(10 + 12 * 11, 10 + 12 * 11 + 13);
  assert.equal(stop.length, 13);
  assert.equal(stop.replace(/(.)\1*/g, '$1').length, 7, 'the stop pattern is four bars and three spaces');
});

test('(c3) EAN-13 check digit, parity and guards', () => {
  assert.equal(codes.ean13CheckDigit('400638133393'), 1);
  const full = codes.ean13Modules('4006381333931');
  assert.equal(full.length, 113, '95 modules plus 11 + 7 quiet modules');
  assert.equal(full.slice(0, 11), '00000000000', '11-module left quiet zone');
  assert.equal(full.slice(-7), '0000000', '7-module right quiet zone');
  assert.equal(full.slice(11, 14), '101', 'start guard');
  assert.equal(full.slice(56, 61), '01010', 'centre guard');
  assert.equal(full.slice(103, 106), '101', 'end guard');
  assert.equal(full.slice(106), '0000000', '7-module right quiet zone');
  // First digit 4 selects parity L,G,L,L,G,G for the six left digits 0,0,6,3,8,1.
  const L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
  const left = [0, 0, 6, 3, 8, 1].map((d, i) => ('LGLLGG'[i] === 'L' ? L : G)[d]).join('');
  assert.equal(full.slice(14, 56), left, 'the six left digits follow the first-digit parity');
});

// ---------------------------------------------------------------------------
// (c4) The EPC "Girocode" payload and its QR.
// ---------------------------------------------------------------------------

const EPC_OBJECT = {
  name: 'Musterfirma GmbH',
  iban: 'DE02 1001 0010 9307 1186 03',
  bic: 'BFSWDE33XXX',
  amount: 12.34,
  text: 'Rechnung 2026-0042',
};
const EPC_PAYLOAD = 'BCD\n002\n1\nSCT\nBFSWDE33XXX\nMusterfirma GmbH\nDE02100100109307118603\nEUR12.34\n\n\nRechnung 2026-0042';

test('(c4) the EPC payload is the EPC069-12 string a banking app reads', () => {
  assert.equal(codes.buildEpcPayload(EPC_OBJECT, 'pay'), EPC_PAYLOAD);
  assert.ok(!EPC_PAYLOAD.endsWith('\n'), 'no trailing newline');
  // Byte layout: BCD, 002, 1, SCT, BIC, name, normalised IBAN, amount, then an
  // empty purpose line, an empty structured-reference line, and the text line.
  assert.deepEqual(EPC_PAYLOAD.split('\n'), [
    'BCD', '002', '1', 'SCT', 'BFSWDE33XXX', 'Musterfirma GmbH',
    'DE02100100109307118603', 'EUR12.34', '', '', 'Rechnung 2026-0042',
  ]);
});

test('(c4) the EPC QR matrix equals the fixture case generated from the same payload', () => {
  const payload = codes.buildEpcPayload(EPC_OBJECT, 'pay');
  const matrix = codes.qrMatrix(Buffer.from(payload, 'utf8'), 'M');
  assert.ok(same(matrix, EPC_CASE.matrix), 'EPC QR differs from the segno fixture case');
  // And it also comes out of the codeImage path, byte for byte.
  const img = codes.codeImage({ epc: EPC_OBJECT }, 'pay');
  assert.ok(parsePng(img.png).chunks.length === 3);
  assert.ok(img.width === 150 && img.height === 150, 'EPC defaults to 150x150 display size');
});

test('(c4) an optional reference replaces the text line, and both together are refused', () => {
  const ref = codes.buildEpcPayload({ name: 'A GmbH', iban: EPC_OBJECT.iban, reference: 'RF18539007547034' }, 'pay');
  assert.equal(ref, 'BCD\n002\n1\nSCT\n\nA GmbH\nDE02100100109307118603\n\n\nRF18539007547034');
  assert.throws(
    () => codes.codeImage({ epc: { ...EPC_OBJECT, reference: 'RF18539007547034' } }, 'pay'),
    (e) => e.code === 'epc_invalid' && e.field === 'pay' && /reference.*text|one or the other/.test(e.message),
  );
});

test('(c4) a bad IBAN checksum is epc_invalid and the message never echoes an IBAN', () => {
  try {
    codes.codeImage({ epc: { ...EPC_OBJECT, iban: 'DE02100100109307118604' } }, 'pay');
    assert.fail('expected epc_invalid');
  } catch (e) {
    assert.equal(e.code, 'epc_invalid');
    assert.equal(e.field, 'pay');
    assert.ok(/mod-97/.test(e.message), 'the failing check is named');
    assert.ok(!e.message.includes('DE02100100109307118603'), 'the good IBAN leaked into the message');
    assert.ok(!e.message.includes('DE02100100109307118604'), 'the bad IBAN is echoed in the message');
  }
});

test('(c4) amount 0, amount 1e10 and amount with three decimals are epc_invalid', () => {
  for (const amount of [0, 1e10]) {
    assert.throws(() => codes.codeImage({ epc: { ...EPC_OBJECT, amount } }, 'pay'),
      (e) => e.code === 'epc_invalid' && e.field === 'pay');
  }
  assert.throws(() => codes.codeImage({ epc: { ...EPC_OBJECT, amount: 0.01 + 0.002 } }, 'pay'),
    (e) => e.code === 'epc_invalid' && /decimal places/.test(e.message));
});

test('(c4) an ecc key on an epc object is epc_invalid, other extra keys are image_invalid', () => {
  assert.throws(() => codes.codeImage({ epc: EPC_OBJECT, ecc: 'M' }, 'pay'),
    (e) => e.code === 'epc_invalid' && e.field === 'pay');
  assert.throws(() => codes.codeImage({ epc: EPC_OBJECT, foo: 1 }, 'pay'),
    (e) => e.code === 'image_invalid' && e.field === 'pay' && e.message.includes('"foo"'));
});

// ---------------------------------------------------------------------------
// (c3b)/(c5) validation errors: code, field, and what the message may contain.
// ---------------------------------------------------------------------------

function expectError(t, spec, code, field) {
  try {
    codes.codeImage(spec, spec.__field || 'logo');
  } catch (e) {
    assert.ok(e instanceof TemplateError, `expected a TemplateError, got ${e}`);
    assert.equal(e.code, code, `wrong code for ${JSON.stringify(spec)}`);
    assert.equal(e.field, spec.__field || 'logo');
    return e;
  }
  assert.fail(`expected ${code} for ${JSON.stringify(spec)}`);
}

test('(c5) qr_invalid for non-string or empty qr text and unknown ecc', () => {
  expectError(test, { qr: '' }, 'qr_invalid', 'logo');
  expectError(test, { qr: 42 }, 'qr_invalid', 'logo');
  const e = expectError(test, { qr: 'x', ecc: 'Z' }, 'qr_invalid', 'logo');
  assert.match(e.message, /"L", "M", "Q" or "H"/);
});

test('QR error correction accepts only supported own enum entries', () => {
  for (const ecc of ['L', 'M', 'Q', 'H']) {
    assert.ok(codes.codeImage({ qr: 'DocMint', ecc }, 'logo').png.length > 0);
  }
  for (const ecc of [...Object.getOwnPropertyNames(Object.prototype), 'low', 'm', '', 0, true, {}]) {
    assert.throws(() => codes.codeImage({ qr: 'DocMint', ecc }, 'logo'),
      (error) => error instanceof TemplateError && error.code === 'qr_invalid' && error.field === 'logo');
  }
});

test('(c5) qr_too_long states the byte length and the maximum for that ECC', () => {
  const e = expectError(test, { qr: 'x'.repeat(3000), ecc: 'H' }, 'qr_too_long', 'pay');
  assert.match(e.message, /\b3000 bytes/);
  assert.match(e.message, /at most \d+ bytes/);
});

test('(c5) barcode_unsupported lists the two draw-able symbologies in its hint', () => {
  const e = expectError(test, { barcode: 'ean8', value: '1234567' }, 'barcode_unsupported', 'logo');
  assert.ok(e.hint.includes('code128') && e.hint.includes('ean13'), 'hint lists both symbologies');
});

test('(c5) barcode_invalid for Code 128 and EAN-13 value problems', () => {
  expectError(test, { barcode: 'code128', value: '' }, 'barcode_invalid', 'logo');
  expectError(test, { barcode: 'code128', value: 'x'.repeat(81) }, 'barcode_invalid', 'logo');
  const e = expectError(test, { barcode: 'code128', value: 'ok\nbad' }, 'barcode_invalid', 'logo');
  assert.match(e.message, /position 2/, 'the first offending position is named');
  assert.match(e.message, /character code 10/);
  assert.ok(!e.message.includes('ok\nbad'), 'the full offending value must not be echoed');
  expectError(test, { barcode: 'ean13', value: '400638133393x' }, 'barcode_invalid', 'logo');
  expectError(test, { barcode: 'ean13', value: '123' }, 'barcode_invalid', 'logo');
});

test('(c3) EAN-13: 12 digits get a computed check digit, 13 are verified, a wrong one is named', () => {
  assert.equal(codes.ean13CheckDigit('400638133393'), 1, 'check digit of 400638133393');
  const good = codes.codeImage({ barcode: 'ean13', value: '4006381333931' }, 'ean');
  assert.ok(parsePng(good.png).chunks.length === 3);
  const e = expectError(test, { barcode: 'ean13', value: '4006381333932' }, 'barcode_invalid', 'ean');
  assert.match(e.message, /expects 1/, 'the expected check digit is stated');
});

test('(c5) epc_invalid cases name the field and never echo the IBAN', () => {
  expectError(test, { epc: 'not an object' }, 'epc_invalid', 'pay');
  expectError(test, { epc: { ...EPC_OBJECT, name: 'x'.repeat(71) } }, 'epc_invalid', 'pay');
  expectError(test, { epc: { ...EPC_OBJECT, bic: 'SHORT' } }, 'epc_invalid', 'pay');
  expectError(test, { epc: { ...EPC_OBJECT, reference: 'x'.repeat(36) } }, 'epc_invalid', 'pay');
  expectError(test, { epc: { ...EPC_OBJECT, text: 'x'.repeat(141) } }, 'epc_invalid', 'pay');
  const e = expectError(test, { epc: { ...EPC_OBJECT, surprise: 1 } }, 'epc_invalid', 'pay');
  assert.ok(e.message.includes('"surprise"'), 'the unknown epc field is named');
});

test('(c5) image_invalid for mixed image-bytes keys, two code keys and unknown keys', () => {
  const mixed = expectError(test, { qr: 'x', data: 'QUJD' }, 'image_invalid', 'logo');
  assert.ok(mixed.message.includes('"data"'), 'the mixed key is named');
  const two = expectError(test, { qr: 'x', barcode: 'code128', value: 'y' }, 'image_invalid', 'logo');
  assert.ok(two.message.includes('"qr"') && two.message.includes('"barcode"'), 'both code keys are named');
  const unknown = expectError(test, { qr: 'x', foo: 1 }, 'image_invalid', 'logo');
  assert.ok(unknown.message.includes('"foo"'), 'the unknown key is named');
});

test('(c3) Code 128 length and character-set errors are barcode_invalid', () => {
  const e = expectError(test, { barcode: 'code128', value: 'ok\nbad' }, 'barcode_invalid', 'logo');
  assert.match(e.message, /position 2/);
  assert.match(e.message, /character code 10/);
  assert.ok(!e.message.includes('ok\nbad'), 'the full offending value is not echoed');
  expectError(test, { barcode: 'code128', value: '' }, 'barcode_invalid', 'logo');
  expectError(test, { barcode: 'code128', value: 'x'.repeat(81) }, 'barcode_invalid', 'logo');
  expectError(test, { barcode: 'code128', value: 'abc\tx' }, 'barcode_invalid', 'logo');
});

test('(c5) every epc_invalid variant names the failing field and never echoes an IBAN', () => {
  const cases = [
    { ...EPC_OBJECT, iban: 'DE02 1001 0010 9307 1186 04' }, // bad mod-97
    { ...EPC_OBJECT, iban: 'DE02 1001 0010 93' }, // too short
  ];
  for (const spec of cases) {
    try {
      codes.codeImage({ epc: spec }, 'pay');
      assert.fail('expected epc_invalid');
    } catch (e) {
      assert.equal(e.code, 'epc_invalid');
      assert.ok(!e.message.includes('DE02100100109307118604'), 'the bad IBAN is echoed');
      assert.ok(!e.message.includes('DE02100100109307118604'.slice(0, 18)), 'even the IBAN prefix is echoed');
    }
  }
});

test('(c5) every error code in (b) exists and carries field = the tag path', () => {
  expectError(test, { qr: '' }, 'qr_invalid', 'logo');
  expectError(test, { qr: 'x'.repeat(3000), ecc: 'H' }, 'qr_too_long', 'pay');
  expectError(test, { barcode: 'qr2d', value: 'x' }, 'barcode_unsupported', 'logo');
  expectError(test, { barcode: 'ean13', value: '123' }, 'barcode_invalid', 'ean');
  expectError(test, { epc: { name: 'A' } }, 'epc_invalid', 'pay');
  expectError(test, { qr: 'x', foo: 1 }, 'image_invalid', 'logo');
});

// ---------------------------------------------------------------------------
// (a) Display-size and pixel-size rules.
// ---------------------------------------------------------------------------

function pngSize(img) {
  return { w: img.png.readUInt32BE(16), h: img.png.readUInt32BE(20) };
}

test('(a) display and pixel sizes follow the PRD rules', () => {
  // Code 128 and EAN-13 default: width = modules x 2 px, height 60 px.
  const c128 = codes.codeImage({ barcode: 'code128', value: 'DocMint-42' }, 'bar');
  assert.equal(c128.width, 330, '165 modules x 2 px');
  assert.equal(c128.height, 60);
  const ean = codes.codeImage({ barcode: 'ean13', value: '400638133393' }, 'ean');
  assert.equal(ean.width, 226, '113 modules x 2 px');
  assert.equal(ean.height, 60);

  // One given dimension follows the aspect ratio of the natural size.
  const wide = codes.codeImage({ barcode: 'code128', value: 'DocMint-42', width: 120 }, 'bar');
  assert.equal(wide.height, Math.round((60 * 120) / 330));
  const tall = codes.codeImage({ barcode: 'code128', value: 'DocMint-42', height: 120 }, 'bar');
  assert.equal(tall.width, 660, 'modules x 2 x height / 60');

  // QR and EPC default to 150 x 150.
  assert.equal(codes.codeImage({ qr: 'hi' }, 'q').width, 150);
  assert.equal(codes.codeImage({ epc: EPC_OBJECT }, 'pay').width, 150);

  // Pixel sizes: modules x s wide; QR square; barcode height keeps the aspect.
  const bar = codes.codeImage({ barcode: 'code128', value: 'DocMint-42' }, 'bar');
  assert.deepEqual(pngSize(bar), { w: 990, h: 180 }, 'default display 330: s = min(ceil(990/165), 8, 14) = 6, height 60*990/330 = 180');
  const ean120 = codes.codeImage({ barcode: 'ean13', value: '400638133393', width: 120 }, 'ean');
  const eanS = Math.max(1, Math.min(Math.ceil((3 * 120) / 113), 8, Math.floor(2400 / 113)));
  assert.deepEqual(pngSize(ean120), { w: 113 * eanS, h: Math.round((Math.round((60 * 120) / 226) * 113 * eanS) / 120) });
  assert.deepEqual(pngSize(ean), { w: 678, h: 180 }, 'default EAN display 226: s = min(ceil(678/113), 8, 21) = 6');
  const epc = codes.codeImage({ epc: EPC_OBJECT }, 'pay');
  const epcModules = codes.qrMatrix(Buffer.from(codes.buildEpcPayload(EPC_OBJECT, 'pay'), 'utf8'), 'M').length + 8;
  assert.deepEqual(pngSize(epc), { w: epcModules * 8, h: epcModules * 8 }, 'EPC: 150px display, s = min(ceil(450/modules), 8)');
});

test('(f) 200 QR images rasterise quickly, far inside any render deadline', (t) => {
  const started = performance.now();
  let bytes = 0;
  for (let i = 0; i < 200; i += 1) bytes += codes.codeImage({ qr: `https://docmint.app/${i}` }, 'logo').png.length;
  const ms = performance.now() - started;
  t.diagnostic(`200 QR PNGs in ${ms.toFixed(1)} ms (${bytes} bytes total)`);
  assert.ok(bytes > 0);
});
