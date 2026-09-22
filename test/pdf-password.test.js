'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * AT-P4/AT-P6 (unit half) and AT-P5 (redaction): the pdf_password validator,
 * the soffice argument builder, the capabilities constants and the
 * password-redaction on the conversion failure path — all without a server.
 *
 * The failure-path tests point SOFFICE_BIN at a fake soffice (set before the
 * src modules are required, because src/config.js reads the env at load time).
 * The fake echoes its own argv to stderr and exits non-zero, which is exactly
 * the leak scenario: a failing LibreOffice can print the argv that carries
 * the password inside the filter options.
 */

const FAKE = path.join(os.tmpdir(), `docmint-fake-soffice-${process.pid}.sh`);
fs.writeFileSync(FAKE, `#!/bin/sh
echo "$@" >&2
out=""
prev=""
for a in "$@"; do
  if [ "$prev" = "--outdir" ]; then out="$a"; fi
  prev="$a"
done
mode="\${DOCMINT_FAKE_MODE:-noencrypt}"
if [ "$mode" = "fail" ]; then
  exit 3
fi
if [ -n "$out" ]; then
  if [ "$mode" = "encrypt" ]; then
    printf '%%PDF-1.7\\ntrailer\\n<< /Size 6 /Root 1 0 R /Encrypt 5 0 R >>\\nstartxref\\n0\\n%%%%EOF\\n' > "$out/doc.pdf"
  else
    printf '%%PDF-1.7\\ntrailer\\n<< /Size 6 /Root 1 0 R >>\\nstartxref\\n0\\n%%%%EOF\\n' > "$out/doc.pdf"
  fi
fi
exit 0
`, { mode: 0o755 });
process.env.SOFFICE_BIN = FAKE;

const input = require('../src/input');
const pdf = require('../src/pdf');
const { pdfPasswordCapability, PDF_PASSWORD_ENCRYPTION } = require('../src/capabilities');

const PW = 's3cret-Ä1';

const errorBlob = (e) => JSON.stringify({ message: e.message, hint: e.hint, details: e.details });

/* ------------------------------------------------------------ the validator */

test('checkPdfPassword accepts valid passwords, including non-ASCII', () => {
  assert.equal(input.checkPdfPassword(PW), PW);
  assert.equal(input.checkPdfPassword('x'), 'x');
  assert.equal(input.checkPdfPassword('x'.repeat(128)), 'x'.repeat(128));
  assert.equal(input.checkPdfPassword('pässwörd-Ü'), 'pässwörd-Ü');
});

test('checkPdfPassword refuses empty, over-long, non-string and control characters', () => {
  const cases = [
    ['', 'empty string'],
    ['x'.repeat(129), '129 characters'],
    [42, 'a number'],
    [null, 'null'],
    [{ pw: PW }, 'an object'],
    ['a\u0000b', 'NUL control character'],
    ['a\u001fb', 'unit separator control character'],
    ['a\u007fb', 'DEL control character'],
  ];
  for (const [value, what] of cases) {
    let threw = null;
    try { input.checkPdfPassword(value); } catch (e) { threw = e; }
    assert.ok(threw, `${what} was not refused`);
    assert.equal(threw.status, 400, `${what}: status`);
    assert.equal(threw.code, 'bad_pdf_password', `${what}: code`);
    assert.equal(threw.docs, '/docs#pdf-password', `${what}: docs anchor`);
    assert.ok(threw.hint, `${what}: hint`);
    // The value is never echoed: a 400 that repeats the password is a leak.
    if (typeof value === 'string' && value.length > 0) {
      assert.ok(!errorBlob(threw).includes(value), `${what}: the password leaked into the error`);
    }
  }
});

test('checkPdfPasswordForOutput refuses the field without a PDF and passes it through otherwise', () => {
  assert.equal(input.checkPdfPasswordForOutput(undefined, 'document'), null);
  assert.equal(input.checkPdfPasswordForOutput(PW, 'pdf'), PW);
  assert.equal(input.checkPdfPasswordForOutput(PW, 'both'), PW);

  let threw = null;
  try { input.checkPdfPasswordForOutput(PW, 'document'); } catch (e) { threw = e; }
  assert.ok(threw, 'pdf_password with output document was not refused');
  assert.equal(threw.status, 400);
  assert.equal(threw.code, 'pdf_password_needs_pdf');
  assert.equal(threw.docs, '/docs#pdf-password');
  assert.ok(!errorBlob(threw).includes(PW), 'the password leaked into the needs_pdf error');
});

test('pdfPasswordUnsupportedHere is a 400 with the specific code', () => {
  let threw = null;
  try { input.pdfPasswordUnsupportedHere(); } catch (e) { threw = e; }
  assert.ok(threw);
  assert.equal(threw.status, 400);
  assert.equal(threw.code, 'pdf_password_unsupported_here');
  assert.equal(threw.docs, '/docs#pdf-password');
});

/* ------------------------------------------------------- capabilities parity */

test('the published capability is built from the validator constants', () => {
  const cap = pdfPasswordCapability();
  assert.deepEqual(cap, {
    field: 'pdf_password',
    min_length: 1,
    max_length: 128,
    endpoints: ['/v1/render'],
    encryption: 'RC4-128 (PDF standard security handler revision 3, as applied by LibreOffice 7.4)',
  });
  assert.equal(cap.field, 'pdf_password');
  assert.equal(cap.min_length, input.PDF_PASSWORD_MIN_LENGTH);
  assert.equal(cap.max_length, input.PDF_PASSWORD_MAX_LENGTH);
  // The measured encryption claim is the one exported constant, pinned verbatim.
  assert.equal(cap.encryption, PDF_PASSWORD_ENCRYPTION);
  // The published limits are the enforced limits, in both directions.
  assert.equal(input.checkPdfPassword('x'.repeat(cap.min_length)), 'x'.repeat(cap.min_length));
  assert.equal(input.checkPdfPassword('x'.repeat(cap.max_length)), 'x'.repeat(cap.max_length));
  assert.throws(() => input.checkPdfPassword(''), (e) => e.code === 'bad_pdf_password');
  assert.throws(() => input.checkPdfPassword('x'.repeat(cap.max_length + 1)), (e) => e.code === 'bad_pdf_password');
});

