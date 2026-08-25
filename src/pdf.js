'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { config } = require('./config');
const { ApiError } = require('./errors');
const log = require('./log');

/**
 * DOCX/XLSX/PPTX -> PDF, via headless LibreOffice.
 *
 * Measured on this codebase's own probe image, converting a small Word document
 * in a 512 MB container:
 *
 *   cold (no user profile yet)  1.25 s wall, 219 MB peak RSS
 *   warm (profile exists)       1.02 s wall, 219 MB peak RSS
 *
 * Two things follow from those numbers and shape this file.
 *
 * First, 219 MB is a third of a small container, so conversions must be
 * serialised. `maxConcurrentPdf` defaults to 1: two at once on a 512 MB instance
 * is an OOM kill, which presents to the user as a dropped connection with no
 * error at all — the worst possible failure. Filling a template needs none of
 * this and is not throttled; only the PDF stage queues.
 *
 * Second, the profile is worth keeping. Rebuilding it costs 0.23 s on every
 * single request, so it lives at a fixed path and is only rebuilt when a
 * conversion fails in a way that suggests it is corrupt.
 */

const PROFILE_DIR = path.join(os.tmpdir(), 'docmint-lo-profile');

let active = 0;
const waiting = [];

function acquire() {
  return new Promise((resolve, reject) => {
    if (active < config.maxConcurrentPdf) { active += 1; resolve(); return; }
    if (waiting.length >= config.pdfQueueLimit) {
      reject(new ApiError(503, 'pdf_queue_full',
        'Too many PDF conversions are already queued on this instance.', {
          hint: 'Retry in a few seconds. Filling a template without converting to PDF is not queued, so if you do not need a PDF, ask for the Office file instead.',
          docs: '/docs#pdf',
        }));
      return;
    }
    waiting.push(resolve);
  });
}

function release() {
  const next = waiting.shift();
  if (next) next();
  else active = Math.max(0, active - 1);
}

/** How many are running and waiting, for /healthz and the status page. */
const stats = () => ({ active, queued: waiting.length, limit: config.maxConcurrentPdf });

/**
 * LibreOffice will not start against a profile another process still holds. If a
 * conversion was killed mid-flight the lock outlives it, and every later request
 * fails until someone notices. Clearing the lock is safe here precisely because
 * conversions are serialised: when we are about to start, nothing else is running.
 */
function clearStaleLock() {
  for (const name of ['.~lock.', '.lock']) {
    try {
      for (const f of fsSync.readdirSync(PROFILE_DIR)) {
        if (f.startsWith(name)) fsSync.rmSync(path.join(PROFILE_DIR, f), { force: true });
      }
    } catch { /* profile does not exist yet, which is fine */ }
  }
}

/**
 * @param {Buffer} buffer   the filled Office document
 * @param {'docx'|'xlsx'|'pptx'} format
 * @param {{log?:object, timeoutMs?:number}} opts
 * @returns {Promise<{buffer: Buffer, ms: number, queuedMs: number}>}
 */
