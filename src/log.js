'use strict';

const crypto = require('node:crypto');

/**
 * Structured logging.
 *
 * One JSON object per line, because the thing that reads these is a program, not
 * a person scrolling a terminal. Every line carries `t` (ISO time), `lvl`, `evt`
 * and — for anything inside a request — `req`, so a whole request can be pulled
 * out of a day's logs with one grep.
 *
 * The rule that makes this useful rather than decorative: a render logs its
 * per-stage timings even when it succeeds. Knowing that the fill took 12 ms and
 * the PDF conversion took 1,340 ms is what tells you where the money goes; a log
 * that only speaks up on failure cannot answer that.
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[process.env.LOG_LEVEL] || LEVELS.info;

/** Anything whose name looks like a secret is redacted before it is written. */
const SECRET_KEY = /(?:key|token|secret|password|authorization|cookie|signature)/i;

function redact(value, depth = 0) {
  if (depth > 6) return '[deep]';
  if (value === null || value === undefined) return value;
  if (Buffer.isBuffer(value)) return `[${value.length} bytes]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value instanceof Error) return { message: value.message, code: value.code, stack: value.stack };
  if (typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 2000) return `${value.slice(0, 2000)}…(${value.length})`;
  return value;
}

function emit(lvl, evt, fields) {
  if (LEVELS[lvl] < threshold) return;
  const line = { t: new Date().toISOString(), lvl, evt, ...redact(fields || {}) };
  const out = JSON.stringify(line);
  if (lvl === 'error') process.stderr.write(`${out}\n`);
  else process.stdout.write(`${out}\n`);
}

const base = {
  debug: (evt, f) => emit('debug', evt, f),
  info: (evt, f) => emit('info', evt, f),
  warn: (evt, f) => emit('warn', evt, f),
  error: (evt, f) => emit('error', evt, f),
};

/** A logger bound to a request, so `req` never has to be passed by hand. */
function child(fields) {
  return {
    debug: (evt, f) => emit('debug', evt, { ...fields, ...f }),
    info: (evt, f) => emit('info', evt, { ...fields, ...f }),
    warn: (evt, f) => emit('warn', evt, { ...fields, ...f }),
    error: (evt, f) => emit('error', evt, { ...fields, ...f }),
    child: (more) => child({ ...fields, ...more }),
  };
}

const newRequestId = () => `dm_${crypto.randomBytes(9).toString('base64url')}`;

/**
 * Accumulates per-stage durations for one operation.
 *
 *   const t = timer();
 *   t.mark('parse'); ... t.mark('fill'); ... t.mark('pdf');
 *   log.info('render.ok', { ms: t.total(), stages: t.stages() })
 *
 * `mark` records the time since the previous mark, not since the start, because
 * "the PDF step took 1.3 s" is the sentence you actually want to read.
 */
function timer() {
  const start = process.hrtime.bigint();
  let last = start;
  const stages = {};
  return {
    mark(name) {
      const now = process.hrtime.bigint();
      stages[name] = Number(now - last) / 1e6;
      last = now;
      return stages[name];
    },
    stages() {
      const out = {};
      for (const [k, v] of Object.entries(stages)) out[k] = Math.round(v * 10) / 10;
      return out;
    },
    total() {
      return Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10;
    },
  };
}

module.exports = { ...base, child, newRequestId, timer, redact };
