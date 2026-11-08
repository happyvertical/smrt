import { constants, promises as fsp } from 'node:fs';

/** The subset of `fs.Stats` the trust checks read. */
export interface StatsLike {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  readonly uid: number;
  readonly mode: number;
  readonly size: number | bigint;
}

/** An open file descriptor, reduced to what the contracts need. */
export interface FileHandleLike {
  stat(): Promise<StatsLike>;
  read(
    buffer: Uint8Array,
    offset: number,
    length: number,
    position: number | null,
  ): Promise<{ readonly bytesRead: number }>;
  write(
    data: Uint8Array,
    offset: number,
    length: number,
  ): Promise<{ readonly bytesWritten: number }>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/**
 * Injectable filesystem. The default is `node:fs/promises`; tests and
 * alternative runtimes provide their own. All checks run on the descriptor
 * returned by `open` (never `stat`-then-`open`), except `lstat` on directories.
 */
export interface DesktopFs {
  open(path: string, flags: number, mode?: number): Promise<FileHandleLike>;
  lstat(path: string): Promise<StatsLike>;
  realpath(path: string): Promise<string>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
}

/** The default filesystem, backed by `node:fs/promises`. */
export const nodeFs: DesktopFs = {
  async open(path, flags, mode) {
    const handle = await fsp.open(path, flags, mode);
    return {
      stat: () => handle.stat(),
      read: (buffer, offset, length, position) =>
        handle.read(buffer, offset, length, position),
      write: (data, offset, length) => handle.write(data, offset, length),
      sync: () => handle.sync(),
      close: () => handle.close(),
    };
  },
  lstat: (path) => fsp.lstat(path),
  realpath: (path) => fsp.realpath(path),
  rename: (from, to) => fsp.rename(from, to),
  unlink: (path) => fsp.unlink(path),
};

/** `open` flags. `O_NOFOLLOW` is absent on Windows, where it is a no-op. */
export const O_RDONLY = constants.O_RDONLY;
export const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
/**
 * Keeps `open` from blocking on a FIFO planted at a record path. It has no
 * effect on regular files; the post-open `fstat` still rejects non-files.
 */
export const O_NONBLOCK = constants.O_NONBLOCK ?? 0;
export const O_WRONLY_CREATE_EXCL =
  constants.O_WRONLY |
  constants.O_CREAT |
  constants.O_EXCL |
  (constants.O_NOFOLLOW ?? 0);

export type FsTrustKind =
  | 'absent'
  | 'untrusted'
  | 'too_large'
  | 'unreadable'
  | 'malformed_text';

const FS_TRUST_MESSAGES: Record<FsTrustKind, string> = {
  absent: 'File or directory does not exist',
  untrusted: 'File or directory failed the trust checks',
  too_large: 'File exceeds the size limit',
  unreadable: 'File or directory could not be accessed',
  malformed_text: 'File is not valid UTF-8 text',
};

/**
 * Internal, value-free failure of a trust-checked filesystem operation.
 * Contracts catch it and map `kind` to their own public error code.
 */
export class FsTrustError extends Error {
  readonly kind: FsTrustKind;

  constructor(kind: FsTrustKind) {
    super(FS_TRUST_MESSAGES[kind]);
    this.name = 'FsTrustError';
    this.kind = kind;
  }
}

/** Map a thrown errno error to an `FsTrustError` without keeping its text. */
export function toFsTrustError(error: unknown): FsTrustError {
  if (error instanceof FsTrustError) return error;
  const code = (error as { code?: unknown } | null)?.code;
  if (code === 'ENOENT' || code === 'ENOTDIR') {
    return new FsTrustError('absent');
  }
  if (code === 'ELOOP' || code === 'EMLINK') {
    return new FsTrustError('untrusted');
  }
  return new FsTrustError('unreadable');
}
