import type { DatabaseInterface } from '@happyvertical/sql';
import type { PlaybookCacheValue } from './types.js';

const PLAYBOOK_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: PlaybookCacheValue;
};

const playbookCache = new Map<string, CacheEntry>();
const dbInstanceIds = new WeakMap<object, string>();
let nextDbId = 1;

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
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): string {
  return `${getDbNamespace(db)}::${key}::${tenantId ?? 'app'}`;
}

export function getPlaybookCacheTtlMs(): number {
  return PLAYBOOK_CACHE_TTL_MS;
}

export function getCachedPlaybookBase(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): PlaybookCacheValue | null {
  const cacheKey = buildCacheKey(key, tenantId, db);
  const cached = playbookCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    playbookCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

export function setCachedPlaybookBase(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: PlaybookCacheValue,
): void {
  playbookCache.set(buildCacheKey(key, tenantId, db), {
    expiresAt: Date.now() + PLAYBOOK_CACHE_TTL_MS,
    value,
  });
}

/**
 * Invalidates a cached resolution. An app-level write (tenantId null) clears
 * every tenant's entry for that key, because each tenant inherits from it.
 */
export function invalidatePlaybookCache(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): void {
  const dbNamespace = getDbNamespace(db);

  if (tenantId !== null && tenantId !== undefined) {
    playbookCache.delete(buildCacheKey(key, tenantId, db));
    return;
  }

  const keyPrefix = `${dbNamespace}::${key}::`;
  for (const cacheKey of playbookCache.keys()) {
    if (cacheKey.startsWith(keyPrefix)) {
      playbookCache.delete(cacheKey);
    }
  }
}

export function clearPlaybookCache(): void {
  playbookCache.clear();
}
