import { describe, expect, it } from 'vitest';
import type { FileHandleLike } from '../../internal/fs-seam.js';
import { NativeVerificationError, nativeErrorMessage } from './errors.js';
import {
  budgeted,
  bufferReader,
  fileHandleReader,
  MAX_SINGLE_READ_BYTES,
  MAX_TOTAL_READ_BYTES,
  safeU64,
} from './reader.js';

const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(NativeVerificationError);
    return (error as NativeVerificationError).code;
  }
  return 'resolved';
};

describe('budgeted reader', () => {
  const reader = budgeted(bufferReader(Buffer.alloc(8 * 1024 * 1024)));

  it('rejects out-of-range and non-integer reads as truncated', async () => {
    for (const [at, len] of [
      [-1, 1],
      [0, -1],
      [8 * 1024 * 1024 - 1, 2],
      [1.5, 1],
      [0, Number.NaN],
      [Number.MAX_SAFE_INTEGER, 1],
      [Number.POSITIVE_INFINITY, 1],
    ] as const) {
      expect(await code(reader.bytes(at, len))).toBe('truncated');
    }
  });

  it('caps a single read and the cumulative budget', async () => {
    const fresh = budgeted(bufferReader(Buffer.alloc(8 * 1024 * 1024)));
    expect(await code(fresh.bytes(0, MAX_SINGLE_READ_BYTES + 1))).toBe(
      'read_limit',
    );
    for (let i = 0; i < MAX_TOTAL_READ_BYTES / MAX_SINGLE_READ_BYTES; i++) {
      await fresh.bytes(0, MAX_SINGLE_READ_BYTES);
    }
    expect(await code(fresh.bytes(0, 1))).toBe('read_limit');
  });

  it('maps foreign errors and short reads to fixed codes', async () => {
    const boom = budgeted({
      size: 10,
      read: () => Promise.reject(new Error('/private/path leaked')),
    });
    expect(await code(boom.bytes(0, 4))).toBe('read_failed');
    const short = budgeted({ size: 10, read: async () => new Uint8Array(2) });
    expect(await code(short.bytes(0, 4))).toBe('truncated');
  });

  it('safeU64 rejects values past the safe integer range', () => {
    expect(safeU64(5n)).toBe(5);
    expect(() => safeU64(2n ** 53n)).toThrowError(
      nativeErrorMessage('truncated'),
    );
  });
});

describe('fileHandleReader', () => {
  const handle = (data: Buffer, overrides: Partial<FileHandleLike> = {}) =>
    ({
      stat: async () => ({ size: data.length }) as never,
      read: async (
        buffer: Uint8Array,
        offset: number,
        length: number,
        pos: number | null,
      ) => {
        const slice = data.subarray(pos ?? 0, (pos ?? 0) + length);
        buffer.set(slice, offset);
        return { bytesRead: slice.length };
      },
      write: async () => ({ bytesWritten: 0 }),
      sync: async () => {},
      close: async () => {},
      ...overrides,
    }) as FileHandleLike;

  it('reads through the descriptor bounded by its own fstat size', async () => {
    const reader = await fileHandleReader(handle(Buffer.from('abcdefgh')));
    expect(reader.size).toBe(8);
    expect(Buffer.from(await reader.read(2, 3)).toString()).toBe('cde');
    expect(await code(reader.read(6, 4))).toBe('truncated');
  });

  it('reports truncation when the file shrinks and I/O failures as read_failed', async () => {
    const shrinking = await fileHandleReader(
      handle(Buffer.from('abc'), {
        stat: async () => ({ size: 100 }) as never,
      }),
    );
    expect(await code(shrinking.read(0, 50))).toBe('truncated');
    const failing = await fileHandleReader(
      handle(Buffer.from('abc'), {
        read: async () => {
          throw new Error('EIO /secret');
        },
      }),
    );
    expect(await code(failing.read(0, 1))).toBe('read_failed');
    expect(
      await code(
        fileHandleReader(
          handle(Buffer.alloc(1), {
            stat: async () => {
              throw new Error('EBADF /secret');
            },
          }),
        ),
      ),
    ).toBe('read_failed');
  });

  it('accepts a bigint size', async () => {
    const reader = await fileHandleReader(
      handle(Buffer.from('xy'), { stat: async () => ({ size: 2n }) as never }),
    );
    expect(reader.size).toBe(2);
  });
});

describe('error messages', () => {
  it('are fixed and value-free', () => {
    const error = new NativeVerificationError('verification_failed', [
      { path: 'a/secret-looking-path.node', reason: 'wrong_machine' },
    ]);
    expect(error.message).toBe(
      'Bundle contains native files that do not match the target',
    );
    expect(error.message).not.toContain('secret');
    expect(error.failures).toHaveLength(1);
    expect(Object.isFrozen(error.failures)).toBe(true);
  });
});
