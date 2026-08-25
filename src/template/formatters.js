'use strict';

const { TemplateError } = require('./errors');

/**
 * Formatters exist so that a number that belongs in the document can be derived
 * from the data rather than typed into the template by hand. `sum` and `count`
 * are the important ones: an invoice template that writes its own total is an
 * invoice template that is wrong the first time a line item changes.
 */

const isNil = (v) => v === null || v === undefined;

function toNumber(v, formatterName) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  if (typeof v === 'boolean') return v ? 1 : 0;
  throw new TemplateError('formatter_type', `"${formatterName}" needs a number, but got ${describe(v)}.`, {
    hint: 'Send the value as a JSON number, or as a string that parses as one.',
  });
}

function describe(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'nothing';
  if (Array.isArray(v)) return `an array of ${v.length}`;
  return `${typeof v} (${JSON.stringify(v)?.slice(0, 40)})`;
}

/** Money, in cents-safe arithmetic, so 0.1 + 0.2 does not appear on an invoice. */
function addMoney(a, b) {
  return Math.round((a + b) * 1e6) / 1e6;
}

function asList(v, name) {
  if (Array.isArray(v)) return v;
  throw new TemplateError('formatter_type', `"${name}" needs a list, but got ${describe(v)}.`, {
    hint: 'List formatters only apply to arrays — use them on a section, e.g. {#items|' + name + ':field}.',
  });
}

