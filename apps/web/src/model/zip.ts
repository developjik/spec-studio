/**
 * A handoff zip, built by hand (F4). Six files, no compression — the package
 * is small and a STORE-method zip is a fixed byte layout, which is what makes
 * a re-export byte-identical: same entries in, same zip out. Timestamps are
 * pinned to a fixed DOS date for the same reason.
 */

export interface ZipEntry {
  name: string;
  data: Uint8Array;
}

const DOS_DATE = (1980 << 9) | (1 << 5) | 1; // 1980-01-01 — the epoch zips know
const DOS_TIME = 0;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function buildZip(entries: readonly ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = encoder.encode(entry.name);
    const crc = crc32(entry.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true); // local file header
    view.setUint16(4, 20, true); // version needed
    view.setUint16(6, 0x0800, true); // UTF-8 names
    view.setUint16(8, 0, true); // STORE
    view.setUint16(10, DOS_TIME, true);
    view.setUint16(12, DOS_DATE, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, entry.data.length, true);
    view.setUint32(22, entry.data.length, true);
    view.setUint16(26, name.length, true);
    view.setUint16(28, 0, true);
    local.set(name, 30);
    chunks.push(local, entry.data);

    const record = new Uint8Array(46 + name.length);
    const cview = new DataView(record.buffer);
    cview.setUint32(0, 0x02014b50, true); // central directory header
    cview.setUint16(4, 20, true);
    cview.setUint16(6, 20, true);
    cview.setUint16(8, 0x0800, true);
    cview.setUint16(10, 0, true);
    cview.setUint16(12, DOS_TIME, true);
    cview.setUint16(14, DOS_DATE, true);
    cview.setUint32(16, crc, true);
    cview.setUint32(20, entry.data.length, true);
    cview.setUint32(24, entry.data.length, true);
    cview.setUint16(28, name.length, true);
    cview.setUint32(42, offset, true);
    record.set(name, 46);
    central.push(record);
    offset += local.length + entry.data.length;
  }

  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const eview = new DataView(end.buffer);
  eview.setUint32(0, 0x06054b50, true); // end of central directory
  eview.setUint16(8, entries.length, true);
  eview.setUint16(10, entries.length, true);
  eview.setUint32(12, centralSize, true);
  eview.setUint32(16, offset, true);

  const size = offset + centralSize + end.length;
  const zip = new Uint8Array(size);
  let cursor = 0;
  for (const part of [...chunks, ...central, end]) {
    zip.set(part, cursor);
    cursor += part.length;
  }
  return zip;
}
