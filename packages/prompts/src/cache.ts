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
/**
 * Source of every generation value. Drawing from one counter instead of
 * incrementing each key independently makes a generation unique across every
 * key and every clear, which is what lets `clearedThrough` work as a floor.
 */
let nextGeneration = 1;
/**
 * Floor that `clearPromptCache()` raises for *every* key, including keys with
 * no map entry. A key that has never been invalidated in this process reads as
 * generation 0, so a resolution that captured 0 before a clear would still see
 * 0 after it and write its pre-clear value back — the flush would be silently
 * undone for the rest of the TTL.
 */
let clearedThrough = 0;
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
  cacheGenerations.set(buildGenerationKey(key, db), nextGeneration++);
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
 *
 * A key with no entry of its own reports the {@link clearPromptCache} floor
 * rather than a bare 0, so a clear refuses in-flight writes for keys that have
 * never been invalidated too.
 */
export function getPromptCacheGeneration(
  key: string,
  db: DatabaseInterface | unknown,
): number {
  const generation = cacheGenerations.get(buildGenerationKey(key, db)) ?? 0;
  return generation > clearedThrough ? generation : clearedThrough;
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
  // Raise the floor instead of resetting counters: a resolution that started
  // before the clear must be refused its write, and raising a single floor
  // covers keys with no generation entry, which a per-key bump cannot reach.
  // With the floor carrying the refusal, the per-key entries can be dropped.
  clearedThrough = nextGeneration++;
  cacheGenerations.clear();
}
