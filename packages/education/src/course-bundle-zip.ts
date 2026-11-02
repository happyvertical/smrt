/**
 * Bounded zip reader for untrusted course bundles (SMRT #4578). Reads the End
 * Of Central Directory and central directory, validates every offset and size
 * against the real buffer, inflates with a hard output cap and checks CRC32.
 * Stored and deflate only; zip64, multi-disk, encryption and symlinks are
 * refused with typed reasons. Nothing here touches the filesystem.
 */
import {
  COURSE_BUNDLE_LIMITS,
  type CourseBundleLimits,
  type CourseBundleRefusalReason,
  CourseBundleRefusedError,
} from './course-bundle-contracts.js';

const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_SIZE = 22;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const MAX_COMMENT = 0xffff;

/** One member read from an archive or file set, before classification. */
export interface RawBundleMember {
  /** Normalised, validated path. */
  path: string;
  size: number;
  /** Null only when the member was refused as oversize and never inflated. */
  bytes: Uint8Array | null;
  sha256: string | null;
  /** Set when the member was understood but not inflated. */
  refusal: 'entry_too_large' | null;
}

function node() {
  const get = (typeof process !== 'undefined' && process.getBuiltinModule) as
    | ((id: string) => unknown)
    | false;
  if (!get) throw new Error('Course bundle import requires a Node server');
  return {
    zlib: get('node:zlib') as typeof import('node:zlib'),
    crypto: get('node:crypto') as typeof import('node:crypto'),
  };
}

export function sha256Hex(bytes: Uint8Array | string): string {
  return node().crypto.createHash('sha256').update(bytes).digest('hex');
}

let crcTable: Uint32Array | undefined;
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++)
    crc = (crcTable[(crc ^ bytes[i]) & 0xff] as number) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const refuse = (reason: CourseBundleRefusalReason, entry?: string): never => {
  throw new CourseBundleRefusedError(reason, entry);
};

const FORBIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: refusing control characters in names
  /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/;
/** True when the string has no lone UTF-16 surrogates. */
export function isWellFormedString(value: string): boolean {
  return !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(
    value,
  );
}

/**
 * Normalise and validate an entry or file name. Backslashes become `/`; empty,
 * `.` and `..` segments, absolute and drive-letter paths, `:` anywhere, NUL and
 * other control or bidi characters, over-long or over-deep paths are refused.
 * A trailing `/` (directory) is stripped and reported.
 */
export function normalizeBundlePath(
  raw: unknown,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
): { path: string; directory: boolean } {
  if (typeof raw !== 'string' || raw.length === 0)
    return refuse('invalid_path');
  if (!isWellFormedString(raw) || FORBIDDEN.test(raw))
    return refuse('invalid_path');
  const text = raw.replaceAll('\\', '/');
  if (
    Buffer.byteLength(text) > limits.maxPathBytes ||
    text.startsWith('/') ||
    /^[A-Za-z]:/.test(text) ||
    text.includes(':')
  )
    return refuse('invalid_path');
  const directory = text.endsWith('/');
  const segments = (directory ? text.slice(0, -1) : text).split('/');
  for (const segment of segments)
    if (
      segment === '' ||
      segment === '.' ||
      segment === '..' ||
      Buffer.byteLength(segment) > limits.maxSegmentBytes
    )
      return refuse('invalid_path');
  if (segments.length > limits.maxPathDepth) return refuse('path_too_deep');
  return { path: segments.join('/'), directory };
}

/** Case- and normalisation-insensitive identity used to refuse colliding names. */
export const bundleNameKey = (path: string) =>
  path.normalize('NFC').toLowerCase();

interface CentralEntry {
  name: string;
  rawName: Uint8Array;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  localOffset: number;
  directory: boolean;
}

function findEndRecord(bytes: Uint8Array, view: DataView): number {
  const low = Math.max(0, bytes.length - EOCD_SIZE - MAX_COMMENT);
  const candidates: number[] = [];
  for (let i = bytes.length - EOCD_SIZE; i >= low; i--) {
    if (view.getUint32(i, true) !== SIG_EOCD) continue;
    // The comment must run exactly to the end of the file, so a record forged
    // inside a comment can only count if it also fits; two fits are ambiguous.
    if (i + EOCD_SIZE + view.getUint16(i + 20, true) === bytes.length)
      candidates.push(i);
  }
  if (candidates.length === 0)
    return refuse(
      bytes.length >= 4 && view.getUint32(0, true) === SIG_LOCAL
        ? 'truncated'
        : 'not_a_zip',
    );
  if (candidates.length > 1) return refuse('ambiguous_end_record');
  return candidates[0] as number;
}

