'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { readZip, readEntry } = require('../src/ooxml/zip');
const { render: renderDocx } = require('../src/render/docx');
const { render: renderPptx } = require('../src/render/pptx');
const { render: renderXlsx } = require('../src/render/xlsx');
const imageInput = require('../src/render/image-input');
const codes = require('../src/render/codes');
const { TemplateError } = require('../src/template/errors');

const DX = require('./helpers/docx-fixtures');
const PX = require('./helpers/pptx-fixtures');
const XX = require('./helpers/xlsx-fixtures');

/**
 * AT-I1/AT-I2/AT-I3: one image-input contract across DOCX, PPTX and XLSX.
 * Every placeholder value shape below renders identically in all three formats,
 * through the shared resolver in src/render/image-input.js. Standalone: no
 * server, no database, no network.
 */

const PNG_B64 = DX.PNG_8x4; // a real 8x4 PNG, as a base64 string
const PNG = Buffer.from(PNG_B64, 'base64');
const PNG_URI = `data:image/png;base64,${PNG_B64}`;
const URL = 'https://example.com/x.png';
const FILE_URL = 'file:///x.png';

const srcOf = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', 'render', f), 'utf8');

function reportData(overrides = {}) {
  const d = {
    title: 'Q3 Review',
    subtitle: 'Quarterly numbers',
    client: { name: 'Acme GmbH' },
    notes: 'Open with the churn number.',
    rows: [
      { sku: 'A-1', qty: 2, amount: 150 },
      { sku: 'B-2', qty: 1, amount: 99.5 },
      { sku: 'C-3', qty: 5, amount: 12.25 },
    ],
    findings: [
      { label: 'Churn', detail: 'down 2pt', owner: 'Ada' },
      { label: 'ARR', detail: 'up 8%', owner: 'Bo' },
    ],
    ...overrides,
  };
  return d;
}

const FORMATS = [
  {
    id: 'docx',
    render: (data, opts) => renderDocx(DX.fixture('invoice'), data, opts),
    baseData: () => { const d = DX.invoiceData(); delete d.logo; return d; },
    mediaPrefix: 'word/media/',
  },
  {
    id: 'pptx',
    render: (data, opts) => renderPptx(PX.fixture('report'), data, opts),
    baseData: () => reportData(),
    mediaPrefix: 'ppt/media/',
  },
  {
    id: 'xlsx',
    render: (data, opts) => renderXlsx(XX.fixture('images.xlsx'), data, opts),
    baseData: () => ({ company: 'Acme GmbH' }),
    mediaPrefix: 'xl/media/',
  },
];

/** The embedded media parts of a rendered package, as plain buffers. */
function mediaOf(buffer, prefix) {
  const zip = readZip(buffer);
  return [...zip.byName.keys()].filter((n) => n.startsWith(prefix))
    .map((n) => readEntry(zip.byName.get(n)));
}

// ---------------------------------------------------------------------------
// AT-I1 — the byte-key matrix: the same six keys, a bare base64 string and a
// data: URI render the same picture in every format
// ---------------------------------------------------------------------------

const BYTE_INPUTS = [
  ['as {data}', { data: PNG_B64 }],
  ['as {base64}', { base64: PNG_B64 }],
  ['as {bytes}', { bytes: PNG_B64 }],
  ['as {content}', { content: PNG_B64 }],
  ['as {buffer}', { buffer: PNG_B64 }],
  ['as {src}', { src: PNG_B64 }],
  ['as a bare base64 string', PNG_B64],
  ['as a data:image/png;base64 URI', PNG_URI],
];

for (const f of FORMATS) {
  for (const [label, value] of BYTE_INPUTS) {
    test(`AT-I1 ${f.id}: ${label} renders one image whose bytes equal the input PNG`, async () => {
      const data = f.baseData();
      data.logo = value;
      const out = await f.render(data, {});
      assert.equal(out.stats.images, 1);
      const media = mediaOf(out.buffer, f.mediaPrefix);
      assert.equal(media.length, 1, `expected exactly one media part, got ${media.length}`);
      assert.ok(media[0].equals(PNG), 'the embedded image bytes equal the input PNG');
    });
  }
}

