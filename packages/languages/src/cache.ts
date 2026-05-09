import type { DatabaseInterface } from '@happyvertical/sql';
import type { LanguageCacheValue } from './types.js';
import { normalizeLocale } from './utils.js';

const LANGUAGE_CACHE_TTL_MS = 30_000;

type CacheEntry = {
  expiresAt: number;
  value: LanguageCacheValue;
};

const languageCache = new Map<string, CacheEntry>();
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

export function setCachedLanguage(
  key: string,
  locale: string,
  tenantId: string | null | undefined,
  db: DatabaseInterface | unknown,
  value: LanguageCacheValue,
): void {
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
}
