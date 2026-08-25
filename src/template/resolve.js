'use strict';

const { TemplateError, didYouMean } = require('./errors');
const { applyFormatters } = require('./formatters');

/**
 * Scope resolution.
 *
 * A scope stack, innermost last. Inside `{#items}` the current item is the
 * innermost scope, but the root data is still visible — an invoice line needs
 * `{description}` from the line *and* `{currency}` from the invoice, and making
 * the user write `{../currency}` for the second is a papercut nobody thanks you
 * for. `../` is still supported for the case where an inner field shadows an
 * outer one deliberately.
 *
 * The contract on a missing field, which is the whole point of this file:
 *
 *   key absent from the data      -> hard error naming the field  (default)
 *   key present with value null   -> renders as empty; the caller said "nothing"
 *   {x|default:...}               -> the sanctioned opt-out
 *
 * `onMissing: "empty"` relaxes the first rule for callers who genuinely want it,
 * and is off by default because the failure it prevents is silent and expensive.
 */

const SPECIALS = new Set(['$index', '$index1', '$first', '$last', '$length', '$total']);

function splitPath(path) {
  const segs = [];
  let up = 0;
  let rest = path;
  while (rest.startsWith('../')) { up += 1; rest = rest.slice(3); }
  if (rest === '.') return { up, segs: [], self: true };
  // Split on dots that are not inside brackets, so `[Line Total]` survives and
  // `a.b[0].c` still decomposes into a, b, 0, c.
  const parts = [];
  let cur = '';
  let depth = 0;
  for (const ch of rest) {
    if (ch === '[') { depth += 1; if (depth === 1 && cur !== '') { parts.push(cur); cur = ''; } cur += ch; continue; }
    if (ch === ']') { depth -= 1; cur += ch; if (depth === 0) { parts.push(cur); cur = ''; } continue; }
    if (ch === '.' && depth === 0) { if (cur !== '') parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur !== '') parts.push(cur);
  for (const part of parts) {
    segs.push(part.startsWith('[') && part.endsWith(']') ? part.slice(1, -1) : part);
  }
  return { up, segs, self: false };
}

/** All key names visible at this point, for "did you mean" and for error detail. */
function visibleKeys(stack) {
  const keys = new Set();
  for (const frame of stack) {
    if (frame.value && typeof frame.value === 'object' && !Array.isArray(frame.value)) {
      for (const k of Object.keys(frame.value)) keys.add(k);
    }
  }
  return [...keys];
}

/**
 * @returns {{found:boolean, value:any}} — `found` distinguishes "absent" from
 * "present and null", which is the distinction the whole error contract rests on.
 */
function lookup(path, stack) {
  const { up, segs, self } = splitPath(path);

  if (self) {
    const frame = stack[stack.length - 1 - up];
    return frame ? { found: true, value: frame.value } : { found: false, value: undefined };
  }

  if (segs.length === 1 && SPECIALS.has(segs[0])) {
    for (let i = stack.length - 1 - up; i >= 0; i -= 1) {
      const meta = stack[i].meta;
      if (meta && segs[0] in meta) return { found: true, value: meta[segs[0]] };
    }
    return { found: false, value: undefined };
  }

  const start = stack.length - 1 - up;
  if (start < 0) return { found: false, value: undefined };

  // `../` is an explicit jump: look only in that frame's chain, not below it.
  const from = up > 0 ? start : stack.length - 1;
  for (let i = from; i >= 0; i -= 1) {
    const root = stack[i].value;
    const hit = walk(root, segs);
    // `depth` records how far out the value came from. Zero means the innermost
    // scope; anything else is an outer-scope fallback, which is usually intended
    // and occasionally a disaster — see assertNotShadowedTypo.
    if (hit.found) return { ...hit, depth: from - i };
    if (up > 0) break;
  }
  return { found: false, value: undefined };
}

function walk(root, segs) {
  let cur = root;
  for (let i = 0; i < segs.length; i += 1) {
    if (cur === null || cur === undefined) return { found: false, value: undefined };
    const key = segs[i];
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(key)) return { found: false, value: undefined };
      const idx = Number(key);
      if (idx >= cur.length) return { found: false, value: undefined };
      cur = cur[idx];
      continue;
    }
    if (typeof cur !== 'object') return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(cur, key)) return { found: false, value: undefined };
    cur = cur[key];
  }
  return { found: true, value: cur };
}

/**
 * Resolves a VALUE tag to the string that goes into the document.
 * Throws TemplateError, naming the field, when it cannot.
 */
