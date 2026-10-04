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
    collection: 'runtime_tenant_records',
    filePath: '/fixtures/runtime-tenant-record.ts',
    packageName: '@fixture/override',
    extends: 'SmrtObject',
    fields: { tenantId: { type: 'text' } },
    methods: {},
    decoratorConfig: { tenantScoped: { mode: 'optional' } },
  } satisfies SmartObjectDefinition);
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
  it('requires context for descendants inheriting an overridden optional selector', async () => {
    register();
    const childKey = '@fixture/override:InheritedRuntimeTenantRecord';
    ObjectRegistry.registerFromManifest(childKey, {
      name: 'inheritedruntimetenantrecord',
      className: 'InheritedRuntimeTenantRecord',
      collection: 'inherited_runtime_tenant_records',
      filePath: '/fixtures/inherited-runtime-tenant-record.ts',
      packageName: '@fixture/override',
      extends: key,
      fields: {},
      methods: {},
      decoratorConfig: {},
    } satisfies SmartObjectDefinition);
    expect(getTenantScopedConfig(childKey)?.mode).toBe('required');
    const interceptor = createTenantInterceptor();
    const childContext = (operation: InterceptorContext['operation']) => ({
      ...context(operation),
      className: 'InheritedRuntimeTenantRecord',
      qualifiedClassName: childKey,
    });
    expect(() =>
      interceptor.beforeList?.(
        'InheritedRuntimeTenantRecord',
        {},
        childContext('list'),
      ),
    ).toThrow();
    expect(() =>
      interceptor.beforeSave?.(
        { tenantId: 'tenant-a' } as never,
        childContext('save'),
      ),
    ).toThrow();
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      expect(
        interceptor.beforeList?.(
          'InheritedRuntimeTenantRecord',
          {},
          childContext('list'),
        ),
      ).toEqual({ where: { tenantId: 'tenant-a' } });
      expect(() =>
        interceptor.beforeSave?.(
          { tenantId: 'tenant-a' } as never,
          childContext('save'),
        ),
      ).not.toThrow();
      expect(() =>
        interceptor.beforeSave?.(
          { tenantId: 'tenant-b' } as never,
          childContext('save'),
        ),
      ).toThrow();
    });
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
