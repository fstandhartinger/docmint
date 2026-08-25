#!/usr/bin/env node
'use strict';
/**
 * Writes examples/logo.png — the mark used by {%logo} in the invoice and by the
 * deck's title slide.
 *
 * It is generated rather than committed as an opaque binary so that anyone can
 * see what is in it: a rounded navy tile, three ascending bars, one gold accent.
 * No image library is involved; a PNG is a header, one zlib stream of
 * filter-prefixed scanlines, and a CRC per chunk.
 */
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 192;                     // canvas, square
const px = new Uint8Array(S * S * 4);

const NAVY = [18, 57, 91];
const WHITE = [255, 255, 255];
const GOLD = [200, 155, 60];

/** Coverage of a pixel by a rounded rectangle, sampled 4x4 for smooth edges. */
function roundRectCoverage(x, y, rx, ry, rw, rh, r) {
  let hits = 0;
  for (let sy = 0; sy < 4; sy += 1) {
    for (let sx = 0; sx < 4; sx += 1) {
      const px0 = x + (sx + 0.5) / 4;
      const py0 = y + (sy + 0.5) / 4;
      if (px0 < rx || px0 > rx + rw || py0 < ry || py0 > ry + rh) continue;
      const cx = Math.min(Math.max(px0, rx + r), rx + rw - r);
      const cy = Math.min(Math.max(py0, ry + r), ry + rh - r);
      const dx = px0 - cx;
      const dy = py0 - cy;
      if (dx * dx + dy * dy <= r * r) hits += 1;
    }
  }
  return hits / 16;
}

function paint(rx, ry, rw, rh, r, colour, alpha = 1) {
  for (let y = 0; y < S; y += 1) {
    for (let x = 0; x < S; x += 1) {
      const cov = roundRectCoverage(x, y, rx, ry, rw, rh, r) * alpha;
      if (cov <= 0) continue;
      const i = (y * S + x) * 4;
      const dstA = px[i + 3] / 255;
      const outA = cov + dstA * (1 - cov);
      for (let c = 0; c < 3; c += 1) {
        const src = colour[c] / 255;
        const dst = px[i + c] / 255;
        px[i + c] = Math.round(((src * cov + dst * dstA * (1 - cov)) / outA) * 255);
      }
      px[i + 3] = Math.round(outA * 255);
    }
  }
}

// Tile, then three ascending bars, then the gold accent that breaks the grid.
paint(0, 0, 192, 192, 38, NAVY);
paint(40, 116, 24, 40, 6, WHITE, 0.55);
paint(76, 88, 24, 68, 6, WHITE, 0.78);
paint(112, 52, 24, 104, 6, WHITE, 1);
paint(112, 30, 24, 14, 5, GOLD, 1);

function chunk(type, body) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length);
  const td = Buffer.concat([Buffer.from(type, 'latin1'), body]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td) >>> 0);
  return Buffer.concat([len, td, crc]);
}

let TABLE = null;
function crc32(buf) {
  if (!TABLE) {
    TABLE = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      TABLE[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ -1;
}

const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y += 1) {
  raw[y * (S * 4 + 1)] = 0;
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0);
ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
]);

const out = path.join(__dirname, '..', 'logo.png');
fs.writeFileSync(out, png);
process.stdout.write(`${out} (${png.length} bytes, ${S}x${S})\n`);