function resolveValue(tag, stack, ctx) {
  const hit = lookup(tag.path, stack);
  const { found, value } = hit;
  const hasDefault = tag.formatters.some((f) => f.name === 'default');
  if (found && hit.depth > 0) assertNotShadowedTypo(tag, stack, hit, ctx);

  if (!found && !hasDefault) {
    if (ctx.onMissing === 'empty') return '';
    if (ctx.onMissing === 'keep') return tag.raw;
    const available = visibleKeys(stack);
    const guess = didYouMean(tag.path.split('.').pop(), available);
    throw new TemplateError('placeholder_unresolved',
      `The template uses {${tag.expr}} but the data has no "${tag.path}".`, {
        field: tag.path,
        location: ctx.location || null,
        available: available.slice(0, 40),
        hint: guess
          ? `Did you mean "${guess}"? Otherwise add "${tag.path}" to the data, or write {${tag.path}|default:} to allow it to be absent.`
          : `Add "${tag.path}" to the data, or write {${tag.path}|default:} to allow it to be absent.`,
      });
  }

  const out = applyFormatters(found ? value : undefined, tag.formatters, ctx);
  if (out === null || out === undefined) return '';
  if (typeof out === 'object') {
    throw new TemplateError('placeholder_not_scalar',
      `{${tag.expr}} resolves to ${Array.isArray(out) ? 'a list' : 'an object'}, which cannot be written into the document as text.`, {
        field: tag.path,
        location: ctx.location || null,
        hint: Array.isArray(out)
          ? `Loop over it with {#${tag.path}} … {/${tag.path}}, or reduce it with a formatter such as {${tag.path}|join:, } or {${tag.path}|sum:amount}.`
          : `Point at one of its fields, e.g. {${tag.path}.name}.`,
      });
  }
  if (typeof out === 'number') return numberToText(out, ctx);
  if (typeof out === 'boolean') return out ? 'true' : 'false';
  return String(out);
}

/**
 * A bare number goes in as the caller wrote it, not through the locale
 * formatter — silently turning 1000 into "1,000" in a part number would be
 * worse than the missing thousands separator on a figure. Ask for {n|number}
 * to get grouping.
 */
function numberToText(n, ctx) {
  if (Number.isInteger(n)) return String(n);
  // Kill float noise from arithmetic formatters without changing real precision.
  const cleaned = Math.round(n * 1e9) / 1e9;
  return ctx.numberAsLocale ? new Intl.NumberFormat(ctx.locale).format(cleaned) : String(cleaned);
}

/**
 * Section semantics, mustache-compatible:
 *   array     -> one pass per element (empty array = zero passes)
 *   object    -> one pass with the object pushed as scope
 *   truthy    -> one pass, nothing pushed
 *   falsy     -> zero passes
 * A missing key is an error, exactly as for a value, unless onMissing relaxes it.
 */
function resolveSection(tag, stack, ctx) {
  const { found, value: raw } = lookup(tag.path, stack);
  const value = found ? applyFormatters(raw, tag.formatters || [], ctx) : raw;
  if (!found) {
    if (ctx.onMissing === 'empty' || ctx.onMissing === 'keep') return { passes: [] };
    const available = visibleKeys(stack);
    const guess = didYouMean(tag.path.split('.').pop(), available);
    throw new TemplateError('section_unresolved',
      `The template loops over {#${tag.path}} but the data has no "${tag.path}".`, {
        field: tag.path,
        location: ctx.location || null,
        available: available.slice(0, 40),
        hint: guess
          ? `Did you mean "${guess}"?`
          : `Add "${tag.path}" to the data as a list, or remove the {#${tag.path}} section from the template. An empty list "[]" renders the section zero times.`,
      });
  }
  return { passes: passesFor(value) };
}

function passesFor(value) {
  if (Array.isArray(value)) {
    return value.map((item, i) => ({
      value: item,
      meta: {
        $index: i, $index1: i + 1, $first: i === 0, $last: i === value.length - 1, $length: value.length, $total: value.length,
      },
    }));
  }
  if (value === null || value === undefined || value === false || value === '' || value === 0) return [];
  if (typeof value === 'object') return [{ value, meta: { $index: 0, $index1: 1, $first: true, $last: true, $length: 1, $total: 1 } }];
  return [{ value: undefined, meta: { $index: 0, $index1: 1, $first: true, $last: true, $length: 1, $total: 1 } }];
}

