import type { DatabaseInterface } from '@happyvertical/sql';
import type { PlaybookCacheValue } from './types.js';

const PLAYBOOK_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: PlaybookCacheValue;
};

const playbookCache = new Map<string, CacheEntry>();
/** Monotonic per-`(db, key)` invalidation counter; see getPlaybookCacheGeneration. */
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

/**
 * The cache namespace a database handle resolves to.
 *
 * Exported so the preflight cache (#2590) partitions by the same database
 * identity this cache does, rather than growing a second, divergent notion of
 * "which database is this".
 *
 * @internal
 */
export function playbookCacheNamespace(db: unknown): string {
  return getDbNamespace(db);
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

/**
 * Reads the current invalidation generation for a key.
 *
 * A resolution captures this *before* its asynchronous layer loads and hands
 * it back to {@link setCachedPlaybookBase}. Any write that lands while those
 * loads are in flight bumps the generation, so the in-flight resolution — which
 * read the pre-write layers — is refused the cache write instead of
 * repopulating the key it just invalidated. Without this, the acceptance rule
 * "a stale entry is never served after a write" held only until a read raced a
 * write, and then failed for the full TTL.
 *
 * Tracked per `(db, key)` rather than per `(db, key, tenantId)`: an app-level
 * row is inherited by every tenant, so a write to any scope of a key must
 * invalidate every scope of it.
 */
export function getPlaybookCacheGeneration(
  key: string,
  db: DatabaseInterface | unknown,
): number {
  return cacheGenerations.get(buildGenerationKey(key, db)) ?? 0;
}

export function setCachedPlaybookBase(
  key: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: PlaybookCacheValue,
  loadedAtGeneration: number,
): void {
  if (getPlaybookCacheGeneration(key, db) !== loadedAtGeneration) {
    // A write landed while this resolution was loading. Its value is already
    // stale, so drop it rather than poison the key for the whole TTL.
    return;
  }

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
  bumpGeneration(key, db);

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
  // Generations deliberately survive: resetting them to zero would let a
  // resolution that started before the clear write its stale value back.
  for (const generationKey of cacheGenerations.keys()) {
    cacheGenerations.set(
      generationKey,
      (cacheGenerations.get(generationKey) ?? 0) + 1,
    );
  }
}
