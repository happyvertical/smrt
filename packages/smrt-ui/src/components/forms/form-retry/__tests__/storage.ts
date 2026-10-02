/**
 * Storage doubles for the form-retry tests: a working per-test store, one that
 * refuses everything (a private window), and one that reads but refuses writes
 * (a full quota).
 */

import type { FormRetryStorage } from '../submission-key.js';

/** A `sessionStorage` that behaves like the real one. */
export function memoryStorage(): FormRetryStorage & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/** Every access throws, as `sessionStorage` does in a private window. */
export function refusingStorage(): FormRetryStorage {
  const refuse = (): never => {
    throw new DOMException('The operation is insecure.', 'SecurityError');
  };
  return { getItem: refuse, setItem: refuse, removeItem: refuse };
}

/** Reads work; writes throw `QuotaExceededError`. */
export function fullStorage(): FormRetryStorage & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    getItem: (key) => store.get(key) ?? null,
    setItem: () => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError');
    },
    removeItem: (key) => {
      store.delete(key);
    },
  };
}

/**
 * Reads work; `removeItem` throws, and so does `setItem` while `refuseWrites`
 * is set (a store that cannot let go of a value already in it). The flag can
 * be flipped mid-test to model a store that wrote earlier and refuses now.
 */
export function stickyStorage(refuseWrites = false): FormRetryStorage & {
  store: Map<string, string>;
  refuseWrites: boolean;
} {
  const store = new Map<string, string>();
  const storage = {
    store,
    refuseWrites,
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      if (storage.refuseWrites) {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      }
      store.set(key, value);
    },
    removeItem: () => {
      throw new DOMException('The operation is insecure.', 'SecurityError');
    },
  };
  return storage;
}