/**
 * Read every member of a zip archive. Throws `CourseBundleRefusedError` for a
 * hostile or damaged archive. A member whose honest declared size exceeds
 * `maxEntryBytes` is returned `entry_too_large` (visible, never inflated);
 * every other violation refuses the whole archive.
 */
export function readZipArchive(
  input: Uint8Array,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
  onProgress?: (completed: number, total: number) => void,
): RawBundleMember[] {
  if (!(input instanceof Uint8Array)) return refuse('not_a_zip');
  if (input.length > limits.maxArchiveBytes) return refuse('archive_too_large');
  if (input.length < EOCD_SIZE) return refuse('not_a_zip');
  const bytes = input;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndRecord(bytes, view);
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === SIG_ZIP64_LOCATOR)
    return refuse('zip64_unsupported');
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const entriesDisk = view.getUint16(eocd + 8, true);
  const entries = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (entries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff)
    return refuse('zip64_unsupported');
  if (disk !== 0 || cdDisk !== 0 || entriesDisk !== entries)
    return refuse('multi_disk');
  if (entries === 0) return refuse('empty_bundle');
  if (entries > limits.maxEntries) return refuse('too_many_entries');
  if (
    cdSize < entries * CENTRAL_SIZE ||
    cdOffset + cdSize !== eocd // central directory must end exactly at the end record
  )
    return refuse('invalid_central_directory');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  const central: CentralEntry[] = [];
  const names = new Set<string>();
  let at = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (at + CENTRAL_SIZE > eocd || view.getUint32(at, true) !== SIG_CENTRAL)
      return refuse('invalid_central_directory');
    const madeBy = view.getUint16(at + 4, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressed = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const diskStart = view.getUint16(at + 34, true);
    const external = view.getUint32(at + 38, true);
    const localOffset = view.getUint32(at + 42, true);
    const next = at + CENTRAL_SIZE + nameLength + extraLength + commentLength;
    if (next > eocd) return refuse('invalid_central_directory');
    const rawName = bytes.subarray(
      at + CENTRAL_SIZE,
      at + CENTRAL_SIZE + nameLength,
    );
    let decoded: string;
    try {
      decoded = decoder.decode(rawName);
    } catch {
      return refuse('invalid_path');
    }
    const { path, directory } = normalizeBundlePath(decoded, limits);
    if (flags & (0x1 | 0x40 | 0x2000) || method === 99)
      return refuse('encrypted_entry', path);
    if (method !== 0 && method !== 8) return refuse('unsupported_method', path);
    if (
      compressed === 0xffffffff ||
      size === 0xffffffff ||
      localOffset === 0xffffffff
    )
      return refuse('zip64_unsupported', path);
    if (diskStart !== 0) return refuse('multi_disk', path);
    const host = madeBy >>> 8;
    if (host === 3) {
      const type = (external >>> 16) & 0o170000;
      if (type === 0o120000) return refuse('symlink_entry', path);
      if (type !== 0 && type !== 0o100000 && type !== 0o040000)
        return refuse('special_entry', path);
    } else if (external & 0x400) {
      return refuse('symlink_entry', path); // DOS reparse point
    }
    if (directory && (size !== 0 || compressed > 2))
      return refuse('invalid_entry', path);
    const key = bundleNameKey(path);
    if (names.has(key)) return refuse('duplicate_name', path);
    names.add(key);
    if (method === 0 && compressed !== size)
      return refuse('size_mismatch', path);
    if (
      size > limits.ratioFloorBytes &&
      method === 8 &&
      (compressed === 0 || size / compressed > limits.maxCompressionRatio)
    )
      return refuse('compression_ratio', path);
    central.push({
      name: path,
      rawName,
      method,
      crc,
      compressed,
      size,
      localOffset,
      directory,
    });
    at = next;
  }
  if (at !== eocd) return refuse('invalid_central_directory');

  // Local headers and data ranges: inside the file, before the central
  // directory, naming the same entry, never overlapping each other.
  const located: Array<CentralEntry & { start: number; end: number }> = [];
  const ranges: Array<[number, number, string]> = [];
  for (const entry of central) {
    if (entry.directory) continue;
    if (entry.localOffset + LOCAL_SIZE > cdOffset)
      return refuse('entry_out_of_range', entry.name);
    if (view.getUint32(entry.localOffset, true) !== SIG_LOCAL)
      return refuse('local_header_mismatch', entry.name);
    const flags = view.getUint16(entry.localOffset + 6, true);
    if (flags & (0x1 | 0x40 | 0x2000))
      return refuse('encrypted_entry', entry.name);
    if (view.getUint16(entry.localOffset + 8, true) !== entry.method)
      return refuse('local_header_mismatch', entry.name);
    const nameLength = view.getUint16(entry.localOffset + 26, true);
    const extraLength = view.getUint16(entry.localOffset + 28, true);
    const start = entry.localOffset + LOCAL_SIZE + nameLength + extraLength;
    const end = start + entry.compressed;
    if (end > cdOffset) return refuse('entry_out_of_range', entry.name);
    const local = bytes.subarray(
      entry.localOffset + LOCAL_SIZE,
      entry.localOffset + LOCAL_SIZE + nameLength,
    );
    if (
      local.length !== entry.rawName.length ||
      !local.every((b, i) => b === entry.rawName[i])
    )
      return refuse('local_header_mismatch', entry.name);
    located.push({ ...entry, start, end });
    ranges.push([entry.localOffset, end, entry.name]);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  for (let i = 1; i < ranges.length; i++)
    if (
      (ranges[i] as [number, number, string])[0] <
      (ranges[i - 1] as [number, number, string])[1]
    )
      return refuse(
        'overlapping_entries',
        (ranges[i] as [number, number, string])[2],
      );

  // Declared totals are checked up front, actual output again while inflating.
  let declared = 0;
  for (const entry of located)
    if (entry.size <= limits.maxEntryBytes) declared += entry.size;
  if (declared > limits.maxTotalBytes) return refuse('total_too_large');

  const { zlib } = node();
  const out: RawBundleMember[] = [];
  let total = 0;
  onProgress?.(0, located.length);
  for (const entry of [...located].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )) {
    if (entry.size > limits.maxEntryBytes) {
      out.push({
        path: entry.name,
        size: entry.size,
        bytes: null,
        sha256: null,
        refusal: 'entry_too_large',
      });
      onProgress?.(out.length, located.length);
      continue;
    }
    const data = bytes.subarray(entry.start, entry.end);
    let inflated: Buffer;
    if (entry.method === 0) {
      inflated = Buffer.from(data);
    } else {
      try {
        inflated = zlib.inflateRawSync(data, {
          maxOutputLength: Math.max(entry.size, 1),
        });
      } catch (error) {
        return refuse(
          (error as { code?: string }).code === 'ERR_BUFFER_TOO_LARGE'
            ? 'size_mismatch'
            : 'inflate_failed',
          entry.name,
        );
      }
    }
    if (inflated.length !== entry.size)
      return refuse('size_mismatch', entry.name);
    if (crc32(inflated) !== entry.crc) return refuse('bad_crc', entry.name);
    total += inflated.length;
    if (total > limits.maxTotalBytes) return refuse('total_too_large');
    out.push({
      path: entry.name,
      size: inflated.length,
      bytes: inflated,
      sha256: sha256Hex(inflated),
      refusal: null,
    });
    onProgress?.(out.length, located.length);
  }
  return out;
}