const FORMATTERS = {
  upper: (v) => String(v).toUpperCase(),
  lower: (v) => String(v).toLowerCase(),
  trim: (v) => String(v).trim(),
  title: (v) => String(v).replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase()),

  /** {n|number:2} -> "1,234.57" in the request locale. */
  number: (v, args, ctx) => {
    const n = toNumber(v, 'number');
    const digits = args[0] === undefined || args[0] === '' ? undefined : Number(args[0]);
    if (digits !== undefined && (!Number.isInteger(digits) || digits < 0 || digits > 20)) {
      throw new TemplateError('formatter_arg', `"number" takes 0..20 decimal places, got "${args[0]}".`);
    }
    return new Intl.NumberFormat(ctx.locale, digits === undefined ? {} : {
      minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(n);
  },

  /** {total|currency:EUR} -> "€1,234.57". Currency defaults to the request's. */
  currency: (v, args, ctx) => {
    const n = toNumber(v, 'currency');
    const code = (args[0] || ctx.currency || 'USD').toUpperCase();
    if (!/^[A-Z]{3}$/.test(code)) {
      throw new TemplateError('formatter_arg', `"currency" needs a 3-letter ISO code such as EUR or USD, got "${args[0]}".`);
    }
    return new Intl.NumberFormat(ctx.locale, { style: 'currency', currency: code }).format(n);
  },

  percent: (v, args, ctx) => {
    const n = toNumber(v, 'percent');
    const digits = args[0] === undefined || args[0] === '' ? 0 : Number(args[0]);
    return new Intl.NumberFormat(ctx.locale, {
      style: 'percent', minimumFractionDigits: digits, maximumFractionDigits: digits,
    }).format(n);
  },

  /**
   * Returns a NUMBER, like sum/add/multiply and unlike currency/number, which
   * return formatted text. The distinction is load-bearing in a spreadsheet: a
   * numeric result becomes a real numeric cell and a SUM over the column works,
   * whereas text lands as text and SUM silently returns zero. This used to return
   * a string, which made {price|round:2} the one arithmetic formatter that broke
   * the column it was in.
   */
  round: (v, args) => {
    const n = toNumber(v, 'round');
    const d = args[0] === undefined || args[0] === '' ? 0 : Number(args[0]);
    const f = 10 ** d;
    return Math.round(n * f) / f;
  },

  /**
   * {date|date:YYYY-MM-DD} or {date|date:long}. Accepts an ISO string, an epoch
   * number, or anything Date can parse; refuses anything it cannot, rather than
   * printing "Invalid Date" into a contract.
   */
  date: (v, args, ctx) => {
    const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
    if (Number.isNaN(d.getTime())) {
      throw new TemplateError('formatter_type', `"date" could not read ${describe(v)} as a date.`, {
        hint: 'Send an ISO 8601 string such as "2026-03-14" or "2026-03-14T09:00:00Z".',
      });
    }
    const pattern = args[0] || 'YYYY-MM-DD';
    const tz = ctx.timezone || 'UTC';
    if (pattern === 'long' || pattern === 'medium' || pattern === 'short' || pattern === 'full') {
      return new Intl.DateTimeFormat(ctx.locale, { dateStyle: pattern, timeZone: tz }).format(d);
    }
    return formatWithPattern(d, pattern, ctx.locale, tz);
  },

  /** The only sanctioned way to let a field be absent. */
  default: (v, args) => (isNil(v) || v === '' ? (args[0] ?? '') : v),

  join: (v, args) => {
    if (!Array.isArray(v)) {
      throw new TemplateError('formatter_type', `"join" needs an array, but got ${describe(v)}.`);
    }
    return v.map((x) => (isNil(x) ? '' : String(x))).join(args[0] ?? ', ');
  },

  /**
   * {items|sum:amount} adds up field `amount` over an array; {nums|sum} adds up
   * an array of numbers. This is how a template computes its own total.
   */
  sum: (v, args) => {
    if (!Array.isArray(v)) {
      throw new TemplateError('formatter_type', `"sum" needs an array, but got ${describe(v)}.`, {
        hint: 'Use it on a list, e.g. {items|sum:amount}.',
      });
    }
    const field = args[0];
    let total = 0;
    v.forEach((row, idx) => {
      const raw = field ? (row == null ? undefined : row[field]) : row;
      if (isNil(raw)) {
        throw new TemplateError('sum_missing_field',
          field
            ? `"sum:${field}" cannot add up the list: item ${idx + 1} has no "${field}".`
            : `"sum" cannot add up the list: item ${idx + 1} is empty.`,
          { field, hint: 'Every item in the list must carry the field being summed.' });
      }
      total = addMoney(total, toNumber(raw, 'sum'));
    });
    return total;
  },

  /** {items|product:qty:price} -> per-row qty*price, summed. Line totals, done once. */
  sumProduct: (v, args) => {
    if (!Array.isArray(v)) throw new TemplateError('formatter_type', `"sumProduct" needs an array, but got ${describe(v)}.`);
    if (args.length < 2) throw new TemplateError('formatter_arg', '"sumProduct" needs two field names, e.g. {items|sumProduct:qty:price}.');
    let total = 0;
    v.forEach((row, idx) => {
      for (const f of args) {
        if (row == null || isNil(row[f])) {
          throw new TemplateError('sum_missing_field', `"sumProduct" cannot multiply: item ${idx + 1} has no "${f}".`, { field: f });
        }
      }
      total = addMoney(total, args.reduce((acc, f) => acc * toNumber(row[f], 'sumProduct'), 1));
    });
    return total;
  },


  /* ---------------------------------------------- list shaping, for sections

     These exist so that {#items|filter:active|sort:due_date} is possible. The
     alternative is telling the user to sort and filter the array in their
     workflow before it reaches us — which is fine until the same array has to be
     rendered twice in one document, in two different orders, at which point it is
     not fine at all. */

  /** {#rows|filter:active} keeps rows whose field is truthy; filter:field:value keeps equals. */
  filter: (v, args) => {
    const list = asList(v, 'filter');
    const [field, wanted] = args;
    if (!field) throw new TemplateError('formatter_arg', '"filter" needs a field name, e.g. {#items|filter:active}.');
    return list.filter((row) => {
      const got = row == null ? undefined : row[field];
      if (wanted === undefined) return Boolean(got) && got !== '0';
      return String(got) === String(wanted);
    });
  },

  /** {#items|reject:archived} — the inverse, because writing it with filter is awkward. */
  reject: (v, args) => {
    const list = asList(v, 'reject');
    const [field, wanted] = args;
    if (!field) throw new TemplateError('formatter_arg', '"reject" needs a field name.');
    return list.filter((row) => {
      const got = row == null ? undefined : row[field];
      if (wanted === undefined) return !got || got === '0';
      return String(got) !== String(wanted);
    });
  },

  /** {#items|sort:name} or {#items|sort:total:desc}. Numbers sort numerically. */
  sort: (v, args, ctx) => {
    const list = [...asList(v, 'sort')];
    const [field, dir] = args;
    const desc = String(dir || '').toLowerCase().startsWith('desc');
    const key = (row) => (field ? (row == null ? undefined : row[field]) : row);
    const collator = new Intl.Collator(ctx.locale, { numeric: true, sensitivity: 'base' });
    list.sort((a, b) => {
      const x = key(a); const y = key(b);
      if (x === y) return 0;
      if (x === null || x === undefined) return 1;
      if (y === null || y === undefined) return -1;
      const both = typeof x === 'number' && typeof y === 'number';
      const cmp = both ? x - y : collator.compare(String(x), String(y));
      return desc ? -cmp : cmp;
    });
    return list;
  },

  reverse: (v) => [...asList(v, 'reverse')].reverse(),
  limit: (v, args) => asList(v, 'limit').slice(0, Math.max(0, Number(args[0]) || 0)),
  skip: (v, args) => asList(v, 'skip').slice(Math.max(0, Number(args[0]) || 0)),

  unique: (v, args) => {
    const list = asList(v, 'unique');
    const seen = new Set();
    return list.filter((row) => {
      const k = JSON.stringify(args[0] ? (row == null ? undefined : row[args[0]]) : row);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  },

  /**
   * {#items|groupBy:category} yields [{key, items, count}], so a section can loop
   * groups and a nested {#items} loop the rows inside each. Order of first
   * appearance is preserved, because a grouped invoice that reorders itself
   * between runs is a support ticket.
   */
  groupBy: (v, args) => {
    const list = asList(v, 'groupBy');
    const field = args[0];
    if (!field) throw new TemplateError('formatter_arg', '"groupBy" needs a field name, e.g. {#lines|groupBy:category}.');
    const groups = new Map();
    for (const row of list) {
      const k = row == null || row[field] === undefined || row[field] === null ? '' : String(row[field]);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(row);
    }
    return [...groups.entries()].map(([key, items]) => ({ key, items, count: items.length }));
  },

  count: (v) => (Array.isArray(v) ? v.length : (isNil(v) ? 0 : 1)),

  multiply: (v, args) => {
    const n = toNumber(v, 'multiply');
    return Math.round(n * toNumber(args[0], 'multiply') * 1e6) / 1e6;
  },
  add: (v, args) => addMoney(toNumber(v, 'add'), toNumber(args[0], 'add')),
  subtract: (v, args) => addMoney(toNumber(v, 'subtract'), -toNumber(args[0], 'subtract')),
  divide: (v, args) => {
    const d = toNumber(args[0], 'divide');
    if (d === 0) throw new TemplateError('formatter_arg', '"divide" was asked to divide by zero.');
    return Math.round((toNumber(v, 'divide') / d) * 1e6) / 1e6;
  },

  /** {n|ordinal} -> 1st, 2nd. English only; documented as such. */
  ordinal: (v) => {
    const n = Math.trunc(toNumber(v, 'ordinal'));
    const s = ['th', 'st', 'nd', 'rd'];
    const m = n % 100;
    return n + (s[(m - 20) % 10] || s[m] || s[0]);
  },

  yesno: (v, args) => (v ? (args[0] ?? 'Yes') : (args[1] ?? 'No')),
};

const D2 = (n) => String(n).padStart(2, '0');

/** YYYY MM DD HH mm ss, plus MMM/MMMM/ddd/dddd via Intl in the request locale. */
function formatWithPattern(date, pattern, locale, timeZone) {
  const parts = {};
  for (const p of new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(date)) parts[p.type] = p.value;

  const named = (opt) => new Intl.DateTimeFormat(locale, { ...opt, timeZone }).format(date);

  return pattern.replace(/YYYY|YY|MMMM|MMM|MM|DDDD|dddd|DDD|ddd|DD|HH|hh|mm|ss|A|a/g, (t) => {
    switch (t) {
      case 'YYYY': return parts.year;
      case 'YY': return parts.year.slice(-2);
      case 'MMMM': return named({ month: 'long' });
      case 'MMM': return named({ month: 'short' });
      case 'MM': return parts.month;
      case 'DDDD': case 'dddd': return named({ weekday: 'long' });
      case 'DDD': case 'ddd': return named({ weekday: 'short' });
      case 'DD': return parts.day;
      case 'HH': return parts.hour === '24' ? '00' : parts.hour;
      case 'hh': return D2(((Number(parts.hour) % 12) || 12));
      case 'mm': return parts.minute;
      case 'ss': return parts.second;
      case 'A': return Number(parts.hour) < 12 ? 'AM' : 'PM';
      case 'a': return Number(parts.hour) < 12 ? 'am' : 'pm';
      default: return t;
    }
  });
}

function applyFormatters(value, formatters, ctx) {
  let v = value;
  for (const f of formatters) {
    const fn = FORMATTERS[f.name];
    if (!fn) {
      const known = Object.keys(FORMATTERS).sort();
      // `field` means the data path everywhere else in this API, so putting a
      // formatter name in it would make the error machine-unreadable. The
      // formatter goes in its own slot and the caller is told the whole list.
      const err = new TemplateError('unknown_formatter', `There is no formatter called "${f.name}".`, {
        available: known,
        hint: `Known formatters: ${known.join(', ')}.`,
      });
      err.formatter = f.name;
      throw err;
    }
    v = fn(v, f.args, ctx);
  }
  return v;
}

module.exports = { FORMATTERS, applyFormatters, formatWithPattern, names: () => Object.keys(FORMATTERS).sort() };
