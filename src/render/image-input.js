'use strict';

const { TemplateError } = require('../template/errors');

/**
 * One image-input contract for the DOCX, PPTX and XLSX renderers.
 *
 * Until 2026-09-21 each renderer picked image bytes out of the data with its own
 * `??` chain — DOCX read data/base64/bytes/content, PPTX read data/base64/src/
 * content and refused every URL key outright, XLSX read data/base64/buffer/
 * content, ignored the request's images option and answered a {"url"} object
 * with the misleading image_bad_data. The docs and /v1/capabilities promised one
 * contract for all three formats; the renderers delivered three dialects. This
 * module is now the one contract, and every renderer resolves its placeholder
 * through it before applying its own byte decoding, format probing and sizing.
 *
 * The rules, identical in every format:
 *  a. a plain string, Buffer or Uint8Array value is treated as {data: value};
 *  b. the first present DATA_KEY wins; if that value starts http(s):// or
 *     file://, it is a URL, not bytes;
 *  c. otherwise the first present URL_KEY gives the URL;
 *  d. a URL is resolved ONLY through the request's images option — first
 *     images[url], then images[tagPath]; a supplied entry may itself be bytes,
 *     a base64 string, or an object carrying any DATA_KEY. If neither lookup
 *     supplies bytes, the render fails with image_url_unsupported;
 *  e. a field absent from the data but present in images[tagPath] is used —
 *     the renderers apply this before their missing-field contract.
 *
 * Nothing here fetches anything over the network or reads a file, ever: a URL
 * only ever yields bytes that the caller supplied alongside the request. A
 * file:// value in a byte key is therefore a URL like an http(s) one — it is
 * satisfied ONLY through the images option. Any other scheme in a byte key
 * (a data: URI is bytes, not a URL) stays bytes for the renderer's decoder
 * to judge.
 */

/** The keys read as image bytes, in priority order. Published as bytes.data_keys. */
const DATA_KEYS = ['data', 'base64', 'bytes', 'content', 'buffer', 'src'];

/** The keys read as an image URL to be satisfied from the images option. Published as bytes.url_keys. */
const URL_KEYS = ['url', 'href', 'uri'];

/** http(s) and file: are URLs; any other scheme (e.g. a data: URI) in a byte key stays bytes for the decoder to judge. */
const isUrl = (v) => typeof v === 'string' && /^(?:https?|file):\/\//i.test(v.trim());

/** The images option arrives as a plain object (HTTP) or a Map (DOCX renderer); both work. */
function imagesEntry(images, key) {
  if (!images) return undefined;
  if (images instanceof Map) return images.get(key);
  if (typeof images === 'object') {
    return Object.prototype.hasOwnProperty.call(images, key) ? images[key] : undefined;
  }
  return undefined;
}

/** Presence without reading: an entry explicitly set to null counts as present. */
function imagesHas(images, key) {
  if (!images) return false;
  if (images instanceof Map) return images.has(key);
  if (typeof images === 'object') return Object.prototype.hasOwnProperty.call(images, key);
  return false;
}

const isRawBytes = (v) => Buffer.isBuffer(v) || v instanceof Uint8Array;
const isSpecObject = (v) => v !== null && typeof v === 'object';

/** First present DATA_KEY, nullish values skipped — the same semantics the renderers' old ?? chains had. */
function firstData(spec) {
  for (const key of DATA_KEYS) {
    if (spec[key] !== undefined && spec[key] !== null) return spec[key];
  }
  return undefined;
}

/**
 * Resolves one image placeholder to its raw byte source.
 *
 * @param {*} value the placeholder value as it came out of the data
 * @param {string} tagPath the tag path, e.g. "logo" — the second images lookup key
 * @param {Map|object|null} images the request's images option
 * @param {{urlError?: (url: string) => TemplateError}} [opts] lets each renderer
 *   keep its own message, hint and location style for image_url_unsupported
 * @returns {{kind: 'none'} | {kind: 'bytes', src: *, width: *, height: *, alt: *}}
 *   kind 'none' means "the caller said null" — nothing is rendered; kind 'bytes'
 *   carries the raw source (Buffer, Uint8Array, base64 string or data: URI —
 *   never a URL) plus the placeholder's raw width/height/alt for the renderer's
 *   own coercion and validation.
 * @throws {TemplateError} image_url_unsupported when a URL has no bytes supplied
 */
function resolveImageInput(value, tagPath, images, opts = {}) {
  if (value === null || value === undefined || value === '') return { kind: 'none' };

  // Rule (a).
  let spec = value;
  if (isRawBytes(value) || typeof value === 'string') spec = { data: value };

  if (!isSpecObject(spec)) {
    // A number, boolean or array — there are no keys to pick from. Hand the raw
    // value back and let the renderer's byte decoder name the error in its own
    // words (image_invalid / image_bad_data / image_unsupported_format).
    return { kind: 'bytes', src: value, width: undefined, height: undefined, alt: undefined };
  }

  // Rules (b) and (c): bytes first; an http(s):// or file:// value in a byte
  // key is a URL; otherwise the first present URL key is the URL (a truthy
  // one — an empty string URL key is ignored, as every renderer did before
  // this module).
  const picked = firstData(spec);
  const url = isUrl(picked) ? picked : (spec.url ?? spec.href ?? spec.uri) || null;

  if (url !== null) {
    // Rule (d): bytes for a URL come only from the images option.
    const supplied = imagesEntry(images, url) ?? imagesEntry(images, tagPath);
    if (supplied === undefined || supplied === null) {
      throw opts.urlError ? opts.urlError(url) : defaultUrlError(tagPath, url);
    }
    const inner = isSpecObject(supplied) && !isRawBytes(supplied) ? firstData(supplied) : supplied;
    return { kind: 'bytes', src: inner, width: spec.width, height: spec.height, alt: spec.alt };
  }

  return { kind: 'bytes', src: picked, width: spec.width, height: spec.height, alt: spec.alt };
}

function defaultUrlError(tagPath, url) {
  return new TemplateError('image_url_unsupported',
    `{%${tagPath}} points at a URL (${String(url).slice(0, 120)}), and this renderer does not fetch images.`, {
      field: tagPath,
      hint: 'Pass the image itself: base64 or a data URI in the data, or supply the bytes through the "images" option keyed by the URL.',
    });
}

module.exports = {
  DATA_KEYS,
  URL_KEYS,
  resolveImageInput, // (value, tagPath, images, opts?) -> {kind:'none'} | {kind:'bytes', src, width, height, alt}
  imagesHas, // (images, key) -> boolean; presence check across Map and plain object
  imagesEntry, // (images, key) -> the entry, or undefined; same duality
};
