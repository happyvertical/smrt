/**
 * Tests for the fail-closed entry-point gate used by generated CLI/MCP surfaces.
 *
 * @see https://github.com/happyvertical/smrt/issues/1554
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  getTenantId,
  isSuperAdminBypass,
  isSystemContext,
  TenantContextError,
  withTenant,
} from '../context';
import { runTenantScopedEntryPoint } from '../entry-point';
import { disableTenancy, enableTenancy } from '../interceptor';
import {
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry';

describe('runTenantScopedEntryPoint (#1554)', () => {
  afterEach(() => {
    disableTenancy();
  });

  describe('non-tenant-scoped models', () => {
    it('passes through unchanged, never establishing context', async () => {
      enableTenancy();
      let observed: string | undefined = 'unset';
      const result = await runTenantScopedEntryPoint(
        { tenantScoped: false, surface: 'CLI' },
        async () => {
          observed = getTenantId();
          return 'ok';
        },
      );
      expect(result).toBe('ok');
      expect(observed).toBeUndefined();
    });
  });

  describe('tenancy enabled', () => {
    beforeEach(() => {
      enableTenancy();
    });

    it('fails closed when a tenant-scoped model has no selector and no context', async () => {
      await expect(
        runTenantScopedEntryPoint({ tenantScoped: true, surface: 'CLI' }, () =>
          Promise.resolve('leaked'),
        ),
      ).rejects.toBeInstanceOf(TenantContextError);
    });

    it('runs inside the explicit tenant when tenantId is provided', async () => {
      let observed: string | undefined;
      await runTenantScopedEntryPoint(
        { tenantScoped: true, tenantId: 'tenant-a', surface: 'MCP' },
        async () => {
          observed = getTenantId();
        },
      );
      expect(observed).toBe('tenant-a');
    });

    it('runs in system context when allowCrossTenant is set', async () => {
      let system = false;
      let bypass = false;
      await runTenantScopedEntryPoint(
        { tenantScoped: true, allowCrossTenant: true, surface: 'CLI' },
        async () => {
          system = isSystemContext();
          bypass = isSuperAdminBypass();
        },
      );
      expect(system).toBe(true);
      // system context removes tenant context entirely (not a super-admin bypass)
      expect(bypass).toBe(false);
    });

    it('reuses an already-active context instead of failing', async () => {
      let observed: string | undefined;
      await withTenant({ tenantId: 'outer' }, async () => {
        await runTenantScopedEntryPoint(
          { tenantScoped: true, surface: 'CLI' },
          async () => {
            observed = getTenantId();
          },
        );
      });
      expect(observed).toBe('outer');
    });

    it('prefers an active context over an explicit tenantId selector', async () => {
      let observed: string | undefined;
      await withTenant({ tenantId: 'outer' }, async () => {
        await runTenantScopedEntryPoint(
          { tenantScoped: true, tenantId: 'ignored', surface: 'CLI' },
          async () => {
            observed = getTenantId();
          },
        );
      });
      expect(observed).toBe('outer');
    });
  });

  describe('className-based scoping resolution', () => {
    afterEach(() => {
      unregisterTenantScopedClass('EntryPointScopedDoc');
    });

    it('fails closed for a class registered as tenant-scoped (no boolean given)', async () => {
      enableTenancy();
      registerTenantScopedClass('EntryPointScopedDoc', { mode: 'optional' });
      await expect(
        runTenantScopedEntryPoint(
          { className: 'EntryPointScopedDoc', surface: 'CLI' },
          () => Promise.resolve('leaked'),
        ),
      ).rejects.toBeInstanceOf(TenantContextError);
    });

    it('passes through a class that is not tenant-scoped', async () => {
      enableTenancy();
      const result = await runTenantScopedEntryPoint(
        { className: 'EntryPointUnscopedDoc', surface: 'CLI' },
        () => Promise.resolve('ok'),
      );
      expect(result).toBe('ok');
    });

    it('explicit tenantScoped boolean overrides className resolution', async () => {
      enableTenancy();
      registerTenantScopedClass('EntryPointScopedDoc', { mode: 'optional' });
      // className resolves scoped, but the explicit false wins → pass through.
      const result = await runTenantScopedEntryPoint(
        {
          className: 'EntryPointScopedDoc',
          tenantScoped: false,
          surface: 'CLI',
        },
        () => Promise.resolve('ok'),
      );
      expect(result).toBe('ok');
    });
  });

  describe('tenancy disabled (single-tenant deployment)', () => {
    it('passes a tenant-scoped model through without throwing', async () => {
      disableTenancy();
      let observed: string | undefined = 'unset';
      const result = await runTenantScopedEntryPoint(
        { tenantScoped: true, surface: 'CLI' },
        async () => {
          observed = getTenantId();
          return 'single-tenant-ok';
        },
      );
      expect(result).toBe('single-tenant-ok');
      expect(observed).toBeUndefined();
    });
  });
});
