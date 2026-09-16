/**
 * Stable cache identity for the collection cache's `db` option (#2306).
 *
 * `ObjectRegistry.getCollection()` derives its cache key partly from
 * `options.db`, which accepts all three `DatabaseConfig` shapes. Real
 * `DatabaseInterface` instances are keyed by object identity (issue #384),
 * string URLs by value, but plain config objects used to fall into the
 * identity path too — so semantically equivalent fresh `{ type, url }`
 * objects missed the cache entirely and churned the LRU with duplicate
 * initialization work.
 *
 * This module derives a stable, value-based key for config objects:
 *
 * - Real instances (anything with a callable `query()`) keep identity keys.
 * - `:memory:` databases stay per-instance isolated — two in-memory
 *   databases that share the URL string are different databases, so sharing
 *   a cached collection between them would be a correctness bug.
 * - The key derives from the *bounded* PostgreSQL URL
 *   (`applyPostgresRuntimeTimeouts`, #2377) so two configs that differ only
 *   in runtime timeouts — and therefore in the pool `resolveDatabase()`
 *   would hand the collection — cannot collide in the cache.
 * - `authToken` participates through a SHA-256 digest, never as cleartext:
 *   cache keys are not credentials storage, and a leaked log line must not
 *   carry a bearer token.
 * - Remaining properties are canonicalized deterministically: sorted keys,
 *   nested containers recursed, and opaque values (functions, symbols,
 *   bigints) reduced to a digest so property order and identity noise
 *   cannot split equivalent configs.
 *
 * @see https://github.com/happyvertical/smrt/issues/2306
 * @packageDocumentation
 */

import { createHash } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { isDatabaseInterface } from '../database.js';
import { applyPostgresRuntimeTimeouts } from '../postgres-timeouts.js';
import { getDbInstanceIds, getNextDbId, setNextDbId } from './shared-state.js';

/** Secret-ish values hashed into the key instead of embedded in it. */
const HASHED_DB_KEYS = new Set(['authToken']);

/**
 * Reference-identity registry for opaque callable options. Two calls passing
 * the SAME function share one cache scope; two distinct functions — even
 * with identical source text, since `String(fn)` cannot tell them apart —
 * stay separate. The conservative direction: an adapter-specific callback
 * may close over state the collection initialization observes, so a value
 * key that merged distinct functions would be a correctness risk, while
 * splitting them only costs a cache entry.
 */
const opaqueFunctionIds = new WeakMap<object, number>();
let nextOpaqueFunctionId = 1;

/**
 * Render an opaque value (symbol, bigint, over-deep object) as a stable
 * textual digest. Distinct-but-textually-identical symbols remain possible
 * here; symbols as database options are vanishingly rare and the collision
 * only merges two configs that agree on every other property.
 */
function digest(value: unknown): string {
  const source =
    typeof value === 'symbol'
      ? value.toString()
      : typeof value === 'bigint'
        ? `${value}n`
        : String(value);
  return `opaque:${createHash('sha256').update(source).digest('hex')}`;
}

/**
 * Reference-identity key fragment for callable options (see
 * {@link opaqueFunctionIds}).
 */
function functionDigest(value: (...args: unknown[]) => unknown): string {
  let id = opaqueFunctionIds.get(value);
  if (id === undefined) {
    id = nextOpaqueFunctionId++;
    opaqueFunctionIds.set(value, id);
  }
  return `fnref:${id}`;
}

/**
 * Canonicalize a config-object value into a JSON-safe representation with
 * deterministic key order and hashed secrets.
 */
