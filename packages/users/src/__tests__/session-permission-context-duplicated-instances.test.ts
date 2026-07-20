/**
 * Regression tests for session permission context across duplicated module
 * instances.
 *
 * Vite/vitest/SvelteKit server pipelines can evaluate
 * `SessionPermissionContext.ts` more than once even when a single copy exists
 * on disk. Each evaluation used to create its own module-local
 * AsyncLocalStorage, so a context entered through one instance's `.run()` path
 * was invisible to `getCurrentSessionPermissionContext()` readers in another
 * (the `globalThis.__smrtGetRequestPermissionContext` getter only let readers
 * reach the FIRST instance's storage — a second instance's writers were still
 * stranded). The storage is now a Symbol.for-keyed singleton on globalThis.
 *
 * Counterpart to the tenancy suite in
 * `packages/tenancy/src/__tests__/context-duplicated-instances.test.ts`.
 *
 * @see https://github.com/happyvertical/smrt/issues/2077
 */

import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SessionPermissionContextModule =
  typeof import('../services/SessionPermissionContext.js');

/**
 * Load two genuinely separate evaluations of SessionPermissionContext.ts.
 * vi.resetModules() clears the module registry between the dynamic imports,
 * forcing the second import to re-run the module's top-level code.
 */
async function importIsolatedCopies(): Promise<
  [SessionPermissionContextModule, SessionPermissionContextModule]
> {
  vi.resetModules();
  const first: SessionPermissionContextModule = await import(
    '../services/SessionPermissionContext.js'
  );
  vi.resetModules();
  const second: SessionPermissionContextModule = await import(
    '../services/SessionPermissionContext.js'
  );
  return [first, second];
}

describe('session permission context across duplicated module instances', () => {
  let dbPath: string;

  beforeEach(() => {
    dbPath = join(
      tmpdir(),
      `smrt-session-ctx-dup-${Date.now()}-${Math.random()}.db`,
    );
  });

  afterEach(() => {
    if (existsSync(dbPath)) {
      try {
        rmSync(dbPath, { force: true });
      } catch {
        // best-effort cleanup
      }
    }
  });

  it('produces two distinct module instances (test-harness sanity check)', async () => {
    const [first, second] = await importIsolatedCopies();
    // If these were the same instance the remaining tests would pass
    // vacuously even with a module-local storage.
    expect(second.withPrincipalPermissionContext).not.toBe(
      first.withPrincipalPermissionContext,
    );
    expect(second.getCurrentSessionPermissionContext).not.toBe(
      first.getCurrentSessionPermissionContext,
    );
  });

  it('context entered via one instance is visible to the other', async () => {
    const [first, second] = await importIsolatedCopies();

    // Explicit `permissions` skips live resolution, so no seed data is needed;
    // this still funnels through runWithinPermissionRuntime's `.run()` — the
    // same path used by withSessionPermissionContext.
    await first.withPrincipalPermissionContext(
      {
        db: { type: 'sqlite', url: dbPath },
        userId: 'user-dup-a',
        tenantId: 'tenant-dup-a',
        permissions: ['documents:read'],
      },
      async (context) => {
        const observed = second.getCurrentSessionPermissionContext();
        // Same store, same object — not a copy.
        expect(observed).toBe(context);
        expect(observed?.userId).toBe('user-dup-a');
        expect(observed?.tenantId).toBe('tenant-dup-a');
        expect(observed?.permissions).toEqual(['documents:read']);
        expect(observed?.permissionSet.has('documents:read')).toBe(true);
        expect(second.getRequestScopedDatabase()).toBe(context.database);
      },
    );

    expect(second.getCurrentSessionPermissionContext()).toBeUndefined();
    expect(second.getRequestScopedDatabase()).toBeUndefined();
  });
});
