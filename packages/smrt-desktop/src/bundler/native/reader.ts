/**
 * Bounds-checked, budgeted random access over a file's bytes.
 *
 * Every parser reads through a `ByteReader`. The budgeted wrapper enforces the
 * three rules of the native verifier in one place: no read outside the file
 * (`truncated`), no single read or cumulative read above the caps
 * (`read_limit`), and no raw `RangeError` or I/O message ever escapes
 * (`read_failed`).
 */

import type { FileHandleLike } from '../../internal/fs-seam.js';
import { NativeVerificationError } from './errors.js';

/** Random access to one file's bytes. */
export interface ByteReader {
  readonly size: number;
  /** Read exactly `length` bytes at `position`; reject when out of range. */
  read(position: number, length: number): Promise<Uint8Array>;
}

/** A `ByteReader` that owns a descriptor. */
export interface ClosableByteReader extends ByteReader {
  close(): Promise<void>;
}

/** Total bytes one verification may read from one file. */
export const MAX_TOTAL_READ_BYTES = 1024 * 1024;
/** Largest single read. */
export const MAX_SINGLE_READ_BYTES = 256 * 1024;

/** A reader over an in-memory buffer (tests, small heads). */
export function bufferReader(bytes: Uint8Array): ByteReader {
  return {
    size: bytes.length,
    read(position, length) {
      if (
        !Number.isSafeInteger(position) ||
        !Number.isSafeInteger(length) ||
        position < 0 ||
        length < 0 ||
        position + length > bytes.length
      ) {
        return Promise.reject(new NativeVerificationError('truncated'));
      }
      return Promise.resolve(bytes.subarray(position, position + length));
    },
  };
}

/**
 * A reader over an open descriptor. `size` is taken from `fstat` of the same
 * descriptor, so the bytes read and the bound checked are the same file.
 */
export async function fileHandleReader(
  handle: FileHandleLike,
): Promise<ClosableByteReader> {
  let size: number;
  try {
    const raw = (await handle.stat()).size;
    size = typeof raw === 'bigint' ? Number(raw) : raw;
  } catch {
    throw new NativeVerificationError('read_failed');
  }
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new NativeVerificationError('read_failed');
  }
  return {
    size,
    async read(position, length) {
      if (position < 0 || length < 0 || position + length > size) {
        throw new NativeVerificationError('truncated');
      }
      const out = new Uint8Array(length);
      let done = 0;
      try {
        while (done < length) {
          const { bytesRead } = await handle.read(
            out,
            done,
            length - done,
            position + done,
          );
          if (bytesRead === 0) throw new NativeVerificationError('truncated');
          done += bytesRead;
        }
      } catch (error) {
        if (error instanceof NativeVerificationError) throw error;
        throw new NativeVerificationError('read_failed');
      }
      return out;
    },
    close: () => handle.close(),
  };
}

/** What the parsers use: a reader that enforces size, caps and fixed errors. */
export interface BudgetedReader {
  readonly size: number;
  bytes(position: number, length: number): Promise<Buffer>;
}

/** Wrap `inner` with the per-file read budget. One wrapper per file. */
export function budgeted(inner: ByteReader): BudgetedReader {
  let used = 0;
  return {
    size: inner.size,
    async bytes(position, length) {
      if (
        !Number.isSafeInteger(position) ||
        !Number.isSafeInteger(length) ||
        position < 0 ||
        length < 0 ||
        position + length > inner.size
      ) {
        throw new NativeVerificationError('truncated');
      }
      if (
        length > MAX_SINGLE_READ_BYTES ||
        used + length > MAX_TOTAL_READ_BYTES
      ) {
        throw new NativeVerificationError('read_limit');
      }
      used += length;
      let got: Uint8Array;
      try {
        got = await inner.read(position, length);
      } catch (error) {
        if (error instanceof NativeVerificationError) throw error;
        throw new NativeVerificationError('read_failed');
      }
      if (got.length !== length) throw new NativeVerificationError('truncated');
      return Buffer.from(got.buffer, got.byteOffset, got.length);
    },
  };
}

/** Read a u64 as a safe integer; anything larger is a malformed offset. */
export function safeU64(value: bigint): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new NativeVerificationError('truncated');
  }
  return Number(value);
}
