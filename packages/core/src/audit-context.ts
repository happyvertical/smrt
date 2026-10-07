import type { CollectionAuditOptions } from './audit.js';
import {
  type AsyncContext,
  createAsyncContext,
} from './utils/async-context.js';

const STORAGE = Symbol.for('smrt.audit.storage');
const CONTEXT = Symbol.for('smrt.audit.context');
const shared = globalThis as unknown as Record<symbol, unknown>;
if (!shared[STORAGE]) {
  shared[STORAGE] = createAsyncContext<CollectionAuditOptions>();
}
const storage = shared[STORAGE] as AsyncContext<CollectionAuditOptions>;
shared[CONTEXT] = () => storage.getStore();

/** Bind trusted identity/sink to this async request, including generated CRUD. */
export function withAuditContext<T>(
  options: CollectionAuditOptions,
  operation: () => T,
): T {
  return storage.run(Object.freeze({ ...options }), operation);
}
