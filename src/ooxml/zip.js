'use strict';

const zlib = require('node:zlib');

/**
 * A minimal zip reader/writer for OOXML packages.
 *
 * Written rather than depended on for two reasons. The first is that the n8n node
 * must have zero runtime dependencies and it felt right for the API to be nearly as
 * spare. The second is the one that actually matters: an OOXML package is not just
 * "a zip". Excel in particular is unforgiving about the package it is handed, and a
 * general-purpose zip library that helpfully re-compresses every entry, reorders
 * them, or converts a STORED entry to DEFLATED will produce a file that Word opens
 * and Excel refuses. So the rule here is: entries we did not touch are copied
 * through byte-for-byte, in their original order, with their original compression
 * method and their original CRC.
 *
 * Supports: deflate + store, Zip64 end-of-central-directory on read, data
 * descriptors. Does not support: encryption, multi-disk archives. Neither occurs
 * in an Office document.
 */

const LOCAL_SIG = 0x04034b50;
const CD_SIG = 0x02014b50;
const EOCD_SIG = 0x06054b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;

class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; }
}

/**
 * @returns {{entries: Array, byName: Map}} entries keep `raw` — the exact
 * compressed bytes from the source — so an untouched entry can be re-emitted
 * without ever being decompressed and recompressed.
 */
function readZip(buf) {
  if (!Buffer.isBuffer(buf)) throw new ZipError('expected a Buffer');
  if (buf.length < 22) throw new ZipError('file is too small to be a zip archive');

  const eocdOff = findEOCD(buf);
  if (eocdOff === -1) {
    throw new ZipError('no zip end-of-central-directory record found — this is not an Office file');
  }

  let cdOffset = buf.readUInt32LE(eocdOff + 16);
  let cdCount = buf.readUInt16LE(eocdOff + 10);

  // Zip64: the 32-bit fields are saturated and the real values live in the
  // Zip64 EOCD, found through the locator that sits just before the EOCD.
  if (cdOffset === 0xffffffff || cdCount === 0xffff) {
    const locOff = eocdOff - 20;
    if (locOff < 0 || buf.readUInt32LE(locOff) !== ZIP64_LOCATOR_SIG) {
      throw new ZipError('zip64 archive without a locator record');
    }
    const z64Off = Number(buf.readBigUInt64LE(locOff + 8));
    if (buf.readUInt32LE(z64Off) !== ZIP64_EOCD_SIG) throw new ZipError('bad zip64 end-of-central-directory');
    cdCount = Number(buf.readBigUInt64LE(z64Off + 32));
    cdOffset = Number(buf.readBigUInt64LE(z64Off + 48));
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < cdCount; i += 1) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CD_SIG) {
      throw new ZipError(`central directory entry ${i} is malformed`);
    }
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const time = buf.readUInt16LE(p + 12);
    const date = buf.readUInt16LE(p + 14);
    let crc = buf.readUInt32LE(p + 16);
    let compSize = buf.readUInt32LE(p + 20);
    let uncompSize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const internalAttrs = buf.readUInt16LE(p + 36);
    const externalAttrs = buf.readUInt32LE(p + 38);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const extra = buf.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen);

    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localOffset === 0xffffffff) {
      const z = readZip64Extra(extra, { uncompSize, compSize, localOffset });
      uncompSize = z.uncompSize; compSize = z.compSize; localOffset = z.localOffset;
    }

    // The local header repeats the name/extra with possibly different lengths, so
    // the data offset must be computed from the local header, not the central one.
    if (buf.readUInt32LE(localOffset) !== LOCAL_SIG) throw new ZipError(`bad local header for "${name}"`);
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;

    entries.push({
      name, method, flags, time, date, crc,
      compSize, uncompSize, internalAttrs, externalAttrs,
      extra: Buffer.from(extra),
      raw: buf.subarray(dataStart, dataStart + compSize),
      dirty: false,
      data: null,
    });
    p += 46 + nameLen + extraLen + commentLen;
  }

  const byName = new Map(entries.map((e) => [e.name, e]));
  return { entries, byName };
}

function readZip64Extra(extra, cur) {
  let q = 0;
  const out = { ...cur };
  while (q + 4 <= extra.length) {
    const id = extra.readUInt16LE(q);
    const size = extra.readUInt16LE(q + 2);
    if (id === 0x0001) {
      let r = q + 4;
      if (out.uncompSize === 0xffffffff) { out.uncompSize = Number(extra.readBigUInt64LE(r)); r += 8; }
      if (out.compSize === 0xffffffff) { out.compSize = Number(extra.readBigUInt64LE(r)); r += 8; }
      if (out.localOffset === 0xffffffff) { out.localOffset = Number(extra.readBigUInt64LE(r)); r += 8; }
      return out;
    }
    q += 4 + size;
  }
  throw new ZipError('zip64 sizes are marked present but the extra field is missing');
}

