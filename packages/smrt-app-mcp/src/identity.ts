import type { McpPrincipalIdentity } from './server.js';

/**
 * Attach the adapter-verified credential identity to a principal as a
 * non-enumerable property: it never changes the principal's enumerable
 * (deep-equal, serialized) shape, and an object spread drops it, so any
 * code that rebuilds a principal must re-stamp it from the authenticated one.
 *
 * @internal
 */
export function stampVerifiedIdentity<T extends object>(
  principal: T,
  identity: McpPrincipalIdentity | undefined,
): T {
  if (identity) {
    Object.defineProperty(principal, 'identity', {
      value: Object.freeze({ ...identity }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  return principal;
}
