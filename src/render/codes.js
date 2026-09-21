'use strict';

/**
 * QR codes, EPC payment QR codes, and Code 128 / EAN-13 barcodes as template
 * images, encoded and rasterised here — no external barcode library, no network.
 *
 * A caller sends {"qr": "text"}, {"barcode": "code128", "value": "…"},
 * {"barcode": "ean13", "value": "…"} or {"epc": {…}} anywhere a {%tag} image is
 * accepted, and this module turns it into PNG bytes plus a display size. The DOCX,
 * XLSX and PPTX renderers then embed those bytes exactly like a caller-supplied
 * PNG, so media parts, relationships and drawings behave identically.
 *
 * The QR encoder follows ISO/IEC 18004 byte mode (smallest version 1–40 at the
 * requested error correction, mask chosen by the four penalty rules). It is
 * checked module-for-module against an independent reference implementation —
 * test/helpers/qr-reference.json was produced with segno 1.6.6 and covers six
 * versions, all four ECC levels and every mask.
 */

const zlib = require('node:zlib');
const { TemplateError } = require('../template/errors');

// ---------------------------------------------------------------------------
// CRC-32 (PNG chunks) — table-based; node:20-bookworm-slim has no zlib.crc32.
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// PNG writer: 8-bit greyscale, black on white, one filter-0 row per row.
// ---------------------------------------------------------------------------

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/** shadeOf(x, y) returns 0 (black) to 255 (white). */
function pngFromGrey(width, height, shadeOf) {
  const raw = Buffer.alloc(height * (width + 1));
  let p = 0;
  for (let y = 0; y < height; y += 1) {
    raw[p] = 0; // filter "none": every PNG reader handles it
    p += 1;
    for (let x = 0; x < width; x += 1) {
      raw[p] = shadeOf(x, y) ? 255 : 0;
      p += 1;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // colour type 0: greyscale — smallest legal PNG for a code
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// QR Code tables (ISO/IEC 18004; error levels indexed L=0, M=1, Q=2, H=3).
// ---------------------------------------------------------------------------

const ECC_CODEWORDS_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28,
    28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26,
    26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26,
    30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26,
    28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

const NUM_ERROR_CORRECTION_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10,
    12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18,
    20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23,
    25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25,
    34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

// Centre coordinates of the alignment patterns for each version, 1–40.
const ALIGNMENT_POSITIONS = [
  null,
  [],
  [6, 18], [6, 22], [6, 26], [6, 30], [6, 34],
  [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50], [6, 30, 54], [6, 32, 58], [6, 34, 62],
  [6, 26, 46, 66], [6, 26, 48, 70], [6, 26, 50, 74], [6, 30, 54, 78], [6, 30, 56, 82],
  [6, 30, 58, 86], [6, 34, 62, 90],
  [6, 28, 50, 72, 94], [6, 26, 50, 74, 98], [6, 30, 54, 78, 102], [6, 28, 54, 80, 106],
  [6, 32, 58, 84, 110], [6, 30, 58, 86, 114], [6, 34, 62, 90, 118],
  [6, 26, 50, 74, 98, 122], [6, 30, 54, 78, 102, 126], [6, 26, 52, 78, 104, 130],
  [6, 30, 56, 82, 108, 134], [6, 34, 60, 86, 112, 138], [6, 30, 58, 86, 114, 142],
  [6, 34, 62, 90, 118, 146],
  [6, 30, 54, 78, 102, 126, 150], [6, 24, 50, 76, 102, 128, 154], [6, 28, 54, 80, 106, 132, 158],
  [6, 32, 58, 84, 110, 136, 162], [6, 26, 54, 82, 110, 138, 166], [6, 30, 58, 86, 114, 142, 170],
];

const ECC_INDEX = { L: 0, M: 1, Q: 2, H: 3 };
const ECC_NAME = ['L', 'M', 'Q', 'H'];
// The two format-information bits for each error level.
const ECC_FORMAT_BITS = [1, 0, 3, 2];

// Modules that take part in the symbol, before error correction is subtracted.
function numRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36; // version information areas
  }
  return result;
}

function numDataCodewords(version, eccIndex) {
  return Math.floor(numRawDataModules(version) / 8)
    - ECC_CODEWORDS_PER_BLOCK[eccIndex][version] * NUM_ERROR_CORRECTION_BLOCKS[eccIndex][version];
}

// ---------------------------------------------------------------------------
// Reed-Solomon over GF(256), polynomial 0x11D — byte-at-a-time arithmetic.
// ---------------------------------------------------------------------------

function rsMultiply(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}

// Generator polynomial of the given degree, coefficients without the leading term.
function rsDivisor(degree) {
  const result = new Array(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = rsMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = rsMultiply(root, 0x02);
  }
  return result;
}

function rsRemainder(data, divisor) {
  const result = new Array(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift();
    result.push(0);
    for (let i = 0; i < divisor.length; i += 1) result[i] ^= rsMultiply(divisor[i], factor);
  }
  return result;
}

// ---------------------------------------------------------------------------
// QR data bit stream: byte mode, terminator, 0xEC/0x11 padding.
// ---------------------------------------------------------------------------

function encodeDataCodewords(bytes, version, eccIndex) {
  const capacityBits = numDataCodewords(version, eccIndex) * 8;
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4); // byte mode
  push(bytes.length, version < 10 ? 8 : 16); // character count indicator
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length)); // terminator
  // Byte alignment: segno 1.6.6 extends by 8 - (len % 8) bits, never zero —
  // a whole zero codeword when the stream already ends on a codeword boundary.
  // The fixture was generated with segno, so the quirk is replicated exactly;
  // a decoder reads the padding region as padding either way.
  bits.push(...new Array(8 - (bits.length % 8)).fill(0));
  const padCount = Math.max(0, (capacityBits >> 3) - Math.ceil(bits.length / 8));
  for (let i = 0; i < padCount; i += 1) push(i % 2 === 0 ? 0xec : 0x11, 8);
  // A full symbol can overshoot by one codeword; segno's block builder never
  // reads it either, so anything past the capacity is dropped.
  const out = [];
  for (let i = 0; i + 8 <= Math.min(bits.length, capacityBits); i += 8) {
    out.push(bits.slice(i, i + 8).reduce((acc, b) => (acc << 1) | b, 0));
  }
  return out;
}

