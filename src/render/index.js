'use strict';

const { detect } = require('./detect');
const { discover } = require('./fields');
const { makeContext } = require('../template/resolve');
const { TemplateError } = require('../template/errors');
const { ApiError } = require('../errors');
const { FORMATS } = require('../config');
const log = require('../log');

/**
 * The dispatcher. Detects what the template is, hands it to the renderer for that
 * format, and turns a TemplateError into an HTTP 422 that names the field.
 *
 * 422 rather than 400 deliberately: the request was well-formed and we understood
 * it, we just cannot carry it out because the template asks for something the data
 * does not have. A caller can distinguish "I sent nonsense" from "my data is
 * missing a field" without parsing the message.
 */

const RENDERERS = {
  docx: () => require('./docx'),
  xlsx: () => require('./xlsx'),
  pptx: () => require('./pptx'),
};

function rendererFor(format) {
  const load = RENDERERS[format];
  if (!load) {
    throw new ApiError(415, 'format_unsupported', `DocMint cannot fill ${format} files.`, { docs: '/docs#formats' });
  }
  try {
    return load();
  } catch (e) {
    log.error('render.renderer_missing', { format, err: e });
    throw new ApiError(501, 'format_not_available',
      `This build of DocMint has no ${format} renderer.`, {
        hint: 'This is a deployment fault rather than anything wrong with your request. Please report it.',
      });
  }
}

/**
 * @param {Buffer} templateBuffer
 * @param {object} data
 * @param {object} opts  locale, currency, timezone, onMissing, strictScope, log
 * @returns {Promise<{buffer, format, stats, warnings}>}
 */
async function fill(templateBuffer, data, opts = {}) {
  const l = opts.log || log;
  const { format, macroEnabled } = detect(templateBuffer);
  const renderer = rendererFor(format);

  if (data === null || data === undefined) data = {};
  if (typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError(400, 'bad_data',
      `"data" must be a JSON object, not ${Array.isArray(data) ? 'an array' : typeof data}.`, {
        hint: Array.isArray(data)
          ? 'If you want to loop over a list, put it under a key: {"items": [...]}, and loop with {#items} in the template.'
          : 'Send something like {"customer": "Acme", "items": [...]}.',
        docs: '/docs#data',
      });
  }

  const ctx = makeContext(opts);
  const started = process.hrtime.bigint();

  let out;
  try {
    out = await renderer.render(templateBuffer, data, { ...opts, ctx });
  } catch (e) {
    if (e instanceof TemplateError) {
      throw new ApiError(422, e.code, e.message, {
        hint: e.hint,
        docs: '/docs#errors',
        details: { field: e.field, location: e.location, available: e.available, format },
      });
    }
    if (e instanceof ApiError) throw e;
    log.error('render.unexpected', { format, err: e });
    throw new ApiError(500, 'render_failed',
      `Filling this ${FORMATS[format].name} failed: ${e.message}`, {
        hint: 'If the template opens correctly in Office, this is a bug worth reporting with the template attached.',
      });
  }

  const ms = Math.round(Number(process.hrtime.bigint() - started) / 1e5) / 10;
  const warnings = [...(ctx.warnings?.list || []), ...(out.warnings || [])];

  if (macroEnabled) {
    warnings.push({
      code: 'macros_not_preserved',
      message: 'This template is macro-enabled. The document is filled correctly, but macros are not guaranteed to survive and the file is returned with the plain (non-macro) content type.',
    });
  }

  l.info('fill.ok', {
    format, ms,
    in_bytes: templateBuffer.length,
    out_bytes: out.buffer.length,
    tags: out.stats?.tags, resolved: out.stats?.resolved, sections: out.stats?.sections,
    images: out.stats?.images, parts: out.stats?.parts?.length,
    warnings: warnings.length,
  });

  return { buffer: out.buffer, format, stats: { ...out.stats, ms }, warnings };
}

/**
 * What does this template need? No data required, never throws on a missing field.
 *
 * Two answers are returned together because they answer different questions.
 * `tags` is what is literally written in the file, with where each one is, which
 * is what you want when a template is misbehaving. `fields` is the typed, scoped
 * tree — what to SEND — which is what you want when building a form, and it is
 * derived by actually running the renderer rather than by parsing a second time,
 * so it cannot drift from what a real render would do.
 */
async function inspect(templateBuffer) {
  const { format } = detect(templateBuffer);
  const renderer = rendererFor(format);
  const out = await renderer.inspect(templateBuffer);

  let discovered = { fields: [], sample_data: {}, passes: 0 };
  try {
    discovered = await discover((data, opts) => renderer.render(templateBuffer, data, opts));
  } catch (e) {
    log.warn('inspect.discover_failed', { format, err: e });
  }

  return {
    format,
    parts: out.parts,
    tags: out.tags,
    // The flat list of names the renderer found, kept for anything already using
    // it, and because it is the honest answer to "what is written in this file".
    names: out.fields,
    fields: discovered.fields,
    sample_data: discovered.sample_data,
  };
}

module.exports = { fill, inspect, detect, rendererFor };
