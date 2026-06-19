/**
 * Collection read-cache configuration resolution for the SMRT ObjectRegistry.
 *
 * Resolves the effective `@smrt({ cache })` config for a class, walking the
 * inheritance chain so an STI base class opt-in covers its children while a
 * child can still opt out with `cache: false`.
 *
 * @see https://github.com/happyvertical/smrt/issues/1498
 */

import type { CollectionCacheConfig } from '../collection-cache';
import { getInheritanceChain } from './inheritance-resolver';
import { findClass } from './name-resolver';

/**
 * Resolve the effective collection cache config for a class.
 *
 * The nearest definition in the inheritance chain wins (self first, then
 * ancestors). `cache: false` at any level explicitly disables caching for
 * that class and stops the walk.
 *
 * @param className - Simple or qualified class name
 * @returns The effective config, or undefined when caching is not opted in
 */
export function resolveCollectionCacheConfig(
  className: string,
): CollectionCacheConfig | undefined {
  // Chain is ordered [ancestor, ..., self]; walk nearest-first. Falls back
  // to a direct lookup for classes without a computable chain (e.g. inline
  // test classes registered without manifest metadata).
  const chain = getInheritanceChain(className);
  const candidates = chain.length > 0 ? [...chain].reverse() : [className];

  for (const name of candidates) {
    const cache = findClass(name)?.config?.cache;
    if (cache === undefined) continue;
    if (cache === false || !(cache.ttl > 0)) return undefined;
    return cache;
  }

  return undefined;
}