// Error-correction codewords per block, then blocks interleaved column by column.
function addEccAndInterleave(data, version, eccIndex) {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[eccIndex][version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[eccIndex][version];
  const rawCodewords = Math.floor(numRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);
  const divisor = rsDivisor(blockEccLen);

  const blocks = [];
  let k = 0;
  for (let i = 0; i < numBlocks; i += 1) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, divisor);
    // Short blocks line up with the long ones for interleaving via a pad slot;
    // the slot is skipped when the columns are read back off below.
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }
  const result = [];
  for (let i = 0; i < blocks[0].length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(blocks[j][i]);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// QR matrix construction.
// ---------------------------------------------------------------------------

const getBit = (value, i) => ((value >>> i) & 1) !== 0;

function newSymbol(version) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(false));
  const isFunction = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, dark) => { modules[y][x] = dark; isFunction[y][x] = true; };

  // Timing patterns.
  for (let i = 0; i < size; i += 1) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }

  // Finder patterns with their separators.
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx; const y = cy + dy;
        if (x >= 0 && x < size && y >= 0 && y < size) {
          const d = Math.max(Math.abs(dx), Math.abs(dy));
          set(x, y, d !== 2 && d !== 4);
        }
      }
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

  // Alignment patterns, except the three that would collide with a finder.
  const pos = ALIGNMENT_POSITIONS[version];
  for (let i = 0; i < pos.length; i += 1) {
    for (let j = 0; j < pos.length; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === pos.length - 1) || (i === pos.length - 1 && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  return { size, version, modules, isFunction, set };
}

// Format and version information areas are reserved as occupied before the
// data goes in, so neither the placement walk nor a data mask can touch them.
// They stay blank (light) while the masks are scored — ISO/IEC 18004 7.8 has
// the evaluation happen before the format information is added — and the real
// bits are drawn only once the winning mask is known.
function reserveInfoAreas(sym) {
  const size = sym.size;
  const reserve = (x, y) => { sym.modules[y][x] = false; sym.isFunction[y][x] = true; };
  // The two cells where the timing pattern crosses row/column 8 stay timing.
  for (let i = 0; i <= 8; i += 1) {
    if (i !== 6) { reserve(8, i); reserve(i, 8); }
  }
  for (let i = 0; i < 8; i += 1) reserve(size - 1 - i, 8);
  // Column 8, bottom-left copy; the last of those cells is the always-dark
  // module, whose value is only drawn with the format bits.
  for (let i = 1; i <= 8; i += 1) reserve(8, size - i);
  if (sym.version >= 7) {
    for (let a = 0; a < 3; a += 1) {
      for (let b = 0; b < 6; b += 1) { reserve(size - 11 + a, b); reserve(b, size - 11 + a); }
    }
  }
}

// 15 format bits: 2 error-level + 3 mask bits with a (15,5) BCH code, XOR 0x5412.
function drawFormatBits(sym, eccIndex, mask) {
  const size = sym.size;
  const data = (ECC_FORMAT_BITS[eccIndex] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  for (let i = 0; i <= 5; i += 1) sym.set(8, i, getBit(bits, i));
  sym.set(8, 7, getBit(bits, 6));
  sym.set(8, 8, getBit(bits, 7));
  sym.set(7, 8, getBit(bits, 8));
  for (let i = 9; i < 15; i += 1) sym.set(14 - i, 8, getBit(bits, i));
  for (let i = 0; i < 8; i += 1) sym.set(size - 1 - i, 8, getBit(bits, i));
  for (let i = 8; i < 15; i += 1) sym.set(8, size - 15 + i, getBit(bits, i));
  sym.set(8, size - 8, true); // the always-dark module
}

// 18 version bits for version >= 7: 6 bits with a (18,6) BCH code.
function drawVersion(sym) {
  const size = sym.size; const v = sym.version;
  if (v < 7) return;
  let rem = v;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (v << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const bit = getBit(bits, i);
    const a = size - 11 + (i % 3); const b = Math.floor(i / 3);
    sym.set(a, b, bit);
    sym.set(b, a, bit);
  }
}

// Codewords into the free modules, two columns at a time from the bottom right.
function drawCodewords(sym, data) {
  const size = sym.size;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip the vertical timing column
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!sym.isFunction[y][x] && i < data.length * 8) {
          sym.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
          i += 1;
        }
      }
    }
  }
}

