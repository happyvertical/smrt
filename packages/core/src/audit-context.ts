import { AsyncLocalStorage } from 'node:async_hooks';
import type { CollectionAuditOptions } from './audit.js';

const STORAGE = Symbol.for('smrt.audit.storage');
const CONTEXT = Symbol.for('smrt.audit.context');
const shared = globalThis as unknown as Record<symbol, unknown>;
if (!shared[STORAGE]) {
  shared[STORAGE] = new AsyncLocalStorage<CollectionAuditOptions>();
}
const storage = shared[STORAGE] as AsyncLocalStorage<CollectionAuditOptions>;
shared[CONTEXT] = () => storage.getStore();

/** Bind trusted identity/sink to this async request, including generated CRUD. */
export function withAuditContext<T>(
  options: CollectionAuditOptions,
  operation: () => T,
): T {
  return storage.run(Object.freeze({ ...options }), operation);
}
