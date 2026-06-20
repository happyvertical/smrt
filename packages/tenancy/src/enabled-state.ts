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
