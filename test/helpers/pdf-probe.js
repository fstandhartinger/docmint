'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Shared PDF-inspection helpers for the pdf_password HTTP suites.
 *
 * The qpdf and pypdf assertions prove the strong property — the file demands a
 * password, opens with exactly the one that was set, and no other — and they
 * degrade cleanly: without qpdf or pypdf on the machine, or when the server
 * runs the committed fake soffice (DOCMINT_FAKE_CTRL set, see
 * fake-soffice.sh, whose PDFs are trailers rather than real crypto), the deep
 * assertions skip with a diagnostic and the tool-free /Encrypt trailer check
 * in the suites still stands.
 */

const isPdf = (buf) => buf.length > 5 && buf.subarray(0, 5).equals(Buffer.from('%PDF-'));

const hasEncrypt = (buf) => buf.includes(Buffer.from('/Encrypt'));

function qpdfAvailable() {
  try {
    return spawnSync('qpdf', ['--version']).status === 0;
  } catch { return false; }
}

function pypdfAvailable() {
  try {
    return spawnSync('python3', ['-c', 'import pypdf']).status === 0;
  } catch { return false; }
}

/** qpdf on a file: 0 = a password is required, 2 = it opens without one. */
function qpdfRequiresPassword(file) {
  return spawnSync('qpdf', ['--requires-password', file]).status;
}

/**
 * Text of a password-protected PDF extracted with python3-pypdf (a real PDF
 * library, not a byte grep): null when it could not open the file with this
 * password, the flattened text otherwise. The password goes as an argv
 * element, so like the soffice spawn itself nothing in it reaches a shell.
 */
function pypdfText(file, password) {
  const r = spawnSync('python3', ['-c', `
import sys
from pypdf import PdfReader
r = PdfReader(sys.argv[1])
if r.is_encrypted:
    if not r.decrypt(sys.argv[2]):
        sys.exit(3)
sys.stdout.write(" ".join((p.extract_text() or "") for p in r.pages))
`, file, password], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (r.status !== 0) return null;
  return r.stdout.replace(/\s+/g, ' ').trim();
}

const fakeServer = () => Boolean(process.env.DOCMINT_FAKE_CTRL);

/**
 * The "opens only with the password" half: qpdf proves the file demands a
 * password, opens with exactly this one (and not with a wrong one), and that
 * the decrypted roundtrip needs no password any more.
 */
function assertQpdfProtected(t, pdfBuf, password) {
  if (fakeServer()) { t.diagnostic('server runs the fake soffice; the real-encryption assertions need a real LibreOffice run'); return; }
  if (!qpdfAvailable()) { t.diagnostic('qpdf not on this machine; skipping qpdf assertions'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docmint-pw-'));
  try {
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, pdfBuf);
    assert.equal(qpdfRequiresPassword(file), 0, 'qpdf says the protected file needs no password');
    const dec = path.join(dir, 'decrypted.pdf');
    const r = spawnSync('qpdf', [`--password=${password}`, '--decrypt', file, dec]);
    assert.equal(r.status, 0, `qpdf --password=… --decrypt failed: ${r.stderr?.toString()}`);
    assert.ok(fs.existsSync(dec), 'qpdf produced no decrypted file');
    assert.equal(qpdfRequiresPassword(dec), 2, 'the decrypted file still requires a password');
    const wrong = spawnSync('qpdf', ['--password=not-the-password', '--decrypt', file, path.join(dir, 'nope.pdf')]);
    assert.notEqual(wrong.status, 0, 'the file opened with a password that was never set');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The "extracted text contains a filled value" half: pypdf opens the file
 * with the password and the text layer carries the value the template was
 * filled with. Skips cleanly when python3-pypdf is not installed.
 */
function assertPdfTextContains(t, pdfBuf, password, needle) {
  if (fakeServer()) { t.diagnostic('server runs the fake soffice; the text-layer assertion needs a real LibreOffice run'); return; }
  if (!pypdfAvailable()) { t.diagnostic('python3-pypdf not on this machine; skipping the text-content assertion'); return; }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'docmint-pw-'));
  try {
    const file = path.join(dir, 'doc.pdf');
    fs.writeFileSync(file, pdfBuf);
    const text = pypdfText(file, password);
    assert.notEqual(text, null, 'pypdf could not open the encrypted PDF with the password');
    assert.ok(
      text.includes(needle),
      `the decrypted PDF text does not contain the filled value ${JSON.stringify(needle)}: ${text.slice(0, 300)}…`,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = {
  isPdf, hasEncrypt, qpdfAvailable, pypdfAvailable, qpdfRequiresPassword,
  pypdfText, assertQpdfProtected, assertPdfTextContains, fakeServer,
};
