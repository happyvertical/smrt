/**
 * Data-root archive (HVSA v1) carried inside a `data-root` encrypted snapshot
 * (#4797).
 *
 * A deliberately small format so extraction has no link, device, ownership or
 * absolute-path semantics to get wrong: `HVSA` + version, then entries of
 * `type u8 | pathLength u16 | path | (file: size u64 | bytes)`, ending with
 * type 0. Only directories and regular files exist; paths are relative POSIX
 * paths whose parents appear first. The archive is streamed both ways, so a
 * data root of any size never sits in memory or in a plaintext temp file.
 */

import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';

const MAGIC = Buffer.from('HVSA\x01', 'latin1');
const ENTRY_END = 0;
const ENTRY_DIRECTORY = 1;
const ENTRY_FILE = 2;
const MAX_PATH_BYTES = 4096;
const READ_BYTES = 1024 * 1024;

interface PlannedEntry {
  type: typeof ENTRY_DIRECTORY | typeof ENTRY_FILE;
  path: string;
  absolute: string;
  size: number;
}

/** A data root ready to stream into a snapshot. */
export interface DataRootArchive {
  /** Exact archive length in bytes. */
  totalLength: number;
  entryCount: number;
  /** Stream the archive. Fails if any file changed size since planning. */
  chunks(): AsyncGenerator<Buffer>;
}

function encodePath(path: string): Buffer {
  const bytes = Buffer.from(path, 'utf8');
  if (bytes.length < 1 || bytes.length > MAX_PATH_BYTES) {
    throw new Error(`Data root path is too long for a snapshot: ${path}`);
  }
  // Refuse at backup time exactly what restore refuses, so a successful
  // backup is always restorable.
  if (!isSafePath(path) || bytes.toString('utf8') !== path) {
    throw new Error(
      `Data root path cannot be stored in an encrypted snapshot: ${path}`,
    );
  }
  return bytes;
}

function isSafePath(path: string): boolean {
  return path
    .split('/')
    .every(
      (segment) =>
        segment !== '' &&
        segment !== '.' &&
        segment !== '..' &&
        !segment.includes('\\') &&
        !segment.includes('\0'),
    );
}

function entryHeader(entry: PlannedEntry): Buffer {
  const path = encodePath(entry.path);
  const header = Buffer.alloc(
    1 + 2 + path.length + (entry.type === ENTRY_FILE ? 8 : 0),
  );
  header[0] = entry.type;
  header.writeUInt16BE(path.length, 1);
  path.copy(header, 3);
  if (entry.type === ENTRY_FILE) {
    header.writeBigUInt64BE(BigInt(entry.size), 3 + path.length);
  }
  return header;
}

/**
 * Plan an archive of `root`'s contents (not `root` itself). Refuses symbolic
 * links and special files rather than following or skipping them. The caller
 * holds the writer lease, so the tree is quiescent while it streams.
 */
