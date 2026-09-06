import type { DatabaseInterface } from '@happyvertical/sql';
import type { LanguageCacheValue } from './types.js';
import { normalizeLocale } from './utils.js';

const LANGUAGE_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: LanguageCacheValue;
};

const languageCache = new Map<string, CacheEntry>();
/**
 * Monotonic per-`(db, key, locale)` invalidation counter; see
 * getLanguageCacheGeneration.
 */
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
  locale: string,
  tenantId: string | null | undefined,
  db: unknown,
): string {
  return `${getDbNamespace(db)}::${key}::${normalizeLocale(locale)}::${
    tenantId ?? 'app'
  }`;
}

function buildGenerationKey(
  key: string,
  locale: string,
  db: DatabaseInterface | unknown,
): string {
  return `${getDbNamespace(db)}::${key}::${normalizeLocale(locale)}`;
}

function bumpGeneration(
  key: string,
  locale: string,
  db: DatabaseInterface | unknown,
): void {
  const generationKey = buildGenerationKey(key, locale, db);
  cacheGenerations.set(
    generationKey,
    (cacheGenerations.get(generationKey) ?? 0) + 1,
  );
}

export function getLanguageCacheTtlMs(): number {
  return LANGUAGE_CACHE_TTL_MS;
}

export function getCachedLanguage(
  key: string,
  locale: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): LanguageCacheValue | null {
  const cacheKey = buildCacheKey(key, locale, tenantId, db);
  const cached = languageCache.get(cacheKey);

  if (!cached) {
    return null;
  }

  if (cached.expiresAt <= Date.now()) {
    languageCache.delete(cacheKey);
    return null;
  }

  return cached.value;
}

/**
 * Reads the current invalidation generation for a `(key, locale)` pair.
 *
 * A resolution captures this *before* its asynchronous layer loads and hands
 * it back to {@link setCachedLanguage}. Any write that lands while those loads
 * are in flight bumps the generation, so the in-flight resolution — which read
 * the pre-write layers — is refused the cache write instead of repopulating
 * the entry the write just invalidated. Without this, a read that raced a
 * write served the pre-write value for the full TTL, and a raced `delete()`
 * resurrected the deleted override.
 *
 * Granularity is `(db, key, locale)`, not `(db, key)` as in smrt-playbooks and
 * smrt-prompts, and not `(db, key, locale, tenantId)`:
 *
 * - `locale` is part of the key because every layer a cached entry is built
 *   from is read at exactly the locale it is cached under. `resolveLanguageString`
 *   walks a fallback chain (`fr-CA` → `fr` → `en`), but each attempt reads its
 *   own locale's rows (`getTenantOverride`/`getAppOverride` are called with
 *   that locale) and caches the result under that same locale; an attempt that
 *   resolves nothing caches nothing, so a fallback hit is never stored under
 *   the requested locale. Every writer — `LanguageOverride.save()`/`delete()`
 *   (both identities, when one changes) and the translation job — invalidates
 *   the same `(key, locale)` it wrote. A per-locale generation therefore still
 *   covers every write that can change what a cached entry was built from.
 * - `tenantId` is deliberately *not* part of the key, because an app-level row
 *   (tenantId null) is inherited by every tenant, so a write to any scope of a
 *   `(key, locale)` must be able to refuse an in-flight write for any other
 *   scope of it. This matches the coarsest fan-out of
 *   {@link invalidateLanguageCache}.
 */
export function getLanguageCacheGeneration(
  key: string,
  locale: string,
  db: DatabaseInterface | unknown,
): number {
  return cacheGenerations.get(buildGenerationKey(key, locale, db)) ?? 0;
}

export function setCachedLanguage(
  key: string,
  locale: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: LanguageCacheValue,
  loadedAtGeneration: number,
): void {
  if (getLanguageCacheGeneration(key, locale, db) !== loadedAtGeneration) {
    // A write landed while this resolution was loading. Its value is already
    // stale, so drop it rather than poison the entry for the whole TTL.
    return;
  }

  languageCache.set(buildCacheKey(key, locale, tenantId, db), {
    expiresAt: Date.now() + LANGUAGE_CACHE_TTL_MS,
    value,
  });
}

/**
 * Drop cached entries that match the given (key, locale).
 *
 * - When `tenantId` is provided, only that tenant's entries for this DB are dropped.
 * - When `tenantId` is null/undefined, every (key, locale, *) entry across tenants
 *   is dropped — used for app-level writes that affect all tenants.
 */
export function invalidateLanguageCache(
  key: string,
  locale: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
): void {
  const dbNamespace = getDbNamespace(db);
  const normalizedLocale = normalizeLocale(locale);
  bumpGeneration(key, normalizedLocale, db);

  if (tenantId !== null && tenantId !== undefined) {
    languageCache.delete(buildCacheKey(key, normalizedLocale, tenantId, db));
    return;
  }

  const keyPrefix = `${dbNamespace}::${key}::${normalizedLocale}::`;
  for (const cacheKey of languageCache.keys()) {
    if (cacheKey.startsWith(keyPrefix)) {
      languageCache.delete(cacheKey);
    }
  }
}

export function clearLanguageCache(): void {
  languageCache.clear();
  // Generations deliberately survive: resetting them to zero would let a
  // resolution that started before the clear write its stale value back.
  for (const generationKey of cacheGenerations.keys()) {
    cacheGenerations.set(
      generationKey,
      (cacheGenerations.get(generationKey) ?? 0) + 1,
    );
  }
}
