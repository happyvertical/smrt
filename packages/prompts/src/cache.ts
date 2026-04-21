import type { DatabaseInterface } from '@happyvertical/sql';
import type { PromptCacheValue } from './types.js';

const PROMPT_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: PromptCacheValue;
};

const promptCache = new Map<string, CacheEntry>();
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

export function getPromptCacheTtlMs(): number {
  return PROMPT_CACHE_TTL_MS;
}

export function getCachedPromptBase(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): PromptCacheValue | null {
  const cacheKey = buildCacheKey(key, tenantId, db);
  const cached = promptCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    promptCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

export function setCachedPromptBase(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: PromptCacheValue,
): void {
  promptCache.set(buildCacheKey(key, tenantId, db), {
    expiresAt: Date.now() + PROMPT_CACHE_TTL_MS,
    value,
  });
}

export function invalidatePromptCache(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): void {
  const dbNamespace = getDbNamespace(db);

  if (tenantId !== null && tenantId !== undefined) {
    promptCache.delete(buildCacheKey(key, tenantId, db));
    return;
  }

  const keyPrefix = `${dbNamespace}::${key}::`;
  for (const cacheKey of promptCache.keys()) {
    if (cacheKey.startsWith(keyPrefix)) {
      promptCache.delete(cacheKey);
    }
  }
}

export function clearPromptCache(): void {
  promptCache.clear();
}
