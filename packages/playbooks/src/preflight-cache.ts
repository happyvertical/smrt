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
 * `(principal, key, plane)` with a short TTL and **no invalidation ceremony**
 * beyond the playbook cache's own per-`(db, key)` generation counter: a result
 * captured under generation N is dropped once an override write has bumped the
 * counter past N. There is deliberately no per-principal invalidation on a
 * permission change — the TTL is the whole contract, because execution
 * re-enforces regardless.
 */

import { getPlaybookCacheGeneration, playbookCacheNamespace } from './cache.js';
import type { PlaybookPreflightReport } from './preflight-types.js';
import type { PlaybookPlane } from './types.js';

const PREFLIGHT_CACHE_TTL_MS = 15_000;

interface PreflightCacheEntry {
  expiresAt: number;
  generation: number;
  report: PlaybookPreflightReport;
}

const preflightCache = new Map<string, PreflightCacheEntry>();

function buildKey(
  principal: string,
  key: string,
  plane: PlaybookPlane,
  db: unknown,
): string {
  return `${playbookCacheNamespace(db)}::${principal}::${key}::${plane}`;
}

/** TTL applied to every cached preflight result. */
export function getPlaybookPreflightCacheTtlMs(): number {
  return PREFLIGHT_CACHE_TTL_MS;
}

/**
 * Reads a cached preflight result for `(principal, key, plane)`.
 *
 * A result captured before an override write (a lower generation) is dropped
 * rather than served, so an override change is reflected without waiting out
 * the TTL.
 */
export function getCachedPlaybookPreflight(
  principal: string,
  key: string,
  plane: PlaybookPlane,
  db: unknown,
): PlaybookPreflightReport | null {
  const cacheKey = buildKey(principal, key, plane, db);
  const entry = preflightCache.get(cacheKey);
  if (!entry) {
    return null;
  }

  if (
    entry.expiresAt <= Date.now() ||
    entry.generation !== getPlaybookCacheGeneration(key, db)
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
  principal: string,
  key: string,
  plane: PlaybookPlane,
  db: unknown,
  report: PlaybookPreflightReport,
  loadedAtGeneration: number,
): void {
  if (getPlaybookCacheGeneration(key, db) !== loadedAtGeneration) {
    return;
  }

  preflightCache.set(buildKey(principal, key, plane, db), {
    expiresAt: Date.now() + PREFLIGHT_CACHE_TTL_MS,
    generation: loadedAtGeneration,
    report,
  });
}

/** Drops every cached preflight result. Use in tests. */
export function clearPlaybookPreflightCache(): void {
  preflightCache.clear();
}
