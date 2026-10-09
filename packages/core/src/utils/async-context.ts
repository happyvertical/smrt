/**
 * Async-local state that survives `await`, without a static `node:async_hooks`
 * import (#2838).
 *
 * A Node host backs it with `AsyncLocalStorage`, resolved through
 * `process.getBuiltinModule()` so a browser bundle never reaches the built-in.
 * Browsers have no equivalent that propagates through promises, so there
 * `run()` only calls the callback, `getStore()` stays empty, and
 * `propagatesAcrossAwait` is false. Callers whose correctness needs the
 * store to reach nested async work (re-entrant locks) must check that flag
 * and not rely on the store when it is false.
 */

export interface AsyncContext<T> {
  /** Whether a value passed to `run()` reaches async work started inside it. */
  readonly propagatesAcrossAwait: boolean;
  /** Run `callback` with `store` visible to `getStore()` for its async extent. */
  run<R>(store: T, callback: () => R): R;
  /** The value of the innermost enclosing `run()`, if any. */
  getStore(): T | undefined;
}

type AsyncLocalStorageConstructor = new <T>() => {
  run<R>(store: T, callback: () => R): R;
  getStore(): T | undefined;
};

function resolveAsyncLocalStorage(): AsyncLocalStorageConstructor | undefined {
  if (typeof process === 'undefined') return undefined;
  const getBuiltinModule = (
    process as typeof process & { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') return undefined;
  const hooks = getBuiltinModule('node:async_hooks') as
    | { AsyncLocalStorage?: AsyncLocalStorageConstructor }
    | undefined;
  return hooks?.AsyncLocalStorage;
}

export function createAsyncContext<T>(): AsyncContext<T> {
  const Storage = resolveAsyncLocalStorage();
  if (Storage) {
    const storage = new Storage<T>();
    return {
      propagatesAcrossAwait: true,
      run: (store, callback) => storage.run(store, callback),
      getStore: () => storage.getStore(),
    };
  }
  return {
    propagatesAcrossAwait: false,
    run: (_store, callback) => callback(),
    getStore: () => undefined,
  };
}
