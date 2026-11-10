/** Test-only zip writer that can also emit deliberately malformed archives. */
import { deflateRawSync } from 'node:zlib';
import { crc32 } from '../course-bundle-zip.js';

export interface ZipEntrySpec {
  name: string;
  data?: Uint8Array | string;
  /** 0 stored (default for tiny data is deflate), 8 deflate. */
  method?: 0 | 8 | number;
  flags?: number;
  /** Version made by: host in the high byte (3 = Unix). */
  madeBy?: number;
  /** External attributes. */
  external?: number;
  /** Override the CRC, declared sizes and local header name for lying archives. */
  crc?: number;
  size?: number;
  compressed?: number;
  localName?: string;
  /** Already-compressed bytes to place as-is. */
  raw?: Uint8Array;
}

const bytesOf = (data: Uint8Array | string | undefined) =>
  typeof data === 'string'
    ? Buffer.from(data, 'utf8')
    : Buffer.from(data ?? new Uint8Array());

export interface ZipLayout {
  bytes: Buffer;
  eocd: number;
  cdOffset: number;
  cdSize: number;
  locals: number[];
  centrals: number[];
}

export function buildZipLayout(
  entries: ZipEntrySpec[],
  options: { comment?: Uint8Array | string } = {},
): ZipLayout {
  const parts: Buffer[] = [];
  const locals: number[] = [];
  const centralRecords: Buffer[] = [];
  let offset = 0;
  const staged = entries.map((entry) => {
    const data = bytesOf(entry.data);
    const method = entry.method ?? 8;
    const payload = entry.raw
      ? Buffer.from(entry.raw)
      : method === 8
        ? deflateRawSync(data)
        : data;
    return { entry, data, method, payload };
  });
  for (const { entry, data, method, payload } of staged) {
    const name = Buffer.from(entry.name, 'utf8');
    const localName = Buffer.from(entry.localName ?? entry.name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE((entry.flags ?? 0) | 0x800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(entry.crc ?? crc32(data), 14);
    local.writeUInt32LE(entry.compressed ?? payload.length, 18);
    local.writeUInt32LE(entry.size ?? data.length, 22);
    local.writeUInt16LE(localName.length, 26);
    locals.push(offset);
    parts.push(local, localName, payload);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(entry.madeBy ?? 20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE((entry.flags ?? 0) | 0x800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(entry.crc ?? crc32(data), 16);
    central.writeUInt32LE(entry.compressed ?? payload.length, 20);
    central.writeUInt32LE(entry.size ?? data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(entry.external ?? 0, 38);
    central.writeUInt32LE(offset, 42);
    centralRecords.push(Buffer.concat([central, name]));
    offset += 30 + localName.length + payload.length;
  }
  const cdOffset = offset;
  const centrals: number[] = [];
  let at = cdOffset;
  for (const record of centralRecords) {
    centrals.push(at);
    at += record.length;
  }
  const cd = Buffer.concat(centralRecords);
  const comment = bytesOf(options.comment);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(cdOffset, 16);
  end.writeUInt16LE(comment.length, 20);
  const bytes = Buffer.concat([...parts, cd, end, comment]);
  return {
    bytes,
    eocd: cdOffset + cd.length,
    cdOffset,
    cdSize: cd.length,
    locals,
    centrals,
  };
}

export const buildZip = (
  entries: ZipEntrySpec[],
  options: { comment?: Uint8Array | string } = {},
) => buildZipLayout(entries, options).bytes;

/** A small valid PDF; `encrypted` adds the trailer entry real encrypted PDFs carry. */
export function tinyPdf(label: string, encrypted = false): Buffer {
  return Buffer.from(
    `%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n% ${label}\ntrailer\n<< /Root 1 0 R${encrypted ? ' /Encrypt 5 0 R' : ''} >>\n%%EOF\n`,
    'latin1',
  );
}
export const PNG = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0,
]);
export const tinyPng = (marker: number) =>
  Buffer.concat([PNG, Buffer.from([marker])]);

/** Deterministic PRNG for the seeded mutation test. */
export function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