/** The EOCD is at the end, but a trailing comment may push it up to 64 KB back. */
function findEOCD(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i -= 1) {
    if (buf.readUInt32LE(i) === EOCD_SIG) return i;
  }
  return -1;
}

/** Decompresses one entry. Cached, because a part is often read then written. */
function readEntry(entry) {
  if (entry.data) return entry.data;
  let out;
  if (entry.method === 0) out = Buffer.from(entry.raw);
  else if (entry.method === 8) out = zlib.inflateRawSync(entry.raw);
  else throw new ZipError(`"${entry.name}" uses compression method ${entry.method}, which is not supported`);
  if (out.length !== entry.uncompSize && entry.uncompSize !== 0) {
    throw new ZipError(`"${entry.name}" decompressed to ${out.length} bytes but the directory says ${entry.uncompSize}`);
  }
  entry.data = out;
  return out;
}

const readText = (entry) => readEntry(entry).toString('utf8');

/** Marks an entry changed. Only changed entries are recompressed on write. */
function writeEntry(entry, data) {
  entry.data = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
  entry.dirty = true;
}

function addEntry(zip, name, data, { method = 8 } = {}) {
  const existing = zip.byName.get(name);
  if (existing) { writeEntry(existing, data); return existing; }
  const now = dosDateTime(new Date());
  const entry = {
    name, method, flags: 0, time: now.time, date: now.date, crc: 0,
    compSize: 0, uncompSize: 0, internalAttrs: 0, externalAttrs: 0,
    extra: Buffer.alloc(0), raw: null, dirty: true,
    data: Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'),
  };
  zip.entries.push(entry);
  zip.byName.set(name, entry);
  return entry;
}

function removeEntry(zip, name) {
  const idx = zip.entries.findIndex((e) => e.name === name);
  if (idx === -1) return false;
  zip.entries.splice(idx, 1);
  zip.byName.delete(name);
  return true;
}

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/**
 * Writes the package back out. Untouched entries keep their original compressed
 * bytes, CRC, method and order; only entries marked dirty are recompressed.
 */
function writeZip(zip) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of zip.entries) {
    let method = e.method;
    let raw = e.raw;
    let crc = e.crc;
    let uncompSize = e.uncompSize;

    if (e.dirty) {
      const data = e.data;
      uncompSize = data.length;
      crc = crc32(data);
      // Level 6 is what Word itself writes; going higher costs measurable time on
      // a large deck for a percent or two of size.
      const deflated = zlib.deflateRawSync(data, { level: 6 });
      if (deflated.length < data.length) { method = 8; raw = deflated; } else { method = 0; raw = data; }
    }

    const nameBuf = Buffer.from(e.name, 'utf8');
    // Flags are rewritten: the data-descriptor bit (8) must not survive, because
    // we always write the sizes into the local header.
    const flags = (e.flags & ~0x08) | (isAscii(e.name) ? 0 : 0x0800);

    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(LOCAL_SIG, 0);
    local.writeUInt16LE(20, 4);            // version needed
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(e.time, 10);
    local.writeUInt16LE(e.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(raw.length, 18);
    local.writeUInt32LE(uncompSize, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);            // extra dropped: it described the old layout
    nameBuf.copy(local, 30);

    locals.push(local, raw);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(CD_SIG, 0);
    central.writeUInt16LE(20, 4);          // version made by
    central.writeUInt16LE(20, 6);          // version needed
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(e.time, 12);
    central.writeUInt16LE(e.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(raw.length, 20);
    central.writeUInt32LE(uncompSize, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);          // comment
    central.writeUInt16LE(0, 34);          // disk
    central.writeUInt16LE(e.internalAttrs, 36);
    central.writeUInt32LE(e.externalAttrs, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centrals.push(central);

    offset += local.length + raw.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(zip.entries.length, 8);
  eocd.writeUInt16LE(zip.entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, cd, eocd]);
}

const isAscii = (s) => !/[^\x00-\x7f]/.test(s);

module.exports = { readZip, writeZip, readEntry, readText, writeEntry, addEntry, removeEntry, crc32, ZipError };
