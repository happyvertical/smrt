/**
 * The submission key and its slot (#3291): one key per filled-in form,
 * rotated at most once, never rotated by a late result, and never lost to a
 * storage error.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  beginSubmit,
  clearSubmissionKey,
  isSubmissionKeyPersistent,
  mintSubmissionKey,
  readSubmissionKey,
  resetFormRetryMemory,
  rotateSubmissionKey,
  type SubmissionSlot,
  settleSubmit,
  submitDisposition,
} from '../submission-key.js';
import {
  fullStorage,
  memoryStorage,
  refusingStorage,
  stickyStorage,
} from './storage.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

beforeEach(() => {
  resetFormRetryMemory();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('submitDisposition', () => {
  const LIVE = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const STALE = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  it('rotates on a confirmed write', () => {
    expect(submitDisposition(LIVE, LIVE, 'success')).toBe('rotate-and-apply');
  });

  it('keeps the key on a validation failure, which wrote nothing', () => {
    expect(submitDisposition(LIVE, LIVE, 'failure')).toBe('apply');
  });

  it('keeps the key AND the form on a transport error', () => {
    expect(submitDisposition(LIVE, LIVE, 'error')).toBe('transport-error');
  });

  it('ignores every result whose key is no longer the live one', () => {
    for (const outcome of [
      'success',
      'failure',
      'redirect',
      'error',
    ] as const) {
      expect(submitDisposition(STALE, LIVE, outcome)).toBe('ignore');
      expect(submitDisposition(LIVE, null, outcome)).toBe('ignore');
    }
  });

  it('treats a redirect as unconfirmed unless the caller says otherwise', () => {
    expect(submitDisposition(LIVE, LIVE, 'redirect')).toBe('apply');
    expect(
      submitDisposition(LIVE, LIVE, 'redirect', {
        redirectConfirmsWrite: true,
      }),
    ).toBe('rotate-and-apply');
  });
});

describe('the submission slot', () => {
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const idle = (token = A): SubmissionSlot => ({ token, inFlight: null });

  it('refuses a SECOND submit while one is unresolved', () => {
    const first = beginSubmit(idle());
    expect(first).toMatchObject({ start: true, sent: A });
    const second = beginSubmit(first.state);
    expect(second.start).toBe(false);
    expect(second.state).toEqual(first.state);
  });

  it('accepts the next submit once the first has settled', () => {
    const first = beginSubmit(idle());
    const settled = settleSubmit(first.state, first.sent, 'success', {
      formCleared: true,
      mint: () => B,
    });
    expect(settled).toEqual({
      state: { token: B, inFlight: null },
      disposition: 'rotate-and-apply',
    });
    expect(beginSubmit(settled.state)).toMatchObject({ start: true, sent: B });
  });

  it('keeps the key when the submit wrote nothing', () => {
    for (const outcome of ['failure', 'error'] as const) {
      const first = beginSubmit(idle());
      const settled = settleSubmit(first.state, first.sent, outcome, {
        formCleared: true,
        mint: () => B,
      });
      expect(settled.state, outcome).toEqual({ token: A, inFlight: null });
    }
  });

  it('ignores a duplicate answer to a submit already settled', () => {
    const first = beginSubmit(idle());
    const settled = settleSubmit(first.state, first.sent, 'success', {
      formCleared: true,
      mint: () => B,
    });
    const late = settleSubmit(settled.state, first.sent, 'success', {
      formCleared: true,
      mint: () => C,
    });
    expect(late).toEqual({ state: settled.state, disposition: 'ignore' });
  });

  it('rotates at most once however many answers arrive', () => {
    const begun = beginSubmit(idle());
    let state = begun.state;
    const mint = vi.fn(() => B);
    for (let i = 0; i < 3; i += 1) {
      state = settleSubmit(state, begun.sent, 'success', {
        formCleared: true,
        mint,
      }).state;
    }
    expect(mint).toHaveBeenCalledTimes(1);
  });

  it('KEEPS the key when a confirmed write left content on the form', () => {
    const first = beginSubmit(idle());
    const settled = settleSubmit(first.state, first.sent, 'success', {
      formCleared: false,
      mint: () => B,
    });
    expect(settled).toEqual({
      state: { token: A, inFlight: null },
      disposition: 'rotate-and-apply',
    });
  });
});

describe('the key store', () => {
  it('returns one stable UUID per form until it is rotated', () => {
    const storage = memoryStorage();
    const first = readSubmissionKey({ form: 'po-line', storage });
    expect(first).toMatch(UUID_V4);
    expect(readSubmissionKey({ form: 'po-line', storage })).toBe(first);
    const rotated = rotateSubmissionKey({ form: 'po-line', storage });
    expect(rotated).not.toBe(first);
    expect(readSubmissionKey({ form: 'po-line', storage })).toBe(rotated);
  });

  it('keeps forms and scopes apart, under derived names', () => {
    const storage = memoryStorage();
    const a = readSubmissionKey({ form: 'receipt', scope: 'po/a', storage });
    const b = readSubmissionKey({ form: 'receipt', scope: 'po-b', storage });
    const other = readSubmissionKey({ form: 'request', storage });
    expect(new Set([a, b, other]).size).toBe(3);
    expect([...storage.store.keys()].sort()).toEqual([
      'smrt:form-retry:receipt:po%2Fa:key',
      'smrt:form-retry:receipt:po-b:key',
      'smrt:form-retry:request:key',
    ]);
    clearSubmissionKey({ form: 'receipt', scope: 'po-b', storage });
    expect(readSubmissionKey({ form: 'receipt', scope: 'po/a', storage })).toBe(
      a,
    );
  });

  it('honours an explicit storage name, for migrating existing keys', () => {
    const storage = memoryStorage();
    storage.store.set('legacy:flha:submission-key', 'carried');
    expect(
      readSubmissionKey({
        form: 'flha',
        storage,
        storageKey: 'legacy:flha:submission-key',
      }),
    ).toBe('carried');
  });

  it('uses this tab sessionStorage by default, never localStorage', () => {
    const session = memoryStorage();
    const local = memoryStorage();
    vi.stubGlobal('sessionStorage', session);
    vi.stubGlobal('localStorage', local);
    const key = readSubmissionKey({ form: 'po' });
    expect(session.store.get('smrt:form-retry:po:key')).toBe(key);
    expect(local.store.size).toBe(0);
    expect(isSubmissionKeyPersistent({ form: 'po' })).toBe(true);
  });

  it('private window: falls back to memory, and the key still survives a remount', () => {
    const storage = refusingStorage();
    const first = readSubmissionKey({ form: 'po', storage });
    // One page, two mounts: the second read must find the same key or a retry
    // after `enhance`'s error path would carry a key the server never saw.
    expect(readSubmissionKey({ form: 'po', storage })).toBe(first);
    expect(isSubmissionKeyPersistent({ form: 'po', storage })).toBe(false);
    expect(() => clearSubmissionKey({ form: 'po', storage })).not.toThrow();
    expect(readSubmissionKey({ form: 'po', storage })).not.toBe(first);
  });

  it('private window: survives the sessionStorage property itself throwing', () => {
    const original = Object.getOwnPropertyDescriptor(
      globalThis,
      'sessionStorage',
    );
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      const first = readSubmissionKey({ form: 'po' });
      expect(first).toMatch(UUID_V4);
      expect(readSubmissionKey({ form: 'po' })).toBe(first);
    } finally {
      if (original)
        Object.defineProperty(globalThis, 'sessionStorage', original);
    }
  });

  it('a refused write (full quota) still reads back the same key', () => {
    const storage = fullStorage();
    const first = readSubmissionKey({ form: 'po', storage });
    expect(readSubmissionKey({ form: 'po', storage })).toBe(first);
  });

  it('rotates even when the store refuses to remove the old key', () => {
    const storage = stickyStorage();
    const first = readSubmissionKey({ form: 'po', storage });
    const rotated = rotateSubmissionKey({ form: 'po', storage });
    expect(rotated).not.toBe(first);
    expect(readSubmissionKey({ form: 'po', storage })).toBe(rotated);
    expect(storage.store.get('smrt:form-retry:po:key')).toBe(rotated);
    expect(isSubmissionKeyPersistent({ form: 'po', storage })).toBe(true);
  });

  it('rotates when removal AND the replacement write are refused over an existing key', () => {
    const storage = stickyStorage(true);
    storage.store.set('smrt:form-retry:po:key', 'stale-key');
    expect(readSubmissionKey({ form: 'po', storage })).toBe('stale-key');
    const rotated = rotateSubmissionKey({ form: 'po', storage });
    expect(rotated).not.toBe('stale-key');
    // The fresh key lives in memory and takes precedence over stale storage.
    expect(readSubmissionKey({ form: 'po', storage })).toBe(rotated);
    expect(isSubmissionKeyPersistent({ form: 'po', storage })).toBe(false);
  });

  it.each([
    ['writes still work', false],
    ['writes are refused too', true],
  ] as const)('clearing a key the store will not remove mints a fresh one (%s)', (_label, refuseWrites) => {
    const storage = stickyStorage();
    const first = readSubmissionKey({ form: 'po', storage });
    storage.refuseWrites = refuseWrites;
    clearSubmissionKey({ form: 'po', storage });
    const next = readSubmissionKey({ form: 'po', storage });
    expect(next).not.toBe(first);
    expect(next).toMatch(UUID_V4);
    expect(readSubmissionKey({ form: 'po', storage })).toBe(next);
    expect(isSubmissionKeyPersistent({ form: 'po', storage })).toBe(
      !refuseWrites,
    );
  });

  it('`storage: null` keeps everything in memory', () => {
    const first = readSubmissionKey({ form: 'po', storage: null });
    expect(readSubmissionKey({ form: 'po', storage: null })).toBe(first);
    expect(isSubmissionKeyPersistent({ form: 'po', storage: null })).toBe(
      false,
    );
  });

  it('mints distinct v4 UUIDs', () => {
    const keys = new Set(Array.from({ length: 50 }, mintSubmissionKey));
    expect(keys.size).toBe(50);
    for (const key of keys) expect(key).toMatch(UUID_V4);
  });
});
