import { randomBytes } from 'node:crypto';
import {
  type DesktopFs,
  type FileHandleLike,
  FsTrustError,
  nodeFs,
  O_NOFOLLOW,
  O_RDONLY,
  O_WRONLY_CREATE_EXCL,
  type StatsLike,
  toFsTrustError,
} from './fs-seam.js';

/**
 * Custody rules for the private state directory
 * (`<app_local_data_dir>/.desktop-shell/`, mode 0700) and for trusted package
 * files.
 *
 * Readers open with `O_RDONLY|O_NOFOLLOW` and validate `fstat` of the open
 * descriptor, never `stat`-then-`open`. `O_NOFOLLOW` guards only the final
 * path component; the parent directory is covered by `assertPrivateDirectory`
 * (an `lstat` that rejects symlinks) or by the trust walk in `abs-path.ts`.
 *
 * Failures are thrown as value-free `FsTrustError`s; each contract maps the
 * `kind` to its own public error code.
 */

export const DEFAULT_MAX_FILE_BYTES = 64 * 1024;

export interface FileCustodyOptions {
  readonly fs?: DesktopFs;
  /** Effective uid. Defaults to `process.getuid()`; `undefined` skips it. */
  readonly currentUid?: number;
  /** Defaults to `process.platform`. Windows has no uid or mode bits. */
  readonly platform?: NodeJS.Platform;
  /** Defaults to `DEFAULT_MAX_FILE_BYTES`. */
  readonly maxBytes?: number;
}

function defaultUid(options: FileCustodyOptions): number | undefined {
  return 'currentUid' in options ? options.currentUid : process.getuid?.();
}

function isWindows(options: FileCustodyOptions): boolean {
  return (options.platform ?? process.platform) === 'win32';
}

async function readChecked(
  path: string,
  accept: (stat: StatsLike) => boolean,
  options: FileCustodyOptions,
): Promise<string> {
  const fs = options.fs ?? nodeFs;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  let handle: FileHandleLike | undefined;
  try {
    handle = await fs.open(path, O_RDONLY | O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || !accept(stat)) throw new FsTrustError('untrusted');
    if (stat.size > maxBytes) throw new FsTrustError('too_large');

    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const buffer = new Uint8Array(Math.min(8192, maxBytes + 1 - total));
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > maxBytes) throw new FsTrustError('too_large');
      chunks.push(buffer.subarray(0, bytesRead));
    }
    try {
      return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw new FsTrustError('malformed_text');
    }
  } catch (error) {
    throw toFsTrustError(error);
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Read a private state file as UTF-8 text. The open descriptor must be a
 * regular file owned by the current user with no group or other permission
 * bits (`mode & 0o077 === 0`) and no larger than `maxBytes`.
 */
export function readPrivateFile(
  path: string,
  options: FileCustodyOptions = {},
): Promise<string> {
  const uid = defaultUid(options);
  const windows = isWindows(options);
  return readChecked(
    path,
    (stat) =>
      windows ||
      ((uid === undefined || stat.uid === uid) && (stat.mode & 0o077) === 0),
    options,
  );
}

/**
 * Read a trusted package file (for example `smrt-bundle.json`) as UTF-8 text.
 * The open descriptor must be a regular file owned by the current user or
 * root that is not group or other writable. Pair it with `assertTrustedChain`
 * for the containing directories.
 */
export function readTrustedFile(
  path: string,
  options: FileCustodyOptions = {},
): Promise<string> {
  const uid = defaultUid(options);
  const windows = isWindows(options);
  return readChecked(
    path,
    (stat) =>
      windows ||
      ((uid === undefined || stat.uid === uid || stat.uid === 0) &&
        (stat.mode & 0o022) === 0),
    options,
  );
}

/**
 * Require `path` to be a real directory (not a symlink) owned by the current
 * user with no group or other permission bits.
 */
export async function assertPrivateDirectory(
  path: string,
  options: FileCustodyOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFs;
  try {
    const stat = await fs.lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new FsTrustError('untrusted');
    }
    if (isWindows(options)) return;
    const uid = defaultUid(options);
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
      throw new FsTrustError('untrusted');
    }
  } catch (error) {
    throw toFsTrustError(error);
  }
}

export interface AtomicWriteOptions extends FileCustodyOptions {
  /** File mode for the new file. Defaults to 0600. */
  readonly mode?: number;
  /** Test seam for the temporary file suffix. */
  readonly randomSuffix?: () => string;
}

function parentDirectory(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut <= 0 ? path.slice(0, cut + 1) || '.' : path.slice(0, cut);
}

/**
 * Atomically replace `path` with `data`:
 * temp file (`O_CREAT|O_EXCL|O_NOFOLLOW`, 0600) in the same directory, write,
 * fsync, rename over `path`, fsync the directory. The temp file is removed on
 * failure. A symlink at `path` is replaced, never followed.
 */
export async function writePrivateFileAtomic(
  path: string,
  data: string | Uint8Array,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const fs = options.fs ?? nodeFs;
  const mode = options.mode ?? 0o600;
  const suffix = (
    options.randomSuffix ?? (() => randomBytes(8).toString('hex'))
  )();
  const temporary = `${path}.${suffix}.tmp`;
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;

  let handle: FileHandleLike | undefined;
  let created = false;
  let renamed = false;
  try {
    handle = await fs.open(temporary, O_WRONLY_CREATE_EXCL, mode);
    created = true;
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesWritten } = await handle.write(
        bytes,
        offset,
        bytes.length - offset,
      );
      offset += bytesWritten;
    }
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, path);
    renamed = true;
    if (!isWindows(options)) {
      const directory = await fs.open(parentDirectory(path), O_RDONLY);
      try {
        await directory.sync();
      } catch (error) {
        const code = (error as { code?: unknown } | null)?.code;
        if (code !== 'EINVAL' && code !== 'ENOTSUP') throw error;
      } finally {
        await directory.close().catch(() => undefined);
      }
    }
  } catch (error) {
    await handle?.close().catch(() => undefined);
    // Only remove a temp file this call created: with O_EXCL a failed open
    // means the name belongs to someone else.
    if (created && !renamed) await fs.unlink(temporary).catch(() => undefined);
    throw toFsTrustError(error);
  }
}