// ---------------------------------------------------------------------------
// AT-I2 — the URL contract matrix: url/href/uri and a bare URL string are
// refused without the images option, satisfied by URL or by tag path with it
// ---------------------------------------------------------------------------

const URL_INPUTS = [
  ['as {url}', { url: URL }, { data: PNG_B64 }],
  ['as {href}', { href: URL }, PNG],
  ['as {uri}', { uri: URL }, PNG_B64],
  ['as a bare URL string', URL, PNG],
  // A file:// value in a byte key is a URL exactly like an https one — the
  // pre-contract DOCX renderer classified it so, and the shared resolver
  // keeps that behavior. Fourth element: the URL the images option keys on.
  ['as {data} holding a file:// URL', { data: FILE_URL }, PNG, FILE_URL],
];

for (const f of FORMATS) {
  for (const [label, value, supplied, urlKey = URL] of URL_INPUTS) {
    test(`AT-I2 ${f.id}: ${label} without the images option is refused with image_url_unsupported`, async () => {
      const data = f.baseData();
      data.logo = value;
      await assert.rejects(
        () => f.render(data, {}),
        (e) => {
          assert.ok(e instanceof TemplateError);
          assert.equal(e.code, 'image_url_unsupported');
          assert.equal(e.field, 'logo');
          return true;
        },
      );
    });

    test(`AT-I2 ${f.id}: ${label} with images keyed by the URL renders the supplied PNG`, async () => {
      const data = f.baseData();
      data.logo = value;
      const out = await f.render(data, { images: { [urlKey]: supplied } });
      assert.equal(out.stats.images, 1);
      const media = mediaOf(out.buffer, f.mediaPrefix);
      assert.equal(media.length, 1);
      assert.ok(media[0].equals(PNG), 'the embedded image bytes equal the supplied PNG');
    });

    test(`AT-I2 ${f.id}: ${label} with images keyed by the tag path renders the supplied PNG`, async () => {
      const data = f.baseData();
      data.logo = value;
      const out = await f.render(data, { images: { logo: { data: PNG_B64 } } });
      assert.equal(out.stats.images, 1);
      const media = mediaOf(out.buffer, f.mediaPrefix);
      assert.equal(media.length, 1);
      assert.ok(media[0].equals(PNG), 'the embedded image bytes equal the supplied PNG');
    });
  }

  test(`AT-I2 ${f.id}: a field absent from the data is supplied by images keyed by the tag path`, async () => {
    const data = f.baseData(); // no "logo" key at all
    const out = await f.render(data, { images: { logo: { data: PNG_B64 } } });
    assert.equal(out.stats.images, 1);
    const media = mediaOf(out.buffer, f.mediaPrefix);
    assert.equal(media.length, 1);
    assert.ok(media[0].equals(PNG), 'the embedded image bytes equal the supplied PNG');
  });
}

// ---------------------------------------------------------------------------
// AT-I3 — one resolver: the key lists live in src/render/image-input.js, the
// readback's IMAGE_BYTES_KEYS is derived from them, and no renderer keeps its
// own ad-hoc ?? chain
// ---------------------------------------------------------------------------

test('AT-I3 image-input.js exports the one contract', () => {
  assert.deepEqual(Object.keys(imageInput).sort(),
    ['DATA_KEYS', 'URL_KEYS', 'imagesEntry', 'imagesHas', 'resolveImageInput'].sort());
  assert.deepEqual(imageInput.DATA_KEYS, ['data', 'base64', 'bytes', 'content', 'buffer', 'src']);
  assert.deepEqual(imageInput.URL_KEYS, ['url', 'href', 'uri']);
  assert.equal(typeof imageInput.resolveImageInput, 'function');
});

test('AT-I3 codes.IMAGE_BYTES_KEYS is derived, not a second list', () => {
  assert.deepEqual(codes.IMAGE_BYTES_KEYS, [...imageInput.DATA_KEYS, ...imageInput.URL_KEYS]);
});

