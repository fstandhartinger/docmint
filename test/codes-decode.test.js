'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { req, account, serverUp, BASE } = require('./helpers');
const H = require('./helpers/docx-fixtures');
const codes = require('../src/render/codes');

/**
 * AT-T2: the four codes are scanned back OUT of the rendered PDF — not the
 * DOCX media parts (codes-http.test.js proves those), the final PDF images.
 * One template, one /v1/render to PDF, one code per page so the decoder reads
 * each raster cleanly, rasterised with pdftoppm and decoded with zxing-cpp
 * from system Python. The decoder is test-only tooling; it is never a product
 * dependency. Like codes-http.test.js this skips, loudly, when there is no
 * server, no rasteriser or no decoder — never a silent pass.
 */

const QR_URL = 'https://qa.docmint.test/r0/four-code';
const CODE128_VALUE = 'INV-2026-0042';
const EAN13_BASE = '400638133393'; // 12 digits; the check digit is computed below

// EAN-13 check digit (weights 1/3) — the same convention as the module's
// (duplicated, not independent): the module must agree with it or the render
// request fails with 422, which is the actual assertion path here.
function ean13Check(twelve) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}
const EAN13 = EAN13_BASE + ean13Check(EAN13_BASE);

const EPC = {
  name: 'DocMint QA GmbH',
  iban: 'DE02100100109307118603',
  bic: 'BFSWDE33XXX',
  amount: 42.5,
  reference: 'QA-R0-0042',
};

// {%logo} sits inside one w:t; the replacement closes that run and adds three
// page-break paragraphs so each code lands on its own page.
const FOUR_TAGS = '{%cA}</w:t></w:r></w:p>'
  + '<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>{%cB}</w:t></w:r></w:p>'
  + '<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>{%cC}</w:t></w:r></w:p>'
  + '<w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>{%cD}';

function fourCodesTemplate() {
  return H.patchPart(H.fixture('invoice'), 'word/document.xml', (xml) => xml.replace('{%logo}', FOUR_TAGS));
}

function fourCodesData() {
  return H.invoiceData({
    logo: null,
    cA: { qr: QR_URL, width: 240 },
    cB: { epc: { ...EPC }, width: 240 },
    cC: { barcode: 'code128', value: CODE128_VALUE, width: 420 },
    cD: { barcode: 'ean13', value: EAN13, width: 400 },
  });
}

const decoderAvailable = () => {
  try {
    execFileSync('python3', ['-c', 'import zxingcpp, PIL.Image'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

const rasterizerAvailable = () => {
  try {
    execFileSync('pdftoppm', ['-v'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};

/** Decodes every PNG at paths and returns [{ text, type }] per file, as JSON. */
function decodePngs(paths) {
  const script = [
    'import sys, json, zxingcpp',
    'from PIL import Image',
    'out = []',
    'for p in sys.argv[1:]:',
    '    found = zxingcpp.read_barcodes(Image.open(p))',
    '    out.append([{"text": r.text, "type": str(r.format)} for r in found])',
    'print(json.dumps(out))',
  ].join('\n');
  return JSON.parse(execFileSync('python3', ['-c', script, ...paths], { encoding: 'utf8' }));
}

test('all four codes scan back out of the rendered PDF with their exact payloads', async (t) => {
  const up = await serverUp();
  if (!up) { t.skip(`no server at ${BASE}`); return; }
  if (!rasterizerAvailable()) { t.skip('pdftoppm (poppler) is not on PATH'); return; }
  if (!decoderAvailable()) { t.skip('the zxingcpp Python module is not importable'); return; }

  const { key } = await account();
  const { res, json } = await req('/v1/render', {
    method: 'POST', key,
    headers: { Accept: 'application/json' },
    body: {
      template_base64: fourCodesTemplate().toString('base64'),
      data: fourCodesData(),
      currency: 'EUR',
      output: 'pdf',
    },
  });
  assert.equal(res.status, 200, JSON.stringify(json));
  const pdf = Buffer.from(json.pdf.base64, 'base64');
  assert.ok(pdf.subarray(0, 5).equals(Buffer.from('%PDF-')), 'no PDF came back');
  assert.ok(json.pdf.pages >= 4, `expected at least 4 pages, got ${json.pdf.pages}`);

  const epcExpected = codes.buildEpcPayload(EPC, 'cB');
  const want = [
    QR_URL,                      // page 1: plain QR
    epcExpected,                 // page 2: EPC payment QR
    CODE128_VALUE,               // page 3: Code 128
    EAN13,                       // page 4: EAN-13 incl. check digit
  ];

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codes-decode-'));
  try {
    const pdfPath = path.join(dir, 'codes.pdf');
    fs.writeFileSync(pdfPath, pdf);
    execFileSync('pdftoppm', ['-png', '-r', '150', pdfPath, path.join(dir, 'page')], { timeout: 120000 });
    const pages = fs.readdirSync(dir).filter((f) => f.endsWith('.png')).sort();
    assert.ok(pages.length >= 4, `expected at least 4 page rasters, got ${pages.length}`);

    const decoded = decodePngs(pages.map((f) => path.join(dir, f)));
    const payloads = decoded.flat().map((r) => r.text);
    assert.equal(
      payloads.length, 4,
      `expected exactly one code per page over ${pages.length} pages, decoded ${payloads.length}: ${JSON.stringify(decoded)}`,
    );
    assert.deepEqual(payloads, want, 'the four payloads must come back in page order, byte exact');

    // The PRD's explicit EPC assertions, spelled out even though equality above
    // already implies them.
    assert.ok(epcExpected.startsWith('BCD\n002\n1\nSCT\n'), 'EPC payload starts with the BCD/002/1/SCT header');
    assert.ok(epcExpected.includes(EPC.iban), 'EPC payload carries the IBAN');

    const artifactDir = process.env.CODES_DECODE_ARTIFACT_DIR;
    if (artifactDir) {
      fs.mkdirSync(artifactDir, { recursive: true });
      fs.writeFileSync(path.join(artifactDir, 'codes.pdf'), pdf);
      pages.forEach((f, i) => fs.copyFileSync(path.join(dir, f), path.join(artifactDir, `page-${i + 1}.png`)));
      fs.writeFileSync(path.join(artifactDir, 'decode-results.json'), JSON.stringify({
        rendered: { pages: json.pdf.pages, pdf_bytes: pdf.length },
        expected: want,
        decoded_per_page: decoded,
      }, null, 2));
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