const MASK_CONDITIONS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];

function applyMask(sym, mask) {
  const cond = MASK_CONDITIONS[mask];
  for (let y = 0; y < sym.size; y += 1) {
    for (let x = 0; x < sym.size; x += 1) {
      if (!sym.isFunction[y][x] && cond(x, y)) sym.modules[y][x] = !sym.modules[y][x];
    }
  }
}

// The four ISO/IEC 18004 penalty rules, N1–N4.
function penaltyScore(sym) {
  const size = sym.size; const m = sym.modules;
  let score = 0;

  // N1: runs of five or more equal modules in a row or column.
  const runs = (line) => {
    let run = 1;
    for (let i = 1; i <= line.length; i += 1) {
      if (i < line.length && line[i] === line[i - 1]) { run += 1; continue; }
      if (run >= 5) score += run - 2;
      run = 1;
    }
  };
  for (let y = 0; y < size; y += 1) runs(m[y]);
  for (let x = 0; x < size; x += 1) runs(m.map((row) => row[x]));

  // N2: 2x2 blocks of equal modules.
  for (let y = 0; y + 1 < size; y += 1) {
    for (let x = 0; x + 1 < size; x += 1) {
      if (m[y][x] === m[y][x + 1] && m[y][x] === m[y + 1][x] && m[y][x] === m[y + 1][x + 1]) score += 3;
    }
  }

  // N3: finder-like 1:1:3:1:1 patterns preceded or followed by four light
  // modules. The light-area check counts the modules that exist (a pattern
  // one module from the edge with two light ones before it qualifies, and a
  // pattern flush against the symbol edge always counts) — the same reading
  // of ISO/IEC 18004 table 11 the reference implementation uses, which is
  // what the auto-mask comparison in the test suite is settled against.
  const PATTERN = [1, 0, 1, 1, 1, 0, 1];
  const light = (line, from, to) => {
    for (let i = Math.max(from, 0); i < Math.min(to, size); i += 1) if (line[i]) return false;
    return true;
  };
  const finderLike = (line) => {
    for (let idx = 0; idx + 7 <= size;) {
      let found = -1;
      for (let i = idx; i + 7 <= size; i += 1) {
        let same = true;
        for (let k = 0; k < 7; k += 1) {
          if ((line[i + k] ? 1 : 0) !== PATTERN[k]) { same = false; break; }
        }
        if (same) { found = i; break; }
      }
      if (found === -1) return;
      const offset = found + 7;
      if (found === 0 || found === size - 7 || light(line, found - 4, found) || light(line, offset, offset + 4)) {
        score += 40;
        idx = offset;
      } else {
        idx = found + 4;
      }
    }
  };
  for (let y = 0; y < size; y += 1) finderLike(m[y]);
  for (let x = 0; x < size; x += 1) finderLike(m.map((row) => row[x]));

  // N4: the dark-module ratio, ten points per five-percent step away from 50%.
  let dark = 0;
  for (let y = 0; y < size; y += 1) for (let x = 0; x < size; x += 1) if (m[y][x]) dark += 1;
  return score + Math.floor(Math.abs(20 * dark - 10 * size * size) / (size * size)) * 10;
}

