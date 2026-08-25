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

function warn(ctx, entry) {
  if (!ctx.warnings) return;
  const key = `${entry.code}:${entry.field}@${entry.location || ''}`;
  if (ctx.warnings.seen.has(key)) return;
  ctx.warnings.seen.add(key);
  ctx.warnings.list.push(entry);
}

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
  if (ctx.probe) ctx.probe.value(tag, stack);
  const hit = lookup(tag.path, stack);
  const { found, value } = hit;
  const hasDefault = tag.formatters.some((f) => f.name === 'default');
  if (found && hit.depth > 0) assertNotShadowedTypo(tag, stack, hit, ctx);

  if (!found && !hasDefault) {
    if (ctx.onMissing === 'empty' || ctx.onMissing === 'keep') {
      warn(ctx, {
        code: ctx.onMissing === 'empty' ? 'field_blanked' : 'field_left_as_tag',
        field: tag.path,
        location: ctx.location || null,
        message: ctx.onMissing === 'empty'
          ? `{${tag.expr}} was left blank because the data has no "${tag.path}" and onMissing is "empty".`
          : `{${tag.expr}} was left in the document as written because the data has no "${tag.path}" and onMissing is "keep".`,
      });
      return ctx.onMissing === 'empty' ? '' : tag.raw;
    }
    const available = visibleKeys(stack);
    const guess = suggestFor(tag.path, stack, available);
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

  // While probing (see src/render/fields.js) the data is a skeleton, so a
  // formatter that inspects it - {rows|sum:amount} over a row with no amount -
  // will legitimately object. Discovery is not correctness: swallow it and carry
  // on, or one such tag would abort the walk and hide every field after it.
  let out;
  if (ctx.probe) {
    try { out = applyFormatters(found ? value : undefined, tag.formatters, ctx); } catch { out = ''; }
  } else {
    try {
      out = applyFormatters(found ? value : undefined, tag.formatters, ctx);
    } catch (e) {
      // A formatter knows what went wrong but not where. Without this, a
      // "currency needs a number" on page 40 of a report gave the caller no way
      // at all to find the offending tag - and pointing at the exact tag is the
      // thing docxtemplater charges 500 EUR a year for.
      if (e instanceof TemplateError) {
        if (!e.field) e.field = tag.path;
        if (!e.location) e.location = ctx.location || null;
        if (!e.tag) e.tag = `{${tag.expr}}`;
        e.message = `${e.message.replace(/\.$/, '')}, in {${tag.expr}}${ctx.location ? ` at ${ctx.location}` : ''}.`;
      }
      throw e;
    }
  }
  if (out === null || out === undefined) return '';
  // While probing there is no real data, so a section iterating over a skeleton
  // object makes {.} an object. That is an artefact of the probe, not a fault in
  // the template, and throwing here would abandon the walk and lose every field
  // written after this point.
  if (typeof out === 'object' && ctx.probe) return '';
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
  if (ctx.probe) ctx.probe.section(tag, stack, 'section');
  const { found, value: raw } = lookup(tag.path, stack);
  let value = raw;
  if (found) {
    if (ctx.probe) { try { value = applyFormatters(raw, tag.formatters || [], ctx); } catch { value = raw; } }
    else value = applyFormatters(raw, tag.formatters || [], ctx);
  }
  if (!found) {
    if (ctx.onMissing === 'empty' || ctx.onMissing === 'keep') {
      warn(ctx, {
        code: 'section_missing',
        field: tag.path,
        location: ctx.location || null,
        message: `{#${tag.path}} rendered nothing because the data has no "${tag.path}" and onMissing is "${ctx.onMissing}".`,
      });
      return { passes: [] };
    }
    const available = visibleKeys(stack);
    const guess = suggestFor(tag.path, stack, available);
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
  const passes = passesFor(value);
  // An EMPTY LIST is worth reporting: it is the most likely real-world data
  // fault - the upstream query came back with nothing - and it produces a
  // perfectly clean, sendable, wrong document with a zero total on it.
  //
  // A falsy scalar is NOT worth reporting. {#paid}PAID{/paid} not rendering when
  // paid is false is the entire point of writing it, and warning about it every
  // time would train people to ignore the warnings channel, which would cost more
  // than it is worth.
  if (passes.length === 0 && Array.isArray(value)) {
    warn(ctx, {
      code: 'section_rendered_empty',
      field: tag.path,
      location: ctx.location || null,
      message: `{#${tag.path}} rendered nothing because "${tag.path}" is an empty list. Any total computed over it will be zero.`,
    });
  }
  for (const p of passes) p.scopeId = tag.path;
  return { passes };
}

function passesFor(value) {
  if (Array.isArray(value)) {
    return value.map((item, i) => ({
      value: item,
      meta: {
        $index: i, $index1: i + 1, $first: i === 0, $last: i === value.length - 1, $length: value.length, $total: value.length,
      },
      // `scopeId` is set by the caller in resolveSection; it identifies which
      // section produced this frame, which is what lets the field prober work out
      // that {qty} lives inside {#items} rather than at the root.
      scopeId: null,
    }));
  }
  if (value === null || value === undefined || value === false || value === '' || value === 0) return [];
  // A truthy scalar renders the section once with the scalar itself in scope, so
  // {#note}{.}{/note} prints the note. Pushing `undefined` here instead — which is
  // what the first version of this function did — makes {.} render as an empty
  // string with no error at all: precisely the silent blank this whole product
  // exists to prevent. Non-object scopes are transparent to dotted lookups, which
  // fall through to the enclosing scope as before.
  const meta = { $index: 0, $index1: 1, $first: true, $last: true, $length: 1, $total: 1 };
  return [{ value, meta }];
}

function resolveInverted(tag, stack, ctx) {
  if (ctx.probe) ctx.probe.section(tag, stack, 'inverted');
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
  warn(ctx, {
    code: 'resolved_from_outer_scope',
    field: tag.path,
    location: ctx.location || null,
    message: `{${tag.expr}} is not a field of the loop item; it was taken from ${hit.depth} level${hit.depth > 1 ? 's' : ''} further out, so it prints the same value on every row.`,
    item_fields: innerKeys.slice(0, 20),
  });

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

/**
 * "Did you mean" for a DOTTED path.
 *
 * The obvious implementation compares the last segment against the keys in
 * scope, and it is wrong in the case that matters most: with data
 * {"custmer": {"name": …}} and a template writing {customer.name}, it compares
 * "name" against the root keys, finds nothing like it, and stays silent — while
 * the mistyped segment sits right there. So walk the path, find the first
 * segment that does not exist, and look for a near miss among the keys that were
 * actually available at THAT point.
 */
function suggestFor(pathText, stack, available) {
  const { segs } = splitPath(pathText);
  if (!segs.length) return null;

  let cursorKeys = available;
  let cursor = null;
  let prefix = [];

  for (let i = 0; i < segs.length; i += 1) {
    const seg = segs[i];
    if (cursorKeys.includes(seg)) {
      prefix.push(seg);
      const hit = i === 0 ? lookup(seg, stack) : { found: true, value: cursor?.[seg] };
      cursor = i === 0 ? hit.value : cursor[seg];
      cursorKeys = cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? Object.keys(cursor) : [];
      continue;
    }
    const guess = didYouMean(seg, cursorKeys);
    if (!guess) return null;
    // Name the whole corrected path, not the bare segment, so the reader can see
    // what to write rather than having to reassemble it.
    return [...prefix, guess, ...segs.slice(i + 1)].join('.');
  }
  return null;
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
    // What "now" means for {#due|past} and {x|daysUntil}. Overridable so a test
    // asserting that an overdue invoice says OVERDUE keeps passing after the date
    // it was written about, and so a caller can render as of a chosen day.
    now: opts.now || null,
    onMissing,
    numberAsLocale: opts.numberAsLocale === true,
    // Refuse any outer-scope read inside a loop unless written as `../x`. Off by
    // default because {currency} from the invoice root is a reasonable thing to
    // write; on, it turns the warning below into an error.
    strictScope: opts.strictScope === true,
    warnings: { list: [], seen: new Set() },
    // Set by the field prober (src/render/fields.js) to record what a template
    // asks for, in scope, without needing any data. Left null on a real render.
    probe: opts.probe || null,
    location: null,
  };
}

/**
 * Tells the field prober about a tag the renderer resolves itself.
 *
 * Images ({%logo}) and raw XML ({@block}) do not go through resolveValue: each
 * renderer looks them up directly because what it does with the value is
 * format-specific. Without this hook the prober simply never hears about them,
 * and GET /v1/templates/:name/fields quietly omits the logo - which is exactly
 * the kind of silent gap this product exists to remove. Costs one call and does
 * nothing at all on a real render.
 */
function probeTag(tag, stack, ctx) {
  if (ctx && ctx.probe) ctx.probe.value(tag, stack);
}

module.exports = { probeTag, lookup, resolveValue, resolveSection, resolveInverted, makeContext, visibleKeys, passesFor, splitPath };
