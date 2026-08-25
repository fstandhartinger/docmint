'use strict';

/**
 * A template error always names the thing the user has to change.
 *
 * The lesson this class exists for: a document that renders `{{total}}` as an
 * empty cell, or as the literal text "undefined", is worse than no document at
 * all, because nobody notices until it has been emailed to a customer. So every
 * failure to resolve carries the field name, the place it was written, and — when
 * we can work it out — the closest field that *does* exist in the data.
 */
class TemplateError extends Error {
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'TemplateError';
    this.code = code;
    this.field = opts.field || null;
    this.location = opts.location || null;   // e.g. "word/document.xml, paragraph 12"
    this.hint = opts.hint || null;
    this.available = opts.available || null; // field names that do exist, for the hint
  }

  toJSON() {
    const out = { code: this.code, message: this.message };
    if (this.field) out.field = this.field;
    if (this.location) out.location = this.location;
    if (this.hint) out.hint = this.hint;
    if (this.available) out.available = this.available;
    return out;
  }
}

/**
 * Damerau-Levenshtein, used only to say "did you mean" — never for control flow.
 * Plain Levenshtein charges two edits for a transposition, which is exactly the
 * typo people actually make: "nmae" for "name" would then score the same as an
 * unrelated word and the suggestion would never appear.
 */
function editDistance(a, b) {
  const m = a.length; const n = b.length;
  if (!m) return n;
  if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array(n + 1).fill(0);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j += 1) d[0][j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[m][n];
}

/** The closest available field name to `wanted`, or null if nothing is close. */
function didYouMean(wanted, available) {
  if (!available || !available.length) return null;
  const w = String(wanted).toLowerCase();
  let best = null; let bestD = Infinity;
  for (const cand of available) {
    const d = editDistance(w, String(cand).toLowerCase());
    if (d < bestD) { bestD = d; best = cand; }
  }
  // Two edits on a short name is a typo; two edits on a three-letter name is a
  // different word. Scale the threshold with the length of what was asked for.
  const limit = Math.max(1, Math.floor(w.length / 3));
  return bestD <= limit ? best : null;
}

module.exports = { TemplateError, didYouMean, editDistance };