function canonicalizeValue(
  key: string,
  value: unknown,
  depth: number,
): unknown {
  if (value === null || value === undefined) return null;

  if (HASHED_DB_KEYS.has(key) && typeof value === 'string' && value !== '') {
    return `sha256:${createHash('sha256').update(value).digest('hex')}`;
  }

  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'function') {
    return functionDigest(value as (...args: unknown[]) => unknown);
  }
  if (t === 'bigint' || t === 'symbol') return digest(value);

  if (Array.isArray(value)) {
    return value.map((item) => canonicalizeValue(key, item, depth + 1));
  }

  if (t === 'object') {
    // A nested DatabaseInterface (or any live adapter instance smuggled
    // into options) re-enters the identity regime — an exact-reference key,
    // since two distinct instances are never value-equal.
    if (isDatabaseInterface(value)) {
      return instanceKey(value);
    }
    if (depth >= 8) {
      return digest(value);
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value).sort()) {
      out[k] = canonicalizeValue(
        k,
        (value as Record<string, unknown>)[k],
        depth + 1,
      );
    }
    return out;
  }

  return digest(value);
}

/**
 * Identity key for a live `DatabaseInterface` instance (issue #384): the
 * registry's `dbInstanceIds` WeakMap assigns each instance a stable
 * per-process ID. Also used for `:memory:` config objects, which must stay
 * per-call-site isolated.
 */
function instanceKey(db: object): string {
  const ids = getDbInstanceIds();
  if (!ids.has(db)) {
    ids.set(db, getNextDbId());
    setNextDbId(getNextDbId() + 1);
  }
  const id = ids.get(db);
  return `instance:${id}`;
}

/**
 * Resolve the collection-cache key fragment for a `db` option value.
 *
 * Returns `undefined` for a missing db, matching the historical shape of the
 * cache key (absent db serializes as `null` in the JSON part of the key).
 */
export function resolveCollectionDbCacheKey(db: unknown): string | undefined {
  if (db === undefined || db === null) return undefined;

  if (typeof db === 'string') {
    // String URLs are value-keyed. `:memory:` is deliberately NOT special-
    // cased here: the string path of getCollection has always shared the
    // cache entry for repeated identical strings, and the collection it
    // resolves to binds to one pooled database (resolveDatabase() omits the
    // pool dbid for `:memory:`, but the cached collection holds the first
    // resolution's database), so every caller of that string hits the same
    // underlying database — sharing the cached collection preserves the
    // existing behavior issue #117's string-isolation test pins (distinct
    // strings stay distinct; identical strings already shared).
    return `string:${db}`;
  }

  if (typeof db !== 'object') return undefined;

  // Real initialized adapters keep per-instance isolation (#384).
  if (isDatabaseInterface(db)) {
    return instanceKey(db);
  }

  // Plain config object: stable value key (#2306).
  const config = db as {
    url?: unknown;
    type?: unknown;
    [key: string]: unknown;
  };

  // `:memory:` configs must stay isolated per call site: two equivalent
  // config objects each resolving to their own in-memory database would
  // share a cached collection otherwise. resolveDatabase() defaults a
  // missing url to `:memory:` only for sqlite/json (or unspecified type);
  // other adapters require an explicit url, so only those types can reach
  // the memory path here.
  const rawUrl = typeof config.url === 'string' ? config.url : '';
  const canUseMemory =
    !config.type || config.type === 'sqlite' || config.type === 'json';
  if (rawUrl === ':memory:' || (!rawUrl && canUseMemory)) {
    return instanceKey(db);
  }

  // Derive the key from the *bounded* config so timeout-differing configs
  // cannot collide (#2377): resolveDatabase() bounds the config before
  // computing its pool dbid from the bounded URL, and the collection cache
  // must agree with that pool identity.
  const bounded = applyPostgresRuntimeTimeouts({
    ...(config as Record<string, unknown>),
    ...(rawUrl ? { url: rawUrl } : {}),
  }) as Record<string, unknown>;

  const canonical: Record<string, unknown> = {};
  for (const k of Object.keys(bounded).sort()) {
    canonical[k] = canonicalizeValue(k, bounded[k], 0);
  }
  return `config:${JSON.stringify(canonical)}`;
}
