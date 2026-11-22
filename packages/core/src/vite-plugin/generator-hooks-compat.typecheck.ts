/**
 * Type-only fixture, compiled by `pnpm --filter @happyvertical/smrt-core
 * typecheck` and never imported: an external wrapper of the exported
 * `generateSvelteKitRoutes` that invokes its `beforeCleanup` hook with no
 * arguments, as the published signature allows. Managed generations track
 * output changes internally (#5462); the public callback must stay
 * zero-argument, so making it require a parameter fails this file.
 */

import type { generateSvelteKitRoutes } from './index.js';

type PublicGenerationHooks = NonNullable<
  Parameters<typeof generateSvelteKitRoutes>[6]
>;

export async function runPublicBeforeCleanup(
  hooks: PublicGenerationHooks,
): Promise<void> {
  await hooks.beforeCleanup?.();
}
