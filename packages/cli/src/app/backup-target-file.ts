/**
 * Local directory backup target (#4804). Local tier: needs no entitlement and
 * no credentials.
 *
 * A snapshot is written to an owner-only `.partial` sibling, verified, fsynced
 * and published with `link()`, which never replaces an existing name. A crash
 * leaves only a `.partial` file, which `list` never reports.
 */

import { randomBytes } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import {
  type BackupObject,
  type BackupPutRequest,
  type BackupTarget,
  BackupTargetError,
  objectNameForSequence,
  sequenceFromObjectName,
  sortNewestFirst,
  verifiedCiphertext,
} from './backup-targets.js';
import { errorCode } from './errors.js';
import {
  parseSnapshotHeader,
  SNAPSHOT_HEADER_BYTES,
} from './snapshot-framing.js';

const PARTIAL_SUFFIX = '.partial';
const OBJECT_ID = /^snapshot-\d{20}\.hvsnap$/;

async function writeAll(handle: FileHandle, bytes: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset);
    if (bytesWritten <= 0) {
      throw new BackupTargetError(
        'unavailable',
        'The backup file write stalled.',
      );
    }
    offset += bytesWritten;
  }
}

/** Options for {@link FileBackupTarget}. */
export interface FileBackupTargetOptions {
  name: string;
  /** Absolute directory. Created 0700 when missing. */
  directory: string;
}

/** Stores snapshots as `snapshot-<sequence>.hvsnap` in one directory. */
export class FileBackupTarget implements BackupTarget {
  readonly kind = 'file' as const;
  readonly name: string;
  readonly #directory: string;

  constructor(options: FileBackupTargetOptions) {
    if (!isAbsolute(options.directory)) {
      throw new BackupTargetError(
        'invalid_config',
        'A file target needs an absolute directory.',
      );
    }
    this.name = options.name;
    this.#directory = options.directory;
  }

  async #ensureDirectory(create: boolean): Promise<boolean> {
    try {
      const info = await lstat(this.#directory);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new BackupTargetError(
          'invalid_config',
          'The file target path is not a plain directory.',
        );
      }
      // Retention deletes by name, so nobody else may add or remove entries.
      const owner = process.getuid?.();
      if (
        (owner !== undefined && info.uid !== owner) ||
        (info.mode & 0o022) !== 0
      ) {
        throw new BackupTargetError(
          'invalid_config',
          'The file target directory must belong to you and not be writable by others.',
        );
      }
      return true;
    } catch (error) {
      if (error instanceof BackupTargetError) throw error;
      if (errorCode(error) !== 'ENOENT') {
        throw new BackupTargetError(
          'unavailable',
          'The file target directory cannot be read.',
        );
      }
    }
    if (!create) return false;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    return this.#ensureDirectory(false);
  }

  async preflight(): Promise<void> {
    await this.#ensureDirectory(true);
  }

  async put(request: BackupPutRequest): Promise<BackupObject> {
    await this.#ensureDirectory(true);
    const name = objectNameForSequence(request.sequence);
    const finalPath = join(this.#directory, name);
    const exists = await lstat(finalPath).then(
      () => true,
      () => false,
    );
    if (exists) {
      throw new BackupTargetError(
        'already_exists',
        'A snapshot with this sequence already exists on the target.',
      );
    }
    const partial = join(
      this.#directory,
      `.${name}.${process.pid}.${randomBytes(6).toString('hex')}${PARTIAL_SUFFIX}`,
    );
    let handle: FileHandle | undefined;
    try {
      handle = await open(partial, 'wx', 0o600);
      for await (const chunk of verifiedCiphertext(request)) {
        await writeAll(handle, chunk);
      }
      await handle.sync();
      await handle.close();
      handle = undefined;
      const written = await lstat(partial);
      if (!written.isFile() || written.size !== request.byteSize) {
        throw new BackupTargetError(
          'integrity',
          'The written snapshot does not have its declared size.',
        );
      }
      try {
        await link(partial, finalPath);
      } catch (error) {
        if (errorCode(error) === 'EEXIST') {
          throw new BackupTargetError(
            'already_exists',
            'A snapshot with this sequence already exists on the target.',
          );
        }
        throw error;
      }
    } finally {
      await handle?.close().catch(() => undefined);
      await unlink(partial).catch(() => undefined);
    }
    const info = await lstat(finalPath);
    return {
      id: name,
      sequence: request.sequence,
      byteSize: info.size,
      createdAt: info.mtime,
      sha256: request.sha256,
    };
  }

  async list(): Promise<BackupObject[]> {
    if (!(await this.#ensureDirectory(false))) return [];
    const objects: BackupObject[] = [];
    for (const entry of await readdir(this.#directory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const sequence = sequenceFromObjectName(entry.name);
      if (sequence === null) continue;
      const path = join(this.#directory, entry.name);
      const info = await lstat(path);
      // A name alone is not a snapshot: its clear header must agree with it.
      if (!info.isFile() || !(await this.#hasHeaderFor(path, sequence))) {
        continue;
      }
      objects.push({
        id: entry.name,
        sequence,
        byteSize: info.size,
        createdAt: info.mtime,
      });
    }
    return sortNewestFirst(objects);
  }

  async #hasHeaderFor(path: string, sequence: bigint): Promise<boolean> {
    let handle: FileHandle | undefined;
    try {
      handle = await open(path, 'r');
      const header = Buffer.alloc(SNAPSHOT_HEADER_BYTES);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      return (
        bytesRead === header.length &&
        parseSnapshotHeader(header).sequence === sequence
      );
    } catch {
      return false;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  #path(id: string): string {
    if (typeof id !== 'string' || !OBJECT_ID.test(id)) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    return join(this.#directory, id);
  }

  async *get(id: string): AsyncGenerator<Uint8Array> {
    const path = this.#path(id);
    const info = await lstat(path).catch(() => null);
    if (!info?.isFile()) {
      throw new BackupTargetError('not_found', 'Unknown snapshot.');
    }
    for await (const chunk of createReadStream(path, {
      highWaterMark: 1024 * 1024,
    })) {
      yield chunk as Buffer;
    }
  }

  async delete(id: string): Promise<void> {
    const path = this.#path(id);
    try {
      await unlink(path);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        throw new BackupTargetError('not_found', 'Unknown snapshot.');
      }
      throw new BackupTargetError(
        'unavailable',
        'The snapshot could not be removed.',
      );
    }
  }

  /**
   * Remove `.partial` files older than `maxAgeMs`: leftovers of a crashed
   * upload. Runs under the operation lock, so none is in flight.
   */
  async removeStalePartials(
    maxAgeMs: number,
    now = Date.now(),
  ): Promise<number> {
    if (!(await this.#ensureDirectory(false))) return 0;
    let removed = 0;
    for (const entry of await readdir(this.#directory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile() || !entry.name.endsWith(PARTIAL_SUFFIX)) continue;
      if (!entry.name.startsWith('.snapshot-')) continue;
      const path = join(this.#directory, entry.name);
      const info = await lstat(path).catch(() => null);
      if (info?.isFile() && now - info.mtimeMs >= maxAgeMs) {
        await unlink(path).catch(() => undefined);
        removed += 1;
      }
    }
    return removed;
  }
}
