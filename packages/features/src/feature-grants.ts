/**
 * Plan grant source slot — dependency inversion between `smrt-features` and
 * `smrt-subscriptions` (#4761).
 *
 * Features must keep working without subscription tables (local installs), so
 * it never imports `smrt-subscriptions`. Instead a host (or
 * `registerSubscriptionFeatureSource()` in `smrt-subscriptions`) registers a
 * {@link FeatureGrantSource} here at setup, the same inversion core uses for
 * `setDispatchTenantResolver()`. With no source registered the resolver sees
 * no grants and behaves exactly as before.
 *
 * The slot lives on `globalThis` under a registered symbol so every module
 * instance of either package (the monorepo can load a package from several
 * paths) shares one source. The symbol key is a cross-package contract:
 * `smrt-subscriptions` writes the same `Symbol.for()` key without importing
 * this module. Do not rename it.
 */
import type { FeatureGrantSource } from './types.js';

/** `Symbol.for()` key of the global grant source slot. Do not rename. */
export const FEATURE_GRANT_SOURCE_SLOT_KEY =
  '@happyvertical/smrt-features:grant-source';

const SLOT = Symbol.for(FEATURE_GRANT_SOURCE_SLOT_KEY);

type GrantSlotHolder = Record<symbol, FeatureGrantSource | undefined>;

/**
 * Register the process-wide grant source, or clear it with `undefined`.
 *
 * Register a source whose lookups are safe to share across requests (one
 * app-lifetime `SubscriptionResolver`, no per-tenant memo). For per-request
 * memoization pass a request-scoped source as `context.grantSource` instead.
 */
export function setFeatureGrantSource(
  source: FeatureGrantSource | undefined,
): void {
  (globalThis as unknown as GrantSlotHolder)[SLOT] = source;
}

/** The registered process-wide grant source, if any. */
export function getFeatureGrantSource(): FeatureGrantSource | undefined {
  return (globalThis as unknown as GrantSlotHolder)[SLOT];
}
