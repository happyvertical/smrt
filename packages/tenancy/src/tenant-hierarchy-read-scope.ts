import { AsyncLocalStorage } from 'node:async_hooks';

/** A trusted, list-only scope issued by an owning authorization package. */
export interface TenantHierarchyReadScope {
  actorTenantId: string;
  actorUserId: string;
  collections: readonly string[];
  includeGlobal: boolean;
  tenantIds: readonly string[];
}

const KEY = Symbol.for('smrt:tenant-hierarchy-read-scope');
const root = globalThis as typeof globalThis & {
  [KEY]?: AsyncLocalStorage<TenantHierarchyReadScope>;
};
root[KEY] ??= new AsyncLocalStorage<TenantHierarchyReadScope>();
const storage = root[KEY];

export function getTenantHierarchyReadScope():
  | TenantHierarchyReadScope
  | undefined {
  return storage.getStore();
}

/**
 * Run a scope already authorized by its owning package. This capability is
 * intentionally list-only: the tenancy interceptor rejects mutations and raw
 * SQL while it is active. It is not an entry-point or generated-surface API.
 */
export async function runTenantHierarchyReadScope<T>(
  scope: TenantHierarchyReadScope,
  callback: () => Promise<T>,
): Promise<T> {
  if (
    !scope.actorTenantId ||
    !scope.actorUserId ||
    scope.collections.length === 0 ||
    scope.tenantIds.length === 0 ||
    scope.collections.some((collection) => !collection) ||
    scope.tenantIds.some((tenantId) => !tenantId) ||
    storage.getStore()
  ) {
    throw new Error('Invalid or nested tenant hierarchy read scope');
  }
  return await storage.run(
    {
      ...scope,
      collections: [...new Set(scope.collections)],
      tenantIds: [...new Set(scope.tenantIds)],
    },
    callback,
  );
}