/** Validate a plain file set the same way an archive is: paths, caps, duplicates. */
export function readFileSet(
  files: ReadonlyArray<{ path: string; bytes: Uint8Array }>,
  limits: CourseBundleLimits = COURSE_BUNDLE_LIMITS,
  onProgress?: (completed: number, total: number) => void,
): RawBundleMember[] {
  if (!Array.isArray(files) || files.length === 0)
    return refuse('empty_bundle');
  if (files.length > limits.maxEntries) return refuse('too_many_entries');
  const names = new Set<string>();
  const out: RawBundleMember[] = [];
  let total = 0;
  let memberTotal = 0;
  onProgress?.(0, files.length);
  for (const file of files) {
    const { path, directory } = normalizeBundlePath(file?.path, limits);
    if (directory || !(file.bytes instanceof Uint8Array))
      return refuse('invalid_entry', path);
    const key = bundleNameKey(path);
    if (names.has(key)) return refuse('duplicate_name', path);
    names.add(key);
    total += file.bytes.length;
    if (total > limits.maxArchiveBytes) return refuse('archive_too_large');
    if (file.bytes.length > limits.maxEntryBytes) {
      out.push({
        path,
        size: file.bytes.length,
        bytes: null,
        sha256: null,
        refusal: 'entry_too_large',
      });
    } else {
      // Same member-byte bound as an archive's inflated total.
      memberTotal += file.bytes.length;
      if (memberTotal > limits.maxTotalBytes) return refuse('total_too_large');
      out.push({
        path,
        size: file.bytes.length,
        bytes: file.bytes,
        sha256: sha256Hex(file.bytes),
        refusal: null,
      });
    }
    onProgress?.(out.length, files.length);
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
