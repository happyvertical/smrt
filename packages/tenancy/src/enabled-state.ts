/**
 * Shared tenancy-enabled flag.
 *
 * Holds the single boolean toggled by `enableTenancy()` / `disableTenancy()`.
 * It lives in its own leaf module (importing nothing from the package) so that
 * both `interceptor.ts` and `entry-point.ts` can read it without forming a
 * circular import: `interceptor.ts` imports `runTenantScopedEntryPoint` from
 * `entry-point.ts`, and `entry-point.ts` needs the enabled flag — routing the
 * flag through here keeps that dependency one-directional.
 */

let enabled = false;

/**
 * Set the global tenancy-enabled flag. Internal — called by `enableTenancy()` /
 * `disableTenancy()` in `interceptor.ts`.
 *
 * @param value - `true` to mark tenancy enabled, `false` to clear it.
 */
export function setTenancyEnabled(value: boolean): void {
  enabled = value;
  bumpTenantPolicyGeneration();
}

/**
 * Return `true` if tenant enforcement is currently active.
 *
 * @returns Whether `enableTenancy()` has been called without a later
 *   `disableTenancy()`.
 */
export function isTenancyEnabled(): boolean {
  return enabled;
}

// The policy generation (#5195): a counter core reads through the policy
// source's `generation()` to know that the policies it resolved may be
// stale. Shared by every copy of this package in the process, like the
// context storage, through a registered symbol.
const GENERATION_KEY = Symbol.for('smrt:tenant-policy-generation');

type GenerationRoot = typeof globalThis & { [GENERATION_KEY]?: number };

/**
 * Advance the policy generation. Internal: called on every registration or
 * removal of a tenancy policy and on enable and disable.
 */
export function bumpTenantPolicyGeneration(): void {
  const root = globalThis as GenerationRoot;
  root[GENERATION_KEY] = (root[GENERATION_KEY] ?? 0) + 1;
}

/** The current policy generation. Never throws. */
export function tenantPolicyGeneration(): number {
  return (globalThis as GenerationRoot)[GENERATION_KEY] ?? 0;
}
