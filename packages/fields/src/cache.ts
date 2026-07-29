import type { DatabaseInterface } from '@happyvertical/sql';
import type { ExplainedObjectFieldPolicy } from './types.js';

const FIELD_POLICY_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: ExplainedObjectFieldPolicy;
};

const fieldPolicyCache = new Map<string, CacheEntry>();
const dbInstanceIds = new WeakMap<object, string>();
let nextDbId = 1;

/**
 * Namespace a cache key by database identity so parallel test databases (and
 * multi-database processes) never share entries. Mirrors
 * `packages/prompts/src/cache.ts` exactly.
 */
function getDbNamespace(db: unknown): string {
  if (!db) {
    return 'no-db';
  }

  if (typeof db === 'string') {
    return `db:${db}`;
  }

  if (typeof db === 'object') {
    const dbObject = db as Record<string, unknown>;
    if (typeof dbObject.query === 'function') {
      if (!dbInstanceIds.has(dbObject)) {
        dbInstanceIds.set(dbObject, `db-instance:${nextDbId++}`);
      }
      const namespace = dbInstanceIds.get(dbObject);
      if (namespace) {
        return namespace;
      }

      return 'db-instance:unknown';
    }

    try {
      return `db-config:${JSON.stringify(dbObject)}`;
    } catch {
      return 'db-config:opaque';
    }
  }

  return 'db:unknown';
}

function buildCacheKey(
  objectRef: string,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
  db: DatabaseInterface | unknown,
): string {
  return `${getDbNamespace(db)}::${objectRef}::${tenantId ?? 'app'}::${
    userId ?? 'user:none'
  }`;
}

export function getFieldPolicyCacheTtlMs(): number {
  return FIELD_POLICY_CACHE_TTL_MS;
}

export function getCachedFieldPolicy(
  objectRef: string,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
  db: DatabaseInterface | unknown,
): ExplainedObjectFieldPolicy | null {
  const cacheKey = buildCacheKey(objectRef, tenantId, userId, db);
  const cached = fieldPolicyCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    fieldPolicyCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

export function setCachedFieldPolicy(
  objectRef: string,
  tenantId: string | null | undefined,
  userId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: ExplainedObjectFieldPolicy,
): void {
  fieldPolicyCache.set(buildCacheKey(objectRef, tenantId, userId, db), {
    expiresAt: Date.now() + FIELD_POLICY_CACHE_TTL_MS,
    value,
  });
}

/**
 * Drop every cached resolution for `(db, objectRef)`.
 *
 * Deliberately coarser than the prompts precedent (which deletes a single
 * `(key, tenantId)` entry when the tenant is known): tenant HIERARCHY makes a
 * parent-tenant row change affect every descendant tenant's resolution, and a
 * lock or app-row change affects user-tier entries too, so precise
 * invalidation would have to know the whole tenant tree. Per-objectRef prefix
 * invalidation is always correct and the 30s TTL keeps the cost bounded.
 */
export function invalidateFieldPolicyCache(
  objectRef: string,
  db: DatabaseInterface | unknown,
): void {
  const keyPrefix = `${getDbNamespace(db)}::${objectRef}::`;
  for (const cacheKey of fieldPolicyCache.keys()) {
    if (cacheKey.startsWith(keyPrefix)) {
      fieldPolicyCache.delete(cacheKey);
    }
  }
}

export function clearFieldPolicyCache(): void {
  fieldPolicyCache.clear();
}
