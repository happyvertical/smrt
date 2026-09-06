import type { DatabaseInterface } from '@happyvertical/sql';
import type { PromptCacheValue } from './types.js';

const PROMPT_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: PromptCacheValue;
};

const promptCache = new Map<string, CacheEntry>();
/** Monotonic per-`(db, key)` invalidation counter; see getPromptCacheGeneration. */
const cacheGenerations = new Map<string, number>();
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

function buildGenerationKey(
  key: string,
  db: DatabaseInterface | unknown,
): string {
  return `${getDbNamespace(db)}::${key}`;
}

function bumpGeneration(key: string, db: DatabaseInterface | unknown): void {
  const generationKey = buildGenerationKey(key, db);
  cacheGenerations.set(
    generationKey,
    (cacheGenerations.get(generationKey) ?? 0) + 1,
  );
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

/**
 * Reads the current invalidation generation for a key.
 *
 * A resolution captures this *before* its asynchronous layer loads and hands
 * it back to {@link setCachedPromptBase}. Any write that lands while those
 * loads are in flight bumps the generation, so the in-flight resolution —
 * which read the pre-write layers — is refused the cache write instead of
 * repopulating the key it just invalidated. Without this, a read that raced a
 * write served the pre-write value for the full TTL, and a raced `delete()`
 * resurrected the deleted override.
 *
 * Tracked per `(db, key)` rather than per `(db, key, tenantId)`: an app-level
 * row is inherited by every tenant, so a write to any scope of a key must
 * invalidate every scope of it. This matches the coarsest fan-out of
 * {@link invalidatePromptCache}.
 */
export function getPromptCacheGeneration(
  key: string,
  db: DatabaseInterface | unknown,
): number {
  return cacheGenerations.get(buildGenerationKey(key, db)) ?? 0;
}

export function setCachedPromptBase(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: PromptCacheValue,
  loadedAtGeneration: number,
): void {
  if (getPromptCacheGeneration(key, db) !== loadedAtGeneration) {
    // A write landed while this resolution was loading. Its value is already
    // stale, so drop it rather than poison the key for the whole TTL.
    return;
  }

  promptCache.set(buildCacheKey(key, tenantId, db), {
    expiresAt: Date.now() + PROMPT_CACHE_TTL_MS,
    value,
  });
}

/**
 * Invalidates a cached resolution. An app-level write (tenantId null) clears
 * every tenant's entry for that key, because each tenant inherits from it.
 */
export function invalidatePromptCache(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): void {
  const dbNamespace = getDbNamespace(db);
  bumpGeneration(key, db);

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
  // Generations deliberately survive: resetting them to zero would let a
  // resolution that started before the clear write its stale value back.
  for (const generationKey of cacheGenerations.keys()) {
    cacheGenerations.set(
      generationKey,
      (cacheGenerations.get(generationKey) ?? 0) + 1,
    );
  }
}