test('AT-I3 no renderer keeps an ad-hoc image key chain', () => {
  const chains = [/\.bytes \?\?/, /\.buffer \?\?/, /\.src \?\?/, /\.href \?\?/, /\.uri \?\?/, /\.base64 \?\?/];
  for (const file of ['docx.js', 'pptx.js', 'xlsx.js']) {
    const src = srcOf(file);
    for (const re of chains) {
      assert.ok(!re.test(src), `${file} still picks image keys with an ad-hoc chain matching ${re}`);
    }
  }
});

// ---------------------------------------------------------------------------
// The resolver's own rules, spelled out where the renderers only exercise them
// through fixtures
// ---------------------------------------------------------------------------

test('the resolver treats a plain string, Buffer and Uint8Array as {data: value}', () => {
  // A base64 string stays a string in src — the renderer's byte decoder reads it
  // as base64 — while Buffer and Uint8Array carry the raw bytes through.
  const str = imageInput.resolveImageInput(PNG_B64, 'logo', null);
  assert.equal(str.kind, 'bytes');
  assert.equal(str.src, PNG_B64);
  for (const raw of [PNG, new Uint8Array(PNG)]) {
    const r = imageInput.resolveImageInput(raw, 'logo', null);
    assert.equal(r.kind, 'bytes');
    assert.ok(Buffer.from(r.src).equals(PNG), 'the raw byte sources carry exactly the PNG bytes');
  }
});

test('the resolver takes the first present data key and reports width/height/alt', () => {
  const r = imageInput.resolveImageInput({ src: PNG_B64, width: 120, height: 40, alt: 'Logo' }, 'logo', null);
  assert.equal(r.kind, 'bytes');
  assert.equal(r.src, PNG_B64);
  assert.equal(r.width, 120);
  assert.equal(r.height, 40);
  assert.equal(r.alt, 'Logo');
});

test('the resolver resolves a URL first by URL, then by tag path, and never fetches', () => {
  const byUrl = imageInput.resolveImageInput({ url: URL }, 'logo', {
    [URL]: PNG, logo: { data: 'bm90IHRoZSBsb2dv' },
  });
  assert.equal(byUrl.kind, 'bytes');
  assert.ok(byUrl.src.equals(PNG));

  const byTag = imageInput.resolveImageInput({ url: URL }, 'logo', { logo: PNG });
  assert.equal(byTag.kind, 'bytes');
  assert.ok(byTag.src.equals(PNG));

  assert.throws(() => imageInput.resolveImageInput({ url: URL }, 'logo', null), (e) => {
    assert.ok(e instanceof TemplateError);
    assert.equal(e.code, 'image_url_unsupported');
    return true;
  });
});

test('the resolver reports "no image" for null, undefined and the empty string', () => {
  for (const v of [null, undefined, '']) {
    assert.deepEqual(imageInput.resolveImageInput(v, 'logo', null), { kind: 'none' });
  }
});

test('an http(s) or file: URL in a byte key is a URL, satisfied only through the images option', () => {
  const r = imageInput.resolveImageInput('https://example.com/x.png', 'logo', { [URL]: PNG });
  assert.ok(r.src.equals(PNG));
  const byFileUrl = imageInput.resolveImageInput({ data: FILE_URL }, 'logo', { [FILE_URL]: PNG });
  assert.equal(byFileUrl.kind, 'bytes');
  assert.ok(byFileUrl.src.equals(PNG));
  const bareFileUrl = imageInput.resolveImageInput(FILE_URL, 'logo', { logo: { data: PNG_B64 } });
  assert.equal(bareFileUrl.src, PNG_B64);
  assert.throws(() => imageInput.resolveImageInput({ data: FILE_URL }, 'logo', null), (e) => {
    assert.ok(e instanceof TemplateError);
    assert.equal(e.code, 'image_url_unsupported');
    return true;
  });
});

test('a data:image/png;base64 URI stays bytes for the decoder, unchanged', () => {
  const r = imageInput.resolveImageInput(PNG_URI, 'logo', null);
  assert.equal(r.kind, 'bytes');
  assert.equal(r.src, PNG_URI);
});