/**
 * Builds the module matrix for bytes at an error level. With version and mask
 * given they are forced (the reference fixture pins both); otherwise the smallest
 * fitting version 1–40 and the lowest-penalty mask are chosen. Rows come back as
 * strings of '0'/'1', '1' = dark, without the quiet zone — the fixture's shape.
 */
function qrMatrix(bytes, ecc, version, mask) {
  const e = ECC_INDEX[ecc];
  const v = version || qrVersionFor(bytes.length, e);
  const data = addEccAndInterleave(encodeDataCodewords(bytes, v, e), v, e);

  const sym = newSymbol(v);
  reserveInfoAreas(sym);
  drawCodewords(sym, data);

  let chosen = mask;
  if (chosen === undefined || chosen === null) {
    let best = -1; let bestScore = Infinity;
    for (let msk = 0; msk < 8; msk += 1) {
      applyMask(sym, msk);
      const score = penaltyScore(sym);
      if (score < bestScore) { bestScore = score; best = msk; }
      applyMask(sym, msk); // back out, the next candidate starts clean
    }
    chosen = best;
  }
  applyMask(sym, chosen);
  drawFormatBits(sym, e, chosen);
  drawVersion(sym);

  return sym.modules.map((row) => row.map((b) => (b ? '1' : '0')).join(''));
}

// The smallest version 1–40 whose byte-mode capacity holds nBytes at this level,
// or 0 when even version 40 cannot hold it.
function qrVersionFor(nBytes, eccIndex) {
  for (let v = 1; v <= 40; v += 1) {
    const headerBits = 4 + (v < 10 ? 8 : 16);
    if (headerBits + nBytes * 8 <= numDataCodewords(v, eccIndex) * 8) return v;
  }
  return 0;
}

// Byte-mode capacity of version 40 at a level, exposed for the qr_too_long error.
function qrMaxBytes(eccIndex) {
  return (numDataCodewords(40, eccIndex) * 8 - 4 - 16) / 8;
}

// ---------------------------------------------------------------------------
// Code 128.
// ---------------------------------------------------------------------------

// Bar/space widths for symbol values 0–105 (six digits, 11 modules) plus the
// stop pattern 106 (seven digits, 13 modules), from the Code 128 specification.
const CODE128_WIDTHS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
];

const CODE128_START_B = 104;
const CODE128_STOP = 106;

// Symbol values for a start-B symbol: start, one value per character (ASCII
// 32–126 maps to 0–94), the modulo-103 check symbol, and stop.
function code128Symbols(value) {
  const values = [CODE128_START_B];
  for (let i = 0; i < value.length; i += 1) values.push(value.charCodeAt(i) - 32);
  let check = CODE128_START_B;
  for (let i = 1; i < values.length; i += 1) check += i * values[i];
  values.push(check % 103, CODE128_STOP);
  return values;
}

// One long module row, '1' = bar, with the ten-module quiet zones included.
function code128Modules(value) {
  let row = '0'.repeat(10);
  for (const symbol of code128Symbols(value)) {
    const widths = CODE128_WIDTHS[symbol];
    for (let i = 0; i < widths.length; i += 1) row += (i % 2 === 0 ? '1' : '0').repeat(Number(widths[i]));
  }
  return row + '0'.repeat(10);
}

// ---------------------------------------------------------------------------
// EAN-13.
// ---------------------------------------------------------------------------

const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
const EAN_G = ['0100111', '0110011', '0011011', '0100001', '0011101', '0111001', '0000101', '0010001', '0001001', '0010111'];
const EAN_R = ['1110010', '1100110', '1101100', '1000010', '1011100', '1001110', '1010000', '1000100', '1001000', '1110100'];
// Odd/even parity of the six left digits, chosen by the first digit.
const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];

