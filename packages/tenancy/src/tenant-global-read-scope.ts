import { AsyncLocalStorage } from 'node:async_hooks';

// Separate from actor context: only the built-in list interceptor consumes it.
// Share across duplicate module graphs, as with the normal tenant context.
const KEY = Symbol.for('smrt:tenant-global-read-scope');
const root = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<string>;
};
root[KEY] ??= new AsyncLocalStorage<string>();
const storage = root[KEY];

export function getTenantGlobalReadScope(): string | undefined {
  return storage.getStore();
}

export function runTenantGlobalReadScope<T>(
  tenantId: string,
  callback: () => Promise<T>,
): Promise<T> {
  return storage.run(tenantId, callback);
}