export function planDataRootArchive(root: string): DataRootArchive {
  const entries: PlannedEntry[] = [];
  const walk = (absolute: string, relative: string) => {
    for (const name of readdirSync(absolute).sort()) {
      const childAbsolute = join(absolute, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const stat = lstatSync(childAbsolute);
      if (stat.isDirectory()) {
        entries.push({
          type: ENTRY_DIRECTORY,
          path: childRelative,
          absolute: childAbsolute,
          size: 0,
        });
        walk(childAbsolute, childRelative);
      } else if (stat.isFile()) {
        entries.push({
          type: ENTRY_FILE,
          path: childRelative,
          absolute: childAbsolute,
          size: stat.size,
        });
      } else {
        throw new Error(
          `Encrypted backup refuses a symbolic link or special file: ${childRelative}`,
        );
      }
    }
  };
  walk(root, '');
  let totalLength = MAGIC.length + 1;
  for (const entry of entries) {
    totalLength += entryHeader(entry).length + entry.size;
  }
  return {
    totalLength,
    entryCount: entries.length,
    async *chunks() {
      yield Buffer.from(MAGIC);
      const buffer = Buffer.alloc(READ_BYTES);
      try {
        for (const entry of entries) {
          yield entryHeader(entry);
          if (entry.type !== ENTRY_FILE) continue;
          const fd = openSync(entry.absolute, 'r');
          try {
            if (!fstatSync(fd).isFile() || fstatSync(fd).size !== entry.size) {
              throw new Error(
                `Data root changed while it was archived: ${entry.path}`,
              );
            }
            let remaining = entry.size;
            let position = 0;
            while (remaining > 0) {
              const read = readSync(
                fd,
                buffer,
                0,
                Math.min(buffer.length, remaining),
                position,
              );
              if (read === 0) {
                throw new Error(
                  `Data root changed while it was archived: ${entry.path}`,
                );
              }
              yield buffer.subarray(0, read);
              remaining -= read;
              position += read;
            }
          } finally {
            closeSync(fd);
          }
        }
        yield Buffer.of(ENTRY_END);
      } finally {
        buffer.fill(0);
      }
    },
  };
}

/** Pull-based reader over a plaintext chunk stream. */
class ChunkReader {
  #current: Buffer = Buffer.alloc(0);
  #offset = 0;
  #result: string | undefined;
  constructor(private readonly source: AsyncIterator<Buffer, string>) {}

  async #fill(): Promise<boolean> {
    while (this.#offset >= this.#current.length) {
      const next = await this.source.next();
      if (next.done) {
        this.#result = next.value;
        return false;
      }
      this.#current = next.value;
      this.#offset = 0;
    }
    return true;
  }

  /** Read exactly `length` (small, caller-bounded) bytes. */
  async exact(length: number): Promise<Buffer> {
    const output = Buffer.alloc(length);
    let filled = 0;
    while (filled < length) {
      if (!(await this.#fill())) {
        throw new Error('Snapshot archive is truncated');
      }
      const take = Math.min(
        length - filled,
        this.#current.length - this.#offset,
      );
      this.#current.copy(output, filled, this.#offset, this.#offset + take);
      this.#offset += take;
      filled += take;
    }
    return output;
  }

  /** Pass exactly `length` bytes to `sink` without buffering them. */
  async pipe(length: number, sink: (bytes: Buffer) => void): Promise<void> {
    let remaining = length;
    while (remaining > 0) {
      if (!(await this.#fill())) {
        throw new Error('Snapshot archive is truncated');
      }
      const take = Math.min(remaining, this.#current.length - this.#offset);
      sink(this.#current.subarray(this.#offset, this.#offset + take));
      this.#offset += take;
      remaining -= take;
    }
  }

  /** Require the end of input; returns the source's completion value. */
  async end(): Promise<string> {
    if (await this.#fill()) {
      throw new Error('Snapshot archive has trailing bytes');
    }
    return this.#result as string;
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true });

function validatedPath(bytes: Buffer): string {
  let path: string;
  try {
    path = decoder.decode(bytes);
  } catch {
    throw new Error('Snapshot archive contains an invalid path');
  }
  if (!isSafePath(path)) {
    throw new Error('Snapshot archive contains an unsafe path');
  }
  return path;
}

/**
 * Extract an archive stream into `directory` (an empty directory the caller
 * created). Directories are created 0700 and files 0600 with exclusive
 * creation, so a duplicate or colliding entry fails instead of overwriting.
 * Resolves to the source's completion value once the stream is fully drained.
 */
export async function extractDataRootArchive(
  source: AsyncIterator<Buffer, string>,
  directory: string,
): Promise<string> {
  const reader = new ChunkReader(source);
  if (!(await reader.exact(MAGIC.length)).equals(MAGIC)) {
    throw new Error('Unsupported snapshot archive format');
  }
  const directories = new Set<string>(['']);
  for (;;) {
    const [type] = await reader.exact(1);
    if (type === ENTRY_END) break;
    if (type !== ENTRY_DIRECTORY && type !== ENTRY_FILE) {
      throw new Error('Snapshot archive contains an unsupported entry');
    }
    const pathLength = (await reader.exact(2)).readUInt16BE(0);
    if (pathLength < 1 || pathLength > MAX_PATH_BYTES) {
      throw new Error('Snapshot archive contains an invalid path');
    }
    const path = validatedPath(await reader.exact(pathLength));
    const parent = path.includes('/')
      ? path.slice(0, path.lastIndexOf('/'))
      : '';
    if (!directories.has(parent)) {
      throw new Error('Snapshot archive entry precedes its directory');
    }
    const target = join(directory, ...path.split('/'));
    if (type === ENTRY_DIRECTORY) {
      mkdirSync(target, { mode: 0o700 });
      directories.add(path);
      continue;
    }
    const size = (await reader.exact(8)).readBigUInt64BE(0);
    if (size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('Snapshot archive entry is too large');
    }
    const fd = openSync(target, 'wx', 0o600);
    try {
      await reader.pipe(Number(size), (bytes) => {
        let offset = 0;
        while (offset < bytes.length) {
          offset += writeSync(fd, bytes, offset, bytes.length - offset);
        }
      });
    } finally {
      closeSync(fd);
    }
  }
  return reader.end();
}
