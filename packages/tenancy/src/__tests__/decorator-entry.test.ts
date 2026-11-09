import {
  createInterceptorContext,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { TenantScoped, tenantId } from '../decorators.js';
import {
  getTenantScopedConfig,
  tenantId as rootField,
  TenantScoped as rootScoped,
  TenantContextError,
  withTenant,
} from '../index.js';
import { createTenantInterceptor } from '../interceptor.js';

@rootScoped({ mode: 'required' })
@smrt()
class RootTenantMetadataFixture extends SmrtObject {
  @rootField() tenantId = '';
}
@TenantScoped({ mode: 'required' })
@smrt()
class PortableTenantMetadataFixture extends SmrtObject {
  @tenantId() tenantId = '';
}

describe('public portable tenancy annotations', () => {
  it('reexports the original functions and preserves field/schema metadata in the same registry', () => {
    expect(TenantScoped).toBe(rootScoped);
    expect(tenantId).toBe(rootField);
    expect(
      ObjectRegistry.getFieldDecorator(
        'PortableTenantMetadataFixture',
        'tenantId',
      ),
    ).toEqual(
      ObjectRegistry.getFieldDecorator('RootTenantMetadataFixture', 'tenantId'),
    );
    expect(getTenantScopedConfig('PortableTenantMetadataFixture')).toEqual(
      getTenantScopedConfig('RootTenantMetadataFixture'),
    );
    expect(
      ObjectRegistry.getTenantScopedConfig('PortableTenantMetadataFixture'),
    ).toMatchObject({
      mode: 'required',
      field: 'tenantId',
      autoFilter: true,
      autoPopulate: true,
      allowSuperAdminBypass: false,
    });
  });
  it('does not replace current Node tenant enforcement with metadata registration', async () => {
    const interceptor = createTenantInterceptor();
    const name = 'PortableTenantMetadataFixture';
    const context = createInterceptorContext(name, 'list');
    expect(() => interceptor.beforeList?.(name, {}, context)).toThrow(
      TenantContextError,
    );
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      expect(await interceptor.beforeList?.(name, {}, context)).toMatchObject({
        where: { tenantId: 'tenant-a' },
      });
      expect(() =>
        interceptor.beforeList?.(
          name,
          { where: { tenantId: 'tenant-b' } },
          context,
        ),
      ).toThrow();
    });
  });
});
