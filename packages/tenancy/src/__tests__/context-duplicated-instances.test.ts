/**
 * Regression tests for tenant context across duplicated module instances.
 *
 * Vite/vitest/SvelteKit server pipelines can evaluate `context.ts` more than
 * once even when a single copy exists on disk. Each evaluation used to create
 * its own module-local AsyncLocalStorage, so `withSystemContext()` run through
 * one instance was invisible to `isSystemContext()` guards in another (e.g.
 * smrt-profiles' `getOrCreateGlobalBySlug` rejecting an app's system context).
 * The storage is now a Symbol.for-keyed singleton on globalThis.
 *
 * @see https://github.com/happyvertical/smrt/issues/2077
 */

import { describe, expect, it, vi } from 'vitest';

type ContextModule = typeof import('../context');

/**
 * Load two genuinely separate evaluations of context.ts. vi.resetModules()
 * clears the module registry between the dynamic imports, forcing the second
 * import to re-run the module's top-level code.
 */
async function importIsolatedCopies(): Promise<[ContextModule, ContextModule]> {
  vi.resetModules();
  const first: ContextModule = await import('../context');
  vi.resetModules();
  const second: ContextModule = await import('../context');
  return [first, second];
}

describe('tenant context across duplicated module instances', () => {
  it('produces two distinct module instances (test-harness sanity check)', async () => {
    const [first, second] = await importIsolatedCopies();
    // If these were the same instance the remaining tests would pass
    // vacuously even with a module-local storage.
    expect(second.withTenant).not.toBe(first.withTenant);
    expect(second.isSystemContext).not.toBe(first.isSystemContext);
  });

  it('system context entered via one instance is visible to the other', async () => {
    const [first, second] = await importIsolatedCopies();
    await first.withSystemContext(async () => {
      expect(second.isSystemContext()).toBe(true);
      // System context is still "no tenant" for tenant-shaped reads.
      expect(second.hasTenantContext()).toBe(false);
      expect(second.getCurrentTenant()).toBeUndefined();
    });
    expect(second.isSystemContext()).toBe(false);
  });

  it('tenant context entered via one instance is visible to the other', async () => {
    const [first, second] = await importIsolatedCopies();
    await first.withTenant({ tenantId: 'tenant-dup-a' }, async () => {
      expect(second.hasTenantContext()).toBe(true);
      expect(second.getTenantId()).toBe('tenant-dup-a');
      expect(second.requireTenant().tenantId).toBe('tenant-dup-a');
    });
    expect(second.getTenantId()).toBeUndefined();
  });

  it('nested scopes interleave correctly across instances', async () => {
    const [first, second] = await importIsolatedCopies();
    await first.withTenant({ tenantId: 'outer' }, async () => {
      await second.withSystemContext(async () => {
        expect(first.isSystemContext()).toBe(true);
        expect(first.getTenantId()).toBeUndefined();
      });
      expect(first.getTenantId()).toBe('outer');
      expect(second.getTenantId()).toBe('outer');
    });
  });
});
