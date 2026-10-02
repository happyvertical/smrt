import {
  type InterceptorContext,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type { SmartObjectDefinition } from '@happyvertical/smrt-core/scanner/types';
import { afterEach, describe, expect, it } from 'vitest';
import { withTenant } from '../context';
import { createTenantInterceptor } from '../interceptor';
import {
  getTenantScopedConfig,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
} from '../registry';

const key = '@fixture/override:RuntimeTenantRecord';
function register() {
  ObjectRegistry.registerFromManifest(key, {
    name: 'runtimetenantrecord',
    className: 'RuntimeTenantRecord',
    packageName: '@fixture/override',
    extends: 'SmrtObject',
    fields: { tenantId: { type: 'text' } },
    methods: {},
    decoratorConfig: { tenantScoped: { mode: 'optional' } },
  } as SmartObjectDefinition);
  registerTenantScopedClass(key, { mode: 'optional' });
  ObjectRegistry.registerOverride(key, { tenancy: { mode: 'required' } });
}
function context(
  operation: InterceptorContext['operation'],
): InterceptorContext {
  return {
    className: 'RuntimeTenantRecord',
    qualifiedClassName: key,
    operation,
    timestamp: new Date(),
  };
}
afterEach(() => {
  unregisterTenantScopedClass(key);
  ObjectRegistry.clear();
});
describe('required consumer tenancy overrides', () => {
  it('is a ceiling over optional direct registrations and denies missing read/write context', () => {
    register();
    registerTenantScopedClass(key, { mode: 'optional' });
    expect(getTenantScopedConfig(key)?.mode).toBe('required');
    const interceptor = createTenantInterceptor();
    expect(() =>
      interceptor.beforeList?.('RuntimeTenantRecord', {}, context('list')),
    ).toThrow();
    expect(() =>
      interceptor.beforeSave?.(
        { tenantId: 'tenant-a' } as never,
        context('save'),
      ),
    ).toThrow();
  });
  for (const tenantId of ['tenant-a', 'tenant-b']) {
    it(`allows own reads and denies foreign ownership with context ${tenantId}`, async () => {
      register();
      const interceptor = createTenantInterceptor();
      await withTenant({ tenantId }, async () => {
        expect(
          interceptor.beforeList?.('RuntimeTenantRecord', {}, context('list')),
        ).toEqual({ where: { tenantId } });
        expect(() =>
          interceptor.beforeList?.(
            'RuntimeTenantRecord',
            {
              where: {
                tenantId: tenantId === 'tenant-a' ? 'tenant-b' : 'tenant-a',
              },
            },
            context('list'),
          ),
        ).toThrow();
        expect(() =>
          interceptor.beforeSave?.({ tenantId } as never, context('save')),
        ).not.toThrow();
        expect(() =>
          interceptor.beforeSave?.(
            { tenantId: 'foreign' } as never,
            context('save'),
          ),
        ).toThrow();
      });
    });
  }
});