/* -------------------------------------------------------- the argv builder */

test('exportFilter builds the plain per-format filter without a password', () => {
  assert.equal(pdf.exportFilter('docx'), 'pdf:writer_pdf_Export');
  assert.equal(pdf.exportFilter('xlsx'), 'pdf:calc_pdf_Export');
  assert.equal(pdf.exportFilter('pptx'), 'pdf:impress_pdf_Export');
});

test('exportFilter builds the JSON filter options with a password, for all three filters', () => {
  const filters = [['docx', 'writer_pdf_Export'], ['xlsx', 'calc_pdf_Export'], ['pptx', 'impress_pdf_Export']];
  for (const [format, filter] of filters) {
    const arg = pdf.exportFilter(format, PW);
    const prefix = `pdf:${filter}:`;
    assert.ok(arg.startsWith(prefix), `${format}: wrong filter in ${arg.slice(0, 30)}…`);
    const options = JSON.parse(arg.slice(prefix.length));
    assert.deepEqual(options, {
      EncryptFile: { type: 'boolean', value: 'true' },
      DocumentOpenPassword: { type: 'string', value: PW },
    });
  }
});

test('exportFilter JSON-escapes the password, so quotes and backslashes cannot break the argv', () => {
  for (const tricky of ['a"b', 'back\\slash', 'semi;colon', 'sp ace']) {
    const arg = pdf.exportFilter('docx', tricky);
    const options = JSON.parse(arg.slice('pdf:writer_pdf_Export:'.length));
    assert.equal(options.DocumentOpenPassword.value, tricky);
    assert.equal(options.DocumentOpenPassword.type, 'string');
  }
});

test('redactSecret replaces every occurrence of the secret', () => {
  assert.equal(pdf.redactSecret(`a ${PW} b ${PW}`, PW), 'a [redacted] b [redacted]');
  assert.equal(pdf.redactSecret('no secret here', PW), 'no secret here');
  assert.equal(pdf.redactSecret('', PW), '');
  assert.equal(pdf.redactSecret('x', null), 'x');
});

/* ------------------------------------------- the failure path, end to end */

/** A logger that keeps everything it is told, so a leak is assertable. */
function captureLog() {
  const lines = [];
  const keep = (lvl) => (evt, f) => lines.push({ lvl, evt, f });
  return { lines, log: { debug: keep('debug'), info: keep('info'), warn: keep('warn'), error: keep('error') } };
}

test('AT-P5 a failing soffice that echoes its argv never leaks the password into the error or the log', async () => {
  process.env.DOCMINT_FAKE_MODE = 'fail';
  const { lines, log } = captureLog();
  await assert.rejects(
    () => pdf.toPdf(Buffer.from('not a real docx'), 'docx', { password: PW, log, timeoutMs: 15000 }),
    (e) => {
      assert.equal(e.code, 'pdf_conversion_failed');
      assert.equal(e.status, 502);
      const blob = errorBlob(e);
      assert.ok(!blob.includes(PW), `the password leaked into the error: ${blob}`);
      assert.ok(blob.includes('[redacted]'), 'the redaction marker is missing from the error details');
      return true;
    },
  );
  const logged = JSON.stringify(lines);
  assert.ok(!logged.includes(PW), `the password leaked into the log: ${logged}`);
  assert.ok(logged.includes('[redacted]'), 'the redaction marker is missing from the log');
});

test('a produced PDF without /Encrypt is refused when a password was requested (fail closed)', async () => {
  process.env.DOCMINT_FAKE_MODE = 'noencrypt';
  const { log } = captureLog();
  await assert.rejects(
    () => pdf.toPdf(Buffer.from('not a real docx'), 'docx', { password: PW, log, timeoutMs: 15000 }),
    (e) => {
      assert.equal(e.code, 'pdf_encryption_failed');
      assert.equal(e.status, 502);
      assert.equal(e.docs, '/docs#pdf-password');
      assert.ok(!errorBlob(e).includes(PW), 'the password leaked into the encryption error');
      return true;
    },
  );
});

test('a produced PDF with /Encrypt is returned when a password was requested', async () => {
  process.env.DOCMINT_FAKE_MODE = 'encrypt';
  const { lines, log } = captureLog();
  const out = await pdf.toPdf(Buffer.from('not a real docx'), 'docx', { password: PW, log, timeoutMs: 15000 });
  assert.ok(out.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(out.buffer.includes(Buffer.from('/Encrypt')));
  // The success log says encryption happened, without saying with what.
  const okLine = lines.find((l) => l.evt === 'pdf.ok');
  assert.ok(okLine, 'no pdf.ok line was logged for the encrypted conversion');
  const ok = JSON.stringify(okLine);
  assert.ok(ok.includes('"encrypted":true'));
  assert.ok(!ok.includes(PW));
});

test('without a password the plain path is unchanged: no /Encrypt is required', async () => {
  process.env.DOCMINT_FAKE_MODE = 'noencrypt';
  const { log } = captureLog();
  const out = await pdf.toPdf(Buffer.from('not a real docx'), 'docx', { log, timeoutMs: 15000 });
  assert.ok(out.buffer.subarray(0, 5).equals(Buffer.from('%PDF-')));
  assert.ok(!out.buffer.includes(Buffer.from('/Encrypt')));
});