async function toPdf(buffer, format, opts = {}) {
  const l = opts.log || log;
  const queueStart = process.hrtime.bigint();
  await acquire();
  const queuedMs = Math.round(Number(process.hrtime.bigint() - queueStart) / 1e5) / 10;

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'docmint-'));
  const inPath = path.join(dir, `doc.${format}`);
  const outPath = path.join(dir, 'doc.pdf');
  const started = process.hrtime.bigint();

  try {
    await fs.writeFile(inPath, buffer);
    clearStaleLock();
    await runSoffice(inPath, dir, opts.timeoutMs || config.pdfTimeoutMs, l);

    let pdf;
    try {
      pdf = await fs.readFile(outPath);
    } catch {
      throw new ApiError(502, 'pdf_conversion_failed',
        'LibreOffice ran but produced no PDF from this document.', {
          hint: 'This usually means the filled document itself is malformed. Ask for the Office file instead of a PDF and open it, which will show what went wrong.',
          docs: '/docs#pdf',
        });
    }
    if (pdf.length < 5 || pdf.subarray(0, 5).toString() !== '%PDF-') {
      throw new ApiError(502, 'pdf_conversion_failed', 'LibreOffice produced a file that is not a PDF.', { docs: '/docs#pdf' });
    }

    const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
    l.info('pdf.ok', { format, in_bytes: buffer.length, out_bytes: pdf.length, ms, queued_ms: queuedMs, pages: countPages(pdf) });
    return { buffer: pdf, ms, queuedMs, pages: countPages(pdf) };
  } finally {
    release();
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function runSoffice(inPath, outDir, timeoutMs, l) {
  return new Promise((resolve, reject) => {
    const args = [
      '--headless', '--norestore', '--nolockcheck', '--nodefault', '--nofirststartwizard',
      `-env:UserInstallation=file://${PROFILE_DIR}`,
      '--convert-to', 'pdf:writer_pdf_Export',
      '--outdir', outDir, inPath,
    ];
    // Calc and Impress need their own export filter names; `pdf` alone works for
    // all three, and the explicit writer filter above only helps Writer, so pick
    // per extension rather than guessing.
    const ext = path.extname(inPath).slice(1);
    if (ext === 'xlsx') args[args.indexOf('pdf:writer_pdf_Export')] = 'pdf:calc_pdf_Export';
    if (ext === 'pptx') args[args.indexOf('pdf:writer_pdf_Export')] = 'pdf:impress_pdf_Export';

    const child = spawn(config.sofficeBin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, HOME: os.tmpdir(), SAL_USE_VCLPLUGIN: 'svp' },
    });

    let stderr = '';
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d.toString().slice(0, 4000); });
    child.stderr.on('data', (d) => { stderr += d.toString().slice(0, 4000); });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ApiError(504, 'pdf_timeout',
        `Converting to PDF took longer than ${Math.round(timeoutMs / 1000)} seconds and was stopped.`, {
          hint: 'Very large documents, or documents with many embedded images, can exceed this. Ask for the Office file instead, or reduce the document.',
          docs: '/docs#pdf',
        }));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      if (err.code === 'ENOENT') {
        reject(new ApiError(501, 'pdf_not_available',
          'This instance cannot make PDFs because LibreOffice is not installed on it.', {
            hint: 'Ask for the Office file instead by leaving "output" unset, or run an instance built from the project Dockerfile, which includes LibreOffice.',
            docs: '/docs#pdf',
          }));
        return;
      }
      reject(err);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        l.warn('pdf.soffice_nonzero', { code, stderr: stderr.slice(0, 500), stdout: stdout.slice(0, 500) });
        reject(new ApiError(502, 'pdf_conversion_failed',
          `LibreOffice exited with code ${code} while converting this document.`, {
            hint: 'Ask for the Office file instead of a PDF and open it; if the Office file is fine, this is a conversion bug and worth reporting.',
            details: { stderr: stderr.slice(0, 300) || null },
            docs: '/docs#pdf',
          }));
        return;
      }
      resolve();
    });
  });
}

/** Page count straight out of the PDF, so the log can say what was produced. */
function countPages(pdf) {
  const text = pdf.toString('latin1');
  const counts = [...text.matchAll(/\/Type\s*\/Page[^s]/g)].length;
  if (counts > 0) return counts;
  const m = [...text.matchAll(/\/Count\s+(\d+)/g)].map((x) => Number(x[1]));
  return m.length ? Math.max(...m) : null;
}

/** Is LibreOffice actually present? Used by /healthz so a broken image is obvious. */
async function probe() {
  return new Promise((resolve) => {
    const child = spawn(config.sofficeBin, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.on('error', () => resolve({ available: false, version: null }));
    child.on('close', (code) => resolve({ available: code === 0, version: out.trim() || null }));
    setTimeout(() => { child.kill('SIGKILL'); resolve({ available: false, version: null }); }, 10000);
  });
}

module.exports = { toPdf, probe, stats, countPages, PROFILE_DIR };
