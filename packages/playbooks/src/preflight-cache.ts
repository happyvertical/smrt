/**
 * Preflight result cache (issue #2590).
 *
 * Preflight predicts; it never grants. Every step re-enforces at execution, and
 * that constraint is exactly what makes this cache free:
 *
 * - a stale `allow` costs a correctly-denied step at execution;
 * - a stale `deny` costs a briefly hidden capability that expires on the TTL.
 *
 * Neither is a security event, so results are cached per
 * `(principal, key, plane, tenant)` with a short TTL and **no invalidation
 * ceremony** beyond the playbook cache's own per-`(db, key)` generation counter:
 * a result captured under generation N is dropped once an override write has
 * bumped the counter past N. There is deliberately no per-principal invalidation
 * on a permission change — the TTL is the whole contract, because execution
 * re-enforces regardless.
 */

import { getPlaybookCacheGeneration, playbookCacheNamespace } from './cache.js';
import type { PlaybookPreflightReport } from './preflight-types.js';
import type { PlaybookPlane } from './types.js';

const PREFLIGHT_CACHE_TTL_MS = 15_000;

/**
 * Hard ceiling on retained entries. The browser route is reachable without app
 * auth by design (it never invokes `authMiddleware`), so the cache must not be
 * a memory sink an anonymous caller can grow. Unknown keys are not cached at
 * all; this bounds everything else.
 */
const PREFLIGHT_CACHE_MAX_ENTRIES = 1_000;

/** Identity a cached preflight result is stored under. */
export interface PreflightCacheScope {
  /** Opaque, caller-scoped principal partition. Never consulted for authority. */
  principal: string;
  key: string;
  plane: PlaybookPlane;
  /**
   * Tenant the result was resolved for. Part of the key because a tenant
   * override can disable a playbook or narrow its planes — the base playbook
   * cache scopes by tenant for the same reason.
   */
  tenantId: string | null;
  db: unknown;
}

interface PreflightCacheEntry {
  expiresAt: number;
  generation: number;
  report: PlaybookPreflightReport;
}

const preflightCache = new Map<string, PreflightCacheEntry>();

function buildKey(scope: PreflightCacheScope): string {
  return `${playbookCacheNamespace(scope.db)}::${scope.principal}::${scope.key}::${scope.plane}::${scope.tenantId ?? 'app'}`;
}

/** Drops expired entries, then the oldest insertions if still over the cap. */
function evict(): void {
  const now = Date.now();
  for (const [cacheKey, entry] of preflightCache) {
    if (entry.expiresAt <= now) {
      preflightCache.delete(cacheKey);
    }
  }

  // Map iteration is insertion-ordered, so this drops the oldest first.
  for (const cacheKey of preflightCache.keys()) {
    if (preflightCache.size <= PREFLIGHT_CACHE_MAX_ENTRIES) {
      break;
    }
    preflightCache.delete(cacheKey);
  }
}

/** TTL applied to every cached preflight result. */
export function getPlaybookPreflightCacheTtlMs(): number {
  return PREFLIGHT_CACHE_TTL_MS;
}

/**
 * Reads a cached preflight result.
 *
 * A result captured before an override write (a lower generation) is dropped
 * rather than served, so an override change is reflected without waiting out
 * the TTL.
 */
export function getCachedPlaybookPreflight(
  scope: PreflightCacheScope,
): PlaybookPreflightReport | null {
  const cacheKey = buildKey(scope);
  const entry = preflightCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (
    entry.expiresAt <= Date.now() ||
    entry.generation !== getPlaybookCacheGeneration(scope.key, scope.db)
  ) {
    preflightCache.delete(cacheKey);
    return null;
  }

  return entry.report;
}

/**
 * Stores a preflight result. `loadedAtGeneration` is the generation captured
 * *before* resolution started: a write that landed while it was in flight makes
 * the result stale on arrival, and it is dropped rather than cached.
 */
export function setCachedPlaybookPreflight(
  scope: PreflightCacheScope,
  report: PlaybookPreflightReport,
  loadedAtGeneration: number,
): void {
  if (getPlaybookCacheGeneration(scope.key, scope.db) !== loadedAtGeneration) {
    return;
  }

  preflightCache.set(buildKey(scope), {
    expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS,
    generation: loadedAtGeneration,
    report,
  });

  if (preflightCache.size > PREFLIGHT_CACHE_MAX_ENTRIES) {
    evict();
  }
}

/** Drops every cached preflight result. Use in tests. */
export function clearPlaybookPreflightCache(): void {
  preflightCache.clear();
}
