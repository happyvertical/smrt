import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrapCommerceTenant } from '../template/src/lib/server/commerce.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = {} as DatabaseInterface;

/**
 * The optional commerce bootstrap (#4009). `ensureCommerceTenant` itself, the
 * clean-tenant v2 default and the cookbook mapping are proven in
 * `@happyvertical/smrt-commerce` (`tenant-money-default*.test.ts`); here we
 * prove the template calls it only when commerce is installed.
 */
describe('optional commerce tenant bootstrap', () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true });
  });

  it('does nothing when the app has not installed commerce', async () => {
    const root = mkdtempSync(join(tmpdir(), 'template-commerce-'));
    roots.push(root);
    const loadCookbook = vi.fn();
    await expect(
      bootstrapCommerceTenant(db, 'tenant-1', { root, loadCookbook }),
    ).resolves.toBeNull();
    expect(loadCookbook).not.toHaveBeenCalled();
  });

  it('passes the app cookbook to ensureCommerceTenant for the new tenant', async () => {
    const policies = [{ objectRef: 'x', fieldName: 'y' }];
    const ensureCommerceTenant = vi.fn(async (_db, tenantId: string) => ({
      tenantId,
    }));
    await expect(
      bootstrapCommerceTenant(db, 'tenant-1', {
        root: '/app',
        loadCommerce: async () => ({ ensureCommerceTenant }),
        loadCookbook: async () => ({ policies }),
      }),
    ).resolves.toEqual({ tenantId: 'tenant-1' });
    expect(ensureCommerceTenant).toHaveBeenCalledWith(db, 'tenant-1', {
      cookbook: { policies },
    });
  });

  it('bootstraps without a cookbook when the app has none', async () => {
    const ensureCommerceTenant = vi.fn(async (_db, tenantId: string) => ({
      tenantId,
    }));
    await bootstrapCommerceTenant(db, 'tenant-1', {
      root: '/app',
      loadCommerce: async () => ({ ensureCommerceTenant }),
      loadCookbook: async () => undefined,
    });
    expect(ensureCommerceTenant).toHaveBeenCalledWith(db, 'tenant-1', {});
  });

  it('propagates a bootstrap failure to the caller', async () => {
    await expect(
      bootstrapCommerceTenant(db, 'tenant-1', {
        root: '/app',
        loadCommerce: async () => ({
          ensureCommerceTenant: async () => {
            throw new Error('schema missing');
          },
        }),
        loadCookbook: async () => undefined,
      }),
    ).rejects.toThrow('schema missing');
  });

  it('runs from the owner setup claim, after the tenant exists', () => {
    const setup = readFileSync(
      join(__dirname, '..', 'template', 'src', 'routes', 'setup', '+page.server.ts'),
      'utf8',
    );
    expect(setup).toContain('onOwnerClaimed: async ({ tenantId })');
    expect(setup).toContain('bootstrapCommerceTenant(');
  });
});
