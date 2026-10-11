/**
 * Issue #2973: `withSuperAdminBypass()` must skip tenant enforcement only for
 * classes that opt in with `allowSuperAdminBypass: true`. A class that leaves
 * the flag at its `false` default keeps its full tenant boundary under bypass.
 */
import type { InterceptorContext, ListOptions } from '@happyvertical/smrt-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  TenantIsolationError,
  withSuperAdminBypass,
  withTenant,
} from '../context';
import { createTenantInterceptor } from '../interceptor';
import {
  clearTenantScopedRegistry,
  registerTenantScopedClass,
} from '../registry';

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';

function ctx(
  className: string,
  operation: InterceptorContext['operation'],
): InterceptorContext {
  return { className, operation, timestamp: new Date() };
}

function asSuperAdmin<T>(fn: () => Promise<T>): Promise<T> {
  return withTenant({ tenantId: TENANT }, () => withSuperAdminBypass(fn));
}

describe('super-admin bypass honours per-class allowSuperAdminBypass (#2973)', () => {
  beforeEach(() => {
    clearTenantScopedRegistry();
    registerTenantScopedClass('Protected'); // default: allowSuperAdminBypass false
    registerTenantScopedClass('ExplicitlyProtected', {
      allowSuperAdminBypass: false,
    });
    registerTenantScopedClass('Bypassable', { allowSuperAdminBypass: true });
  });

  afterEach(() => {
    clearTenantScopedRegistry();
  });

  describe.each([
    'Protected',
    'ExplicitlyProtected',
  ])('%s (bypass not allowed) stays tenant-scoped under bypass', (className) => {
    it('beforeList injects the context tenant filter', async () => {
      const interceptor = createTenantInterceptor();
      await asSuperAdmin(async () => {
        const result = interceptor.beforeList?.(
          className,
          { where: { status: 'active' } },
          ctx(className, 'list'),
        );
        expect((result as ListOptions | undefined)?.where).toEqual({
          status: 'active',
          tenantId: TENANT,
        });
      });
    });

    it('beforeList rejects a cross-tenant filter', async () => {
      const interceptor = createTenantInterceptor();
      await asSuperAdmin(async () => {
        expect(() =>
          interceptor.beforeList?.(
            className,
            { where: { tenantId: OTHER } },
            ctx(className, 'list'),
          ),
        ).toThrow(TenantIsolationError);
      });
    });

    it('beforeGet injects the context tenant and rejects cross-tenant', async () => {
      const interceptor = createTenantInterceptor();
      await asSuperAdmin(async () => {
        expect(
          interceptor.beforeGet?.(
            className,
            { id: 'x' },
            ctx(className, 'get'),
          ),
        ).toEqual({ id: 'x', tenantId: TENANT });
        expect(() =>
          interceptor.beforeGet?.(
            className,
            { id: 'x', tenantId: OTHER },
            ctx(className, 'get'),
          ),
        ).toThrow(TenantIsolationError);
      });
    });

    it('beforeQuery applies the raw SQL policy', async () => {
      const interceptor = createTenantInterceptor({
        rawQueryPolicy: 'throw',
      });
      await asSuperAdmin(async () => {
        expect(() =>
          interceptor.beforeQuery?.(
            className,
            { sql: 'SELECT 1', params: [] },
            ctx(className, 'query'),
          ),
        ).toThrow(TenantIsolationError);
      });
    });

    it('beforeSave rejects a cross-tenant write', async () => {
      const interceptor = createTenantInterceptor();
      await asSuperAdmin(async () => {
        expect(() =>
          interceptor.beforeSave?.(
            { tenantId: OTHER } as never,
            ctx(className, 'save'),
          ),
        ).toThrow(TenantIsolationError);
      });
    });

    it('beforeDelete rejects a cross-tenant delete', async () => {
      const interceptor = createTenantInterceptor();
      await asSuperAdmin(async () => {
        expect(() =>
          interceptor.beforeDelete?.(
            { tenantId: OTHER } as never,
            ctx(className, 'delete'),
          ),
        ).toThrow(TenantIsolationError);
      });
    });
  });

  describe('Bypassable (allowSuperAdminBypass: true) skips enforcement under bypass', () => {
    it('passes every hook through', async () => {
      const interceptor = createTenantInterceptor({ rawQueryPolicy: 'throw' });
      const className = 'Bypassable';
      await asSuperAdmin(async () => {
        expect(
          interceptor.beforeList?.(
            className,
            { where: { tenantId: OTHER } },
            ctx(className, 'list'),
          ),
        ).toBeUndefined();
        expect(
          interceptor.beforeGet?.(
            className,
            { id: 'x', tenantId: OTHER },
            ctx(className, 'get'),
          ),
        ).toBeUndefined();
        expect(() =>
          interceptor.beforeQuery?.(
            className,
            { sql: 'SELECT 1', params: [] },
            ctx(className, 'query'),
          ),
        ).not.toThrow();
        expect(() =>
          interceptor.beforeSave?.(
            { tenantId: OTHER } as never,
            ctx(className, 'save'),
          ),
        ).not.toThrow();
        expect(() =>
          interceptor.beforeDelete?.(
            { tenantId: OTHER } as never,
            ctx(className, 'delete'),
          ),
        ).not.toThrow();
      });
    });

    it('is still tenant-filtered without an active bypass', async () => {
      const interceptor = createTenantInterceptor();
      await withTenant({ tenantId: TENANT }, async () => {
        const result = interceptor.beforeList?.(
          'Bypassable',
          {},
          ctx('Bypassable', 'list'),
        ) as ListOptions | undefined;
        expect(result?.where).toEqual({ tenantId: TENANT });
      });
    });
  });
});
