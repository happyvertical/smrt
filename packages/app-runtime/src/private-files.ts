/**
 * Private-file primitives shared by the custody modules and `smrt app`:
 * bounded no-follow reads, atomic owner-only writes, and the stat and
 * directory checks that decide whether a path is private to this user.
 *
 * POSIX semantics. Where `O_NOFOLLOW`, uid, or mode bits do not exist
 * (Windows) the corresponding check is skipped; Windows custody lives in
 * `windows-custody.ts`.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { type FileHandle, mkdir, open, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { errorCode } from './error-code.js';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;

/** The subset of `fs.Stats` the private-file check reads. */
export interface PrivateFileStat {
  isFile(): boolean;
  uid: number;
  mode: number;
  size: number;
}

/** Options for the atomic private writers. */
export interface PrivateWriteOptions {
  /** Create the parent directory (recursive, mode 0700) first. */
  createParent?: boolean;
}

/**
 * A regular file owned by the current user (when the uid is known), with no
 * group or other access, no larger than `maxBytes`. On Windows Node reports
 * synthetic modes (0o666 or 0o444) and no uid, so the owner and mode checks do
 * not exist there: the file's privacy is that of its directory, which the
 * Windows custody rule (`windows-custody.ts`) has already verified.
 */
export function isPrivateFileStat(
  details: PrivateFileStat,
  maxBytes: number,
  platformName: NodeJS.Platform = process.platform,
): boolean {
  const uid = process.getuid?.();
  return (
    details.isFile() &&
    (uid === undefined || details.uid === uid) &&
    (platformName === 'win32' || (details.mode & 0o077) === 0) &&
    details.size <= maxBytes
  );
}

/** Create a directory (and missing parents) with mode 0700. */
export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
}

/**
 * Require `path` to be a real (not linked) current-user directory and repair
 * its mode to 0700 when group or other have access. Throws a generic error;
 * callers wrap it in their own message.
 */
export function assertPrivateDirectorySync(
  path: string,
  platformName: NodeJS.Platform = process.platform,
): void {
  if (platformName === 'win32') {
    // A directory cannot be opened for `fstat` on Windows. It must be a real
    // (not linked) directory; its ACL is the Windows custody rule's concern.
    const details = lstatSync(path);
    if (details.isSymbolicLink() || !details.isDirectory()) {
      throw new Error('not a current-user directory');
    }
    return;
  }
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | constants.O_DIRECTORY | NO_FOLLOW,
    );
    const details = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (!details.isDirectory() || (uid !== undefined && details.uid !== uid)) {
      throw new Error('not a current-user directory');
    }
    if ((details.mode & 0o077) !== 0) fchmodSync(descriptor, 0o700);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function temporaryPathFor(path: string): string {
  return join(
    dirname(path),
    `.${basename(path)}.tmp-${randomBytes(8).toString('hex')}`,
  );
}

/** Atomic private write: a reader sees the old or the new file, never a mix. */
export function writePrivateFileAtomicSync(
  path: string,
  contents: string,
  options: PrivateWriteOptions = {},
): void {
  if (options.createParent) ensurePrivateDirectorySync(dirname(path));
  const temporary = temporaryPathFor(path);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
    throw error;
  }
  try {
    const directory = openSync(dirname(path), constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  } catch {
    // Directory fsync is best effort (not supported on every platform).
  }
}

/** Async form of {@link writePrivateFileAtomicSync}. */
export async function writePrivateFileAtomic(
  path: string,
  contents: string,
  options: PrivateWriteOptions = {},
): Promise<void> {
  if (options.createParent) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  }
  const temporary = temporaryPathFor(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    await handle.writeFile(contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  try {
    const directory = await open(dirname(path), constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } catch {
    // Directory fsync is best effort (not supported on every platform).
  }
}

/**
 * Read a regular file of at most `maxBytes` without following a final
 * symbolic link. `null` when absent; anything else unsafe throws.
 */
export async function readPrivateFileBounded(
  path: string,
  maxBytes: number,
): Promise<string | null> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | NO_FOLLOW);
    const info = await handle.stat();
    if (!info.isFile() || info.size > maxBytes) throw new Error('unreadable');
    return await handle.readFile({ encoding: 'utf8' });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}