function resolveInverted(tag, stack, ctx) {
  const { found, value: raw } = lookup(tag.path, stack);
  const value = found ? applyFormatters(raw, tag.formatters || [], ctx) : raw;
  // An inverted section is precisely the "when this is absent or empty" case, so
  // absence is normal here rather than an error.
  if (!found) return { passes: [{ value: undefined, meta: {} }] };
  return { passes: passesFor(value).length === 0 ? [{ value: undefined, meta: {} }] : [] };
}

/**
 * The silent-wrong-output bug this product exists to prevent.
 *
 * Scopes nest outwards, so inside {#items} a tag can legitimately reach the
 * invoice's {currency} at the root. That convenience has a nasty edge, and the
 * market leader documents it as normal behaviour: if the loop items have a field
 * `product_name` and the author writes {name}, and `name` happens to exist at the
 * root, every row of the table silently prints the SAME root value. Nothing errors.
 * The document looks plausible. It is wrong, and it goes out to a customer.
 *
 * So an outer-scope hit is allowed only when the inner scope has nothing that
 * looks like what was asked for. If the inner scope holds a near-miss key, that is
 * a typo, not a deliberate reach outwards, and it fails by name.
 */
function assertNotShadowedTypo(tag, stack, hit, ctx) {
  const inner = stack[stack.length - 1];
  if (!inner || !inner.value || typeof inner.value !== 'object' || Array.isArray(inner.value)) return;

  const head = tag.path.split('.')[0].replace(/^\[|\]$/g, '');
  const innerKeys = Object.keys(inner.value);
  if (innerKeys.includes(head)) return;            // cannot be a fallback at all

  // Every outer-scope hit inside a loop prints the SAME value on every row. That
  // is usually what was wanted ({currency} from the invoice root) and occasionally
  // a serious bug ({name} meaning the item, resolving to the company name). We
  // cannot tell which from the data alone — so it is recorded and reported back on
  // every render, rather than being guessed at silently in either direction.
  if (ctx.warnings) {
    const key = `${tag.path}@${ctx.location || ''}`;
    if (!ctx.warnings.seen.has(key)) {
      ctx.warnings.seen.add(key);
      ctx.warnings.list.push({
        code: 'resolved_from_outer_scope',
        field: tag.path,
        location: ctx.location || null,
        message: `{${tag.expr}} is not a field of the loop item; it was taken from ${hit.depth} level${hit.depth > 1 ? 's' : ''} further out, so it prints the same value on every row.`,
        item_fields: innerKeys.slice(0, 20),
      });
    }
  }

  if (ctx.strictScope) {
    throw new TemplateError('placeholder_outside_loop',
      `{${tag.expr}} is not a field of the loop item.`, {
        field: tag.path,
        location: ctx.location || null,
        available: innerKeys.slice(0, 40),
        hint: `strictScope is on, so a tag inside a loop must name a field of the item. Write {../${tag.path}} if you meant the value from outside the loop.`,
      });
  }

  if (ctx.onMissing !== 'error') return;
  const guess = didYouMean(head, innerKeys);
  if (!guess) return;                              // nothing similar: a real outer reference

  throw new TemplateError('placeholder_shadowed',
    `Inside this loop, {${tag.expr}} does not exist on the item — it was found ${hit.depth} level${hit.depth > 1 ? 's' : ''} further out, which would print the same value on every row.`, {
      field: tag.path,
      location: ctx.location || null,
      available: innerKeys.slice(0, 40),
      hint: `The item has "${guess}", which looks like what was meant. Write {${guess}} to use the item's own value, or {../${tag.path}} if you really did mean the outer one.`,
    });
}

function makeContext(opts = {}) {
  const onMissing = opts.onMissing || 'error';
  if (!['error', 'empty', 'keep'].includes(onMissing)) {
    throw new TemplateError('bad_option', `"onMissing" must be "error", "empty" or "keep", got "${onMissing}".`);
  }
  return {
    locale: opts.locale || 'en-US',
    currency: opts.currency || 'USD',
    timezone: opts.timezone || 'UTC',
    onMissing,
    numberAsLocale: opts.numberAsLocale === true,
    // Refuse any outer-scope read inside a loop unless written as `../x`. Off by
    // default because {currency} from the invoice root is a reasonable thing to
    // write; on, it turns the warning below into an error.
    strictScope: opts.strictScope === true,
    warnings: { list: [], seen: new Set() },
    location: null,
  };
}

module.exports = { lookup, resolveValue, resolveSection, resolveInverted, makeContext, visibleKeys, passesFor, splitPath };
