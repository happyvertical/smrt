/**
 * Node readers for Class CrunchLabs unit downloads on disk (SMRT #4616): a
 * folder, or the zip parts a Drive export splits it into, or both mixed. Zips
 * are read lazily from their central directory, so a multi-gigabyte part that
 * is mostly video costs only the few entries that are actually used. Server
 * only (`node:fs`, `node:zlib`).
 */
import { type Dirent, lstatSync } from 'node:fs';
import { open, readdir, readFile } from 'node:fs/promises';
import { basename, join, relative, sep } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { COURSE_BUNDLE_LIMITS } from '../course-bundle-contracts.js';
import { crc32 } from '../course-bundle-zip.js';
import type {
  ClassCrunchLabsFile,
  ClassCrunchLabsFileSource,
} from './class-crunchlabs.js';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;
const MAX_CENTRAL_DIRECTORY = 16 * 1024 * 1024;
const MAX_DEPTH = 8;

interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressed: number;
  size: number;
  offset: number;
}

async function readAt(
  path: string,
  position: number,
  length: number,
): Promise<Buffer> {
  const handle = await open(path, 'r');
  try {
    // Never allocate more than the file can supply, whatever a header claims.
    const available = Math.max(0, (await handle.stat()).size - position);
    const buffer = Buffer.alloc(Math.min(length, available));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function sizeOf(path: string): Promise<number> {
  const handle = await open(path, 'r');
  try {
    return (await handle.stat()).size;
  } finally {
    await handle.close();
  }
}

/** The file entries of a zip, from its central directory alone. */
async function listZip(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, 'r');
  let total: number;
  try {
    total = (await handle.stat()).size;
  } finally {
    await handle.close();
  }
  const tailLength = Math.min(total, 22 + 0xffff);
  const tail = await readAt(path, total - tailLength, tailLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      tail.readUInt32LE(i) === EOCD &&
      i + 22 + tail.readUInt16LE(i + 20) === tail.length
    ) {
      eocd = i;
      break;
    }
  }
  if (eocd === -1) throw new Error(`${basename(path)} is not a readable zip.`);
  const entries = tail.readUInt16LE(eocd + 10);
  const size = tail.readUInt32LE(eocd + 12);
  const offset = tail.readUInt32LE(eocd + 16);
  if (
    tail.readUInt16LE(eocd + 4) !== 0 ||
    tail.readUInt16LE(eocd + 6) !== 0 ||
    entries === 0xffff ||
    size === 0xffffffff ||
    offset === 0xffffffff
  )
    throw new Error(`${basename(path)} is a zip64 or multi-disk archive.`);
  if (size > MAX_CENTRAL_DIRECTORY || offset + size > total)
    throw new Error(`${basename(path)} has an invalid central directory.`);
  const central = await readAt(path, offset, size);
  const out: ZipEntry[] = [];
  let at = 0;
  for (let n = 0; n < entries; n++) {
    if (at + 46 > central.length || central.readUInt32LE(at) !== CENTRAL)
      throw new Error(`${basename(path)} has a damaged central directory.`);
    const flags = central.readUInt16LE(at + 8);
    const nameLength = central.readUInt16LE(at + 28);
    const extraLength = central.readUInt16LE(at + 30);
    const commentLength = central.readUInt16LE(at + 32);
    const name = central.toString('utf8', at + 46, at + 46 + nameLength);
    const entry: ZipEntry = {
      name,
      method: central.readUInt16LE(at + 10),
      crc: central.readUInt32LE(at + 16),
      compressed: central.readUInt32LE(at + 20),
      size: central.readUInt32LE(at + 24),
      offset: central.readUInt32LE(at + 42),
    };
    at += 46 + nameLength + extraLength + commentLength;
    // Directories, encrypted entries and exotic methods are not unit files.
    if (
      name.endsWith('/') ||
      flags & 1 ||
      (entry.method !== 0 && entry.method !== 8)
    )
      continue;
    if (entry.size === 0xffffffff || entry.compressed === 0xffffffff) continue;
    out.push(entry);
  }
  return out;
}

async function readZipEntry(
  path: string,
  entry: ZipEntry,
): Promise<Uint8Array> {
  if (entry.size > COURSE_BUNDLE_LIMITS.maxEntryBytes)
    throw new Error(`${entry.name} is larger than a bundle member may be.`);
  // A hostile header may claim a payload far beyond the member limit or the file.
  const fileSize = await sizeOf(path);
  if (
    entry.compressed > COURSE_BUNDLE_LIMITS.maxEntryBytes ||
    entry.offset + 30 + entry.compressed > fileSize
  )
    throw new Error(`${entry.name} has an implausible compressed size.`);
  const local = await readAt(path, entry.offset, 30);
  if (local.length < 30 || local.readUInt32LE(0) !== LOCAL)
    throw new Error(`${entry.name} has a damaged local header.`);
  const start =
    entry.offset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
  const data = await readAt(path, start, entry.compressed);
  if (data.length !== entry.compressed)
    throw new Error(`${entry.name} is truncated.`);
  const bytes =
    entry.method === 0
      ? data
      : inflateRawSync(data, { maxOutputLength: Math.max(entry.size, 1) });
  if (bytes.length !== entry.size || crc32(bytes) !== entry.crc)
    throw new Error(`${entry.name} failed its size or checksum check.`);
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Drive names parts like `Unit_Class CrunchLabs-20261102T164712Z-1-001.zip`; the timestamp orders exports. */
const exportOf = (zipName: string) =>
  /-(\d{8}T\d{6}Z)-/.exec(zipName)?.[1] ?? '';

/**
 * Every unit file under `directory`: plain files, and the entries of any `.zip`
 * (a zip is not expanded into the filesystem, and a zip inside a zip is not
 * opened). Symbolic links are skipped; hidden files are ignored.
 */
export function folderClassCrunchLabsSource(
  directory: string,
): ClassCrunchLabsFileSource {
  return {
    async files() {
      const out: ClassCrunchLabsFile[] = [];
      const walk = async (dir: string, depth: number): Promise<void> => {
        if (depth > MAX_DEPTH) return;
        const children: Dirent[] = await readdir(dir, { withFileTypes: true });
        for (const child of children.sort((a, b) =>
          a.name < b.name ? -1 : 1,
        )) {
          if (child.name.startsWith('.')) continue;
          const full = join(dir, child.name);
          if (child.isSymbolicLink()) continue;
          if (child.isDirectory()) {
            await walk(full, depth + 1);
            continue;
          }
          if (!child.isFile()) continue;
          if (/\.zip$/i.test(child.name)) {
            const exportId = exportOf(child.name);
            for (const entry of await listZip(full))
              out.push({
                path: entry.name,
                size: entry.size,
                crc32: entry.crc.toString(16).padStart(8, '0'),
                exportId,
                read: () => readZipEntry(full, entry),
              });
            continue;
          }
          const size = lstatSync(full).size;
          out.push({
            path: relative(directory, full).split(sep).join('/'),
            size,
            read: async () => {
              if (size > COURSE_BUNDLE_LIMITS.maxEntryBytes)
                throw new Error(
                  `${child.name} is larger than a bundle member may be.`,
                );
              return new Uint8Array(await readFile(full));
            },
          });
        }
      };
      await walk(directory, 0);
      return out;
    },
  };
}