// The weighted check digit for the first twelve digits of an EAN-13.
function ean13CheckDigit(twelve) {
  let sum = 0;
  for (let i = 0; i < 12; i += 1) sum += Number(twelve[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

// Guard bars, L/G parity left, R right; quiet zone 11 modules left, 7 right.
function ean13Modules(digits) {
  const parity = EAN_PARITY[Number(digits[0])];
  let row = '0'.repeat(11) + '101';
  for (let i = 1; i <= 6; i += 1) row += (parity[i - 1] === 'L' ? EAN_L : EAN_G)[Number(digits[i])];
  row += '01010';
  for (let i = 7; i <= 12; i += 1) row += EAN_R[Number(digits[i])];
  return row + '101' + '0'.repeat(7);
}

// ---------------------------------------------------------------------------
// EPC "Girocode" payload (EPC069-12, SEPA Credit Transfer), QR at ECC M.
// ---------------------------------------------------------------------------

// ISO 7064 mod-97-10 on the rearranged IBAN, without ever echoing it back.
function ibanCheckDigitOk(iban) {
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

function epcInvalid(message, field, hint) {
  return new TemplateError('epc_invalid', message, { field, hint });
}

/** The payload string a banking app reads; throws epc_invalid with the reason. */
function buildEpcPayload(epc, field) {
  if (!epc || typeof epc !== 'object' || Array.isArray(epc) || Buffer.isBuffer(epc)) {
    throw epcInvalid(`{%${field}} "epc" must be an object like {"name": …, "iban": …, "amount": …}.`,
      field, 'Send {"epc": {"name": "Payee GmbH", "iban": "DE…", "amount": 12.34}}.');
  }
  for (const key of Object.keys(epc)) {
    if (!EPC_FIELDS.includes(key)) {
      throw epcInvalid(`{%${field}} "epc" has an unknown field "${key}".`,
        field, `Allowed "epc" fields: ${EPC_FIELDS.map((f) => `"${f}"`).join(', ')}.`);
    }
  }
  const missing = (name) => epc[name] === undefined || epc[name] === null || epc[name] === '';

  if (typeof epc.name !== 'string' || epc.name.length < 1 || epc.name.length > 70) {
    throw epcInvalid(`{%${field}} "epc.name" must be a string of 1 to 70 characters (got ${typeof epc.name === 'string' ? epc.name.length : 'none'}).`,
      field, 'The payee name goes into "epc.name", at most 70 characters.');
  }
  if (typeof epc.iban !== 'string' || epc.iban.length === 0) {
    throw epcInvalid(`{%${field}} "epc.iban" is required and must be a string.`,
      field, 'The IBAN goes into "epc.iban"; spaces are allowed.');
  }
  const iban = epc.iban.replace(/\s+/g, '').toUpperCase();
  // The IBAN itself never goes into an error message — only its length and
  // which check failed. It is bank account data.
  if (iban.length < 15 || iban.length > 34) {
    throw epcInvalid(`{%${field}} "epc.iban" is ${iban.length} characters without spaces; an IBAN is 15 to 34.`,
      field, 'Check the IBAN; its length is wrong.');
  }
  if (!/^[A-Z]{2}[0-9]{2}[A-Z0-9]+$/.test(iban)) {
    throw epcInvalid(`{%${field}} "epc.iban" must start with a two-letter country code and two check digits, followed by letters and digits only.`,
      field, 'Check the IBAN; it contains characters an IBAN cannot have.');
  }
  if (!ibanCheckDigitOk(iban)) {
    throw epcInvalid(`{%${field}} "epc.iban" (length ${iban.length}) failed its ISO 7064 mod-97 check digit.`,
      field, 'The IBAN check digits do not add up; re-check the number.');
  }
  if (!missing('bic') && (typeof epc.bic !== 'string' || ![8, 11].includes(epc.bic.length))) {
    throw epcInvalid(`{%${field}} "epc.bic" must be 8 or 11 characters (got ${typeof epc.bic === 'string' ? epc.bic.length : 'none'}).`,
      field, 'Leave "epc.bic" out or send the full 8 or 11 characters.');
  }

  let amountLine = '';
  if (!missing('amount')) {
    const a = epc.amount;
    if (typeof a !== 'number' || !Number.isFinite(a)) {
      throw epcInvalid(`{%${field}} "epc.amount" must be a number like 12.34.`,
        field, 'Send the amount as a number, in euro.');
    }
    if (a < 0.01 || a > 999999999.99) {
      throw epcInvalid(`{%${field}} "epc.amount" must be between 0.01 and 999999999.99.`,
        field, 'Send an amount inside the SEPA range.');
    }
    if (Math.abs(a * 100 - Math.round(a * 100)) > 1e-9) {
      throw epcInvalid(`{%${field}} "epc.amount" has more than two decimal places.`,
        field, 'Round the amount to whole cents.');
    }
    amountLine = `EUR${(Math.round(a * 100) / 100).toFixed(2)}`;
  }
  if (!missing('reference') && (typeof epc.reference !== 'string' || epc.reference.length > 35)) {
    throw epcInvalid(`{%${field}} "epc.reference" must be a string of at most 35 characters (got ${typeof epc.reference === 'string' ? epc.reference.length : 'none'}).`,
      field, 'Shorten the structured reference to 35 characters.');
  }
  if (!missing('text') && (typeof epc.text !== 'string' || epc.text.length > 140)) {
    throw epcInvalid(`{%${field}} "epc.text" must be a string of at most 140 characters (got ${typeof epc.text === 'string' ? epc.text.length : 'none'}).`,
      field, 'Shorten the text to 140 characters.');
  }
  if (!missing('reference') && !missing('text')) {
    throw epcInvalid(`{%${field}} "epc" carries both "reference" and "text"; a SEPA payment has one or the other, never both.`,
      field, 'Remove either "reference" (structured) or "text" (unstructured).');
  }

  // EPC069-12 v002 line order: service tag, version, character set, function,
  // BIC, name, IBAN, amount, purpose (always empty), then the structured
  // reference OR an empty reference line and the unstructured text. Lines past
  // the last non-empty one are omitted; there is no trailing newline.
  const lines = [
    'BCD', '002', '1', 'SCT',
    missing('bic') ? '' : epc.bic,
    epc.name,
    iban,
    amountLine,
    '',
    missing('reference') ? '' : epc.reference,
  ];
  if (missing('reference') && !missing('text')) lines.push(epc.text);
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Value shapes, sizes and rasterisation.
// ---------------------------------------------------------------------------

// The spec shapes this module accepts, shared between the branch functions
// below and the /v1/capabilities readback (codePlaceholders). The parity test
// (test/capabilities-parity.test.js) fails if a key or barcode kind here is
// missing from codePlaceholders(), or if a listed spec is not drawable.
const CODE_KEYS = ['qr', 'barcode', 'epc'];
const BARCODE_KINDS = ['code128', 'ean13'];
const EPC_FIELDS = ['name', 'iban', 'bic', 'amount', 'reference', 'text'];
// A plain QR defaults to error level M, and a SEPA payment code is always M.
const QR_DEFAULT_ECC = 'M';

// A barcode spec is validated before anything is rasterised.
function barcodeSpec(spec, field) {
  for (const key of Object.keys(spec)) {
    if (!['barcode', 'value', 'width', 'height', 'alt'].includes(key)) {
      throw imageInvalid(`{%${field}} has an unknown key "${key}" for a barcode spec.`,
        field, 'A barcode takes "barcode", "value", "width", "height" and "alt", nothing else.');
    }
  }
  if (!BARCODE_KINDS.includes(spec.barcode)) {
    throw new TemplateError('barcode_unsupported',
      `{%${field}} asks for barcode ${JSON.stringify(spec.barcode)}, which DocMint cannot draw.`,
      { field, hint: 'Use "code128" for ASCII text or "ean13" for a 12/13-digit article number.' });
  }
  const value = spec.value;
  if (spec.barcode === 'code128') {
    if (typeof value !== 'string' || value.length === 0 || value.length > 80) {
      throw new TemplateError('barcode_invalid',
        `{%${field}} needs a Code 128 "value" of 1 to 80 characters (got ${typeof value === 'string' ? value.length : 'none'}).`,
        { field, hint: 'Send {"barcode": "code128", "value": "INV-2026-0042"}.' });
    }
    for (let i = 0; i < value.length; i += 1) {
      const c = value.charCodeAt(i);
      if (c < 32 || c > 126) {
        throw new TemplateError('barcode_invalid',
          `{%${field}} has a character outside printable ASCII at position ${i} of its Code 128 "value" (character code ${c}; allowed are 32–126).`,
          { field, hint: 'Code 128 set B holds printable ASCII only — strip control characters and emoji.' });
      }
    }
    return { kind: 'code128', value };
  }
  if (typeof value !== 'string' || !/^\d{12,13}$/.test(value)) {
    throw new TemplateError('barcode_invalid',
      `{%${field}} needs an EAN-13 "value" of 12 digits (check digit added) or 13 (check digit verified), digits only.`,
      { field, hint: 'Send e.g. {"barcode": "ean13", "value": "400638133393"}.' });
  }
  if (value.length === 13) {
    const expected = ean13CheckDigit(value.slice(0, 12));
    if (Number(value[12]) !== expected) {
      throw new TemplateError('barcode_invalid',
        `{%${field}} has a wrong EAN-13 check digit — ${value.slice(0, 12)} expects ${expected}.`,
        { field, hint: 'Either fix the last digit or send only the first 12 digits.' });
    }
  }
  return { kind: 'ean13', value };
}

/** The branch point: one code spec in, PNG bytes plus display size out. */
function codeImage(spec, field) {
  // The mixed-key check runs first: an object that also carries image bytes is
  // neither an image nor a code, it is a mistake.
  for (const key of Object.keys(spec)) {
    if (IMAGE_BYTES_KEYS.includes(key)) {
      throw imageInvalid(`{%${field}} mixes a QR/barcode/EPC spec with image bytes ("${key}") — send one or the other.`,
        field, 'Either send image bytes as {"data": "<base64>"} or a code as {"qr": "text"}, not both in one object.');
    }
  }
  const codeKeys = Object.keys(spec).filter((k) => CODE_KEYS.includes(k));
  if (codeKeys.length !== 1) {
    throw imageInvalid(`{%${field}} carries more than one of "qr", "barcode" and "epc" (${codeKeys.map((k) => `"${k}"`).join(', ')}).`,
      field, 'One image tag draws one code; split the spec into separate tags.');
  }
  const kind = codeKeys[0];

  if (kind === 'epc') {
    // An "ecc" key on an EPC object is an EPC error, not a shape error: a SEPA
    // payment code is always error level M, and the docs say so.
    if (Object.prototype.hasOwnProperty.call(spec, 'ecc')) {
      throw epcInvalid(`{%${field}} has an "ecc" key — an EPC payment QR code is always error level M.`,
        field, 'Remove "ecc" from the EPC object.');
    }
    for (const key of Object.keys(spec)) {
      if (!['epc', 'width', 'height', 'alt'].includes(key)) {
        throw imageInvalid(`{%${field}} has an unknown key "${key}" for an EPC payment code spec.`,
          field, 'An EPC code takes "epc", "width", "height" and "alt", nothing else.');
      }
    }
    const payload = buildEpcPayload(spec.epc, field);
    const out = qrPng(Buffer.from(payload, 'utf8'), ECC_INDEX[QR_DEFAULT_ECC], px(spec.width), px(spec.height));
    out.alt = typeof spec.alt === 'string' ? spec.alt : undefined;
    return out;
  }

  if (kind === 'qr') {
    const { text, ecc } = qrSpec(spec, field);
    const bytes = Buffer.from(text, 'utf8');
    const e = ECC_INDEX[ecc];
    if (!qrVersionFor(bytes.length, e)) {
      throw new TemplateError('qr_too_long',
        `{%${field}} is ${bytes.length} bytes of QR text; at error level "${ecc}" a QR code holds at most ${Math.floor(qrMaxBytes(e))} bytes.`,
        { field, hint: 'Shorten the text or lower "ecc" towards "L", which fits the most.' });
    }
    const out = qrPng(bytes, e, px(spec.width), px(spec.height));
    out.alt = typeof spec.alt === 'string' ? spec.alt : undefined;
    return out;
  }

  const { kind: bc, value } = barcodeSpec(spec, field);
  const row = bc === 'code128' ? code128Modules(value) : ean13Modules(value.length === 12 ? value + ean13CheckDigit(value) : value);
  const out = barcodePng(row, px(spec.width), px(spec.height));
  out.alt = typeof spec.alt === 'string' ? spec.alt : undefined;
  return out;
}

const IMAGE_BYTES_KEYS = ['data', 'base64', 'bytes', 'content', 'buffer', 'src', 'url', 'href', 'uri'];

/** True for a plain object carrying one of the code keys — never for bytes. */
function isCodeSpec(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Buffer.isBuffer(value) || value instanceof Uint8Array) return false;
  return Object.keys(value).some((k) => CODE_KEYS.includes(k));
}

/**
 * The code placeholders this module draws, read out of the same constants the
 * branch functions above validate against. This one list serves both the
 * render path and the published /v1/capabilities readback, so a placeholder
 * cannot ship undocumented or be documented undrawn — the drift the
 * honest-claims rule exists to prevent.
 */
function codePlaceholders() {
  const eccLevels = Object.keys(ECC_INDEX).map((l) => `"${l}"`).join(', ');
  return [
    {
      key: 'qr',
      spec: { qr: 'text', ecc: QR_DEFAULT_ECC },
      does: `a QR code of the text (ISO/IEC 18004, Model 2, byte mode); "ecc" is one of ${eccLevels}, default "${QR_DEFAULT_ECC}"`,
    },
    {
      key: 'barcode',
      barcode: 'code128',
      spec: { barcode: 'code128', value: 'INV-2026-0042' },
      does: 'a Code 128 barcode of the value: 1 to 80 characters of printable ASCII (32-126)',
    },
    {
      key: 'barcode',
      barcode: 'ean13',
      spec: { barcode: 'ean13', value: '400638133393' },
      does: 'an EAN-13 barcode of 12 digits (the check digit is computed) or 13 (the thirteenth is checked)',
    },
    {
      key: 'epc',
      spec: { epc: { name: 'Payee GmbH', iban: 'DE02 1001 0010 9307 1186 03', amount: 12.34 } },
      does: `a SEPA Credit Transfer QR (EPC069-12 "Girocode"), always error level ${QR_DEFAULT_ECC}; the "epc" object takes ${EPC_FIELDS.map((f) => `"${f}"`).join(', ')}`,
    },
  ];
}

// Display sizes come from the caller in px at 96 DPI, strings like "120px" allowed.
function px(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/px$/i, ''));
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

// PNG width in px: module scale s, whole symbol incl. quiet zones, sharp at any size.
function moduleScale(displayWidth, modules) {
  return Math.max(1, Math.min(Math.ceil((3 * displayWidth) / modules), 8, Math.floor(2400 / modules)));
}

function imageInvalid(message, field, hint) {
  return new TemplateError('image_invalid', message, { field, hint });
}

function qrSpec(spec, field) {
  for (const key of Object.keys(spec)) {
    if (!['qr', 'ecc', 'width', 'height', 'alt'].includes(key)) {
      throw imageInvalid(`{%${field}} has an unknown key "${key}" for a QR code spec.`,
        field, 'A QR code takes "qr", "ecc", "width", "height" and "alt", nothing else.');
    }
  }
  if (typeof spec.qr !== 'string' || spec.qr.length === 0) {
    throw new TemplateError('qr_invalid', `{%${field}} needs a non-empty string in "qr" — that text goes into the code.`,
      { field, hint: 'Send {"qr": "https://example.com/pay/123"}.' });
  }
  const ecc = spec.ecc === undefined || spec.ecc === null ? QR_DEFAULT_ECC : spec.ecc;
  if (typeof ecc !== 'string' || !Object.hasOwn(ECC_INDEX, ecc)) {
    throw new TemplateError('qr_invalid', `{%${field}} has an unknown "ecc" — use "L", "M", "Q" or "H".`,
      { field, hint: 'Error correction is "L", "M", "Q" or "H"; the default is "M".' });
  }
  return { text: spec.qr, ecc };
}

function qrPng(bytes, e, displayW, displayH) {
  const w = displayW || displayH || 150;
  const h = displayW && displayH ? displayH : w;
  const matrix = qrMatrix(bytes, ECC_NAME[e]);
  const modules = matrix.length + 8; // four-module quiet zone each side
  const s = moduleScale(w, modules);
  const pxW = modules * s;
  return {
    png: pngFromGrey(pxW, pxW, (x, y) => {
      const mx = Math.floor(x / s) - 4;
      const my = Math.floor(y / s) - 4;
      return !(mx >= 0 && my >= 0 && mx < matrix.length && my < matrix.length) || matrix[my][mx] === '0';
    }),
    width: w, height: h,
  };
}

function barcodePng(row, displayW, displayH) {
  const modules = row.length;
  const naturalW = modules * 2;
  let w = displayW;
  let h = displayH;
  if (!w && !h) { w = naturalW; h = 60; } else if (w && !h) {
    h = Math.max(1, Math.round((60 * w) / naturalW));
  } else if (!w && h) {
    w = Math.max(1, Math.round((naturalW * h) / 60));
  }
  const s = moduleScale(w, modules);
  const pxW = modules * s;
  // The display aspect ratio carries into the pixel height, so the code keeps
  // its proportions even when the caller stretches the display size.
  const pxH = Math.min(2400, Math.max(1, Math.round((h * pxW) / w)));
  return {
    png: pngFromGrey(pxW, pxH, (x) => row[Math.min(modules - 1, Math.floor(x / s))] === '0'),
    width: w, height: h,
  };
}

module.exports = {
  isCodeSpec, // (value) -> boolean; the renderers gate on this before image bytes
  codeImage, // (spec, tagPath) -> { png, width, height, alt } or a TemplateError
  codePlaceholders, // () -> the published list of code placeholders, from the same constants the validators above use
  IMAGE_BYTES_KEYS, // the keys that mark an object as image bytes (each renderer reads its own subset); shared with the readback
  CODE_KEYS, // the code spec keys the validators accept; the parity test checks codePlaceholders() covers them
  BARCODE_KINDS, // the barcode kinds barcodeSpec accepts; same check
  // Everything below exists for the test suite (test/codes.test.js).
  qrMatrix, // (bytes, ecc, version?, mask?) -> rows of '0'/'1', no quiet zone
  qrVersionFor,
  code128Symbols, // (value) -> [start, ...data, check, stop]
  code128Modules, // (value) -> full module row incl. quiet zones, '1' = bar
  ean13CheckDigit, // (first12 digits) -> digit
  ean13Modules, // (13 digits) -> full module row incl. quiet zones
  buildEpcPayload, // (epc, tagPath) -> the EPC069-12 string banking apps read
};
