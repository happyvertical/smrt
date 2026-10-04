/**
 * Camera session lifecycle against a fake `MediaDevices` (smrt#3290).
 * Ported from teamworks-os `camera-capture-session.test.ts` and
 * `camera-capture-logic.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  classifyGetUserMediaError,
  createCameraSession,
  isCameraApiSupported,
} from '../camera-capture-session.js';

function fakeStream(tracks: { stop: () => void }[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('isCameraApiSupported', () => {
  it('is false without navigator, mediaDevices, or getUserMedia', () => {
    expect(isCameraApiSupported(undefined)).toBe(false);
    expect(isCameraApiSupported({ mediaDevices: undefined })).toBe(false);
    expect(isCameraApiSupported({ mediaDevices: {} })).toBe(false);
    expect(
      isCameraApiSupported({ mediaDevices: { getUserMedia: 'nope' } }),
    ).toBe(false);
  });

  it('is true when getUserMedia is a function', () => {
    expect(
      isCameraApiSupported({
        mediaDevices: { getUserMedia: async () => ({}) },
      }),
    ).toBe(true);
  });
});

describe('classifyGetUserMediaError', () => {
  it.each([
    'NotAllowedError',
    'PermissionDeniedError',
    'SecurityError',
  ])('maps %s to permission-denied', (name) => {
    expect(classifyGetUserMediaError(new DOMException('x', name))).toBe(
      'permission-denied',
    );
  });

  it.each([
    'NotFoundError',
    'DevicesNotFoundError',
    'OverconstrainedError',
  ])('maps %s to no-camera', (name) => {
    expect(classifyGetUserMediaError(new DOMException('x', name))).toBe(
      'no-camera',
    );
  });

  it('maps unknown names and non-errors to error', () => {
    expect(classifyGetUserMediaError(new DOMException('x', 'AbortError'))).toBe(
      'error',
    );
    expect(classifyGetUserMediaError(new Error('boom'))).toBe('error');
    expect(classifyGetUserMediaError('not an error')).toBe('error');
    expect(classifyGetUserMediaError(null)).toBe('error');
    expect(classifyGetUserMediaError({ name: 42 })).toBe('error');
  });

  it('reads name from a plain object, as browser DOMExceptions are not Errors', () => {
    expect(classifyGetUserMediaError({ name: 'NotAllowedError' })).toBe(
      'permission-denied',
    );
  });
});

describe('createCameraSession', () => {
  it('reports unsupported without touching any API', async () => {
    const session = createCameraSession({ mediaDevices: undefined });
    await expect(session.start('environment')).resolves.toMatchObject({
      ok: false,
      kind: 'unsupported',
    });
  });

  it('classifies rejections and keeps the diagnostic message', async () => {
    const denied = createCameraSession({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(
            new DOMException('Permission denied', 'NotAllowedError'),
          ),
      },
    });
    await expect(denied.start('environment')).resolves.toEqual({
      ok: false,
      kind: 'permission-denied',
      message: 'Permission denied',
    });

    const missing = createCameraSession({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException('No device', 'NotFoundError')),
      },
    });
    await expect(missing.start('environment')).resolves.toEqual({
      ok: false,
      kind: 'no-camera',
      message: 'No device',
    });

    const odd = createCameraSession({
      mediaDevices: { getUserMedia: vi.fn().mockRejectedValue('weird') },
    });
    await expect(odd.start('environment')).resolves.toMatchObject({
      ok: false,
      kind: 'error',
      message: expect.any(String),
    });
  });

  it('requests video only with the given facing mode and exposes the stream', async () => {
    const stream = fakeStream([{ stop: vi.fn() }]);
    const getUserMedia = vi.fn().mockResolvedValue(stream);
    const session = createCameraSession({ mediaDevices: { getUserMedia } });

    await expect(session.start('user')).resolves.toEqual({ ok: true, stream });
    expect(session.stream).toBe(stream);
    expect(getUserMedia).toHaveBeenCalledWith({
      video: { facingMode: 'user' },
      audio: false,
    });
  });

  it('stops every track once and forgets the stream; stop is idempotent', async () => {
    const a = { stop: vi.fn() };
    const b = { stop: vi.fn() };
    const session = createCameraSession({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(fakeStream([a, b])),
      },
    });
    await session.start('environment');

    session.stop();
    session.stop();

    expect(a.stop).toHaveBeenCalledTimes(1);
    expect(b.stop).toHaveBeenCalledTimes(1);
    expect(session.stream).toBeNull();
  });

  it('stop before any start is a safe no-op', () => {
    const session = createCameraSession({ mediaDevices: undefined });
    expect(() => session.stop()).not.toThrow();
    expect(session.stream).toBeNull();
  });

  it('discards a stream granted after stop() and releases its tracks', async () => {
    const pending = deferred<MediaStream>();
    const track = { stop: vi.fn() };
    const session = createCameraSession({
      mediaDevices: { getUserMedia: vi.fn().mockReturnValue(pending.promise) },
    });

    const result = session.start('environment');
    session.stop();
    pending.resolve(fakeStream([track]));

    await expect(result).resolves.toMatchObject({
      ok: false,
      kind: 'cancelled',
    });
    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(session.stream).toBeNull();
  });

  it('discards a rejection that settles after stop()', async () => {
    const pending = deferred<MediaStream>();
    const session = createCameraSession({
      mediaDevices: { getUserMedia: vi.fn().mockReturnValue(pending.promise) },
    });

    const result = session.start('environment');
    session.stop();
    pending.reject(new DOMException('denied', 'NotAllowedError'));

    await expect(result).resolves.toMatchObject({
      ok: false,
      kind: 'cancelled',
    });
  });

  it('a newer start supersedes a pending one, so overlapping requests never leak', async () => {
    const first = deferred<MediaStream>();
    const firstTrack = { stop: vi.fn() };
    const secondStream = fakeStream([{ stop: vi.fn() }]);
    const getUserMedia = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce(secondStream);
    const session = createCameraSession({ mediaDevices: { getUserMedia } });

    const stale = session.start('environment');
    const fresh = session.start('user');
    await expect(fresh).resolves.toEqual({ ok: true, stream: secondStream });
    first.resolve(fakeStream([firstTrack]));

    await expect(stale).resolves.toMatchObject({
      ok: false,
      kind: 'cancelled',
    });
    expect(firstTrack.stop).toHaveBeenCalledTimes(1);
    expect(session.stream).toBe(secondStream);
  });

  it('starting again releases the held stream first', async () => {
    const oldTrack = { stop: vi.fn() };
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(fakeStream([oldTrack]))
      .mockResolvedValueOnce(fakeStream([{ stop: vi.fn() }]));
    const session = createCameraSession({ mediaDevices: { getUserMedia } });

    await session.start('environment');
    await session.start('environment');

    expect(oldTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('a fresh start after stop is not treated as stale', async () => {
    const session = createCameraSession({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockResolvedValue(fakeStream([{ stop: vi.fn() }])),
      },
    });
    await session.start('environment');
    session.stop();
    await expect(session.start('environment')).resolves.toMatchObject({
      ok: true,
    });
    expect(session.stream).not.toBeNull();
  });
});
