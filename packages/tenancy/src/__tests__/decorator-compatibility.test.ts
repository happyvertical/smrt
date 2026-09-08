import {
  field,
  ObjectRegistry,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { TenantContextError } from '../context.js';
import { TenantScoped, tenantId } from '../decorators.js';
import { createTenantInterceptor } from '../interceptor.js';

function createFieldContext(
  name: string,
  metadata: Record<PropertyKey, unknown>,
): ClassFieldDecoratorContext<any, any> {
  return {
    kind: 'field',
    name,
    static: false,
    private: false,
    access: {
      has: () => true,
      get: () => undefined,
      set: () => {},
    },
    addInitializer: () => {},
    metadata,
  };
}

function createClassContext(
  ctor: abstract new (...args: any[]) => any,
  metadata: Record<PropertyKey, unknown>,
): ClassDecoratorContext<typeof ctor> {
  return {
    kind: 'class',
    name: ctor.name,
    addInitializer: () => {},
    metadata,
  };
}

describe('tenantId decorator compatibility', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
  });

  it('registers stage-3 tenantId metadata during class decoration', () => {
    const metadata: Record<PropertyKey, unknown> = {};
    const decorator = tenantId({ nullable: true });

    decorator(undefined, createFieldContext('tenantId', metadata));

    class TenantScopedRecord extends SmrtObject {
      tenantId: string | null = null;
    }

    TenantScoped({ mode: 'optional' })(
      TenantScopedRecord,
      createClassContext(TenantScopedRecord, metadata),
    );
    smrt()(
      TenantScopedRecord,
      createClassContext(TenantScopedRecord, metadata),
    );

    expect(
      ObjectRegistry.getFieldDecorator('TenantScopedRecord', 'tenantId'),
    ).toMatchObject({
      type: 'foreignKey',
      nullable: true,
      __tenancy: {
        autoFilter: true,
        autoPopulate: true,
        isTenantIdField: true,
        nullable: true,
        required: true,
      },
    });
  });

  it('reconciles same-name package classes through their exact constructors', () => {
    let requiredConstructor: typeof SmrtObject;
    {
      @smrt({
        packageName: '@fixture/tenant-required',
        tableName: 'tenant_required_collision_2763',
      })
      @TenantScoped({ mode: 'required' })
      class TenantCollision extends SmrtObject {
        @tenantId()
        tenantId = '';
      }
      requiredConstructor = TenantCollision;
    }

    let optionalConstructor: typeof SmrtObject;
    {
      @smrt({
        packageName: '@fixture/tenant-optional',
        tableName: 'tenant_optional_collision_2763',
      })
      @TenantScoped({ mode: 'optional' })
      class TenantCollision extends SmrtObject {
        @tenantId({ nullable: true })
        tenantId: string | null = null;
      }
      optionalConstructor = TenantCollision;
    }

    if (!requiredConstructor || !optionalConstructor) {
      throw new Error('Expected both same-name constructors to be assigned');
    }
    expect(
      ObjectRegistry.getClassByConstructor(requiredConstructor)
        ?.tenantScopedConfig,
    ).toMatchObject({ mode: 'required', field: 'tenantId' });
    expect(
      ObjectRegistry.getClassByConstructor(optionalConstructor)
        ?.tenantScopedConfig,
    ).toMatchObject({ mode: 'optional', field: 'tenantId' });

    const interceptor = createTenantInterceptor();
    expect(() =>
      interceptor.beforeList?.(
        'TenantCollision',
        {},
        {
          className: 'TenantCollision',
          qualifiedClassName: '@fixture/tenant-required:TenantCollision',
          operation: 'list',
          timestamp: new Date(),
        },
      ),
    ).toThrow(TenantContextError);
  });

  it('does not give an ordinary same-name peer a tenant marker', () => {
    {
      @smrt({
        packageName: '@fixture/tenant-owner',
        tableName: 'tenant_owner_record_2763',
      })
      @TenantScoped({ mode: 'required' })
      class Record extends SmrtObject {
        @tenantId()
        tenantId = '';

        @field({ type: 'integer' })
        ownerOnly = 0;
      }
    }

    {
      @smrt({
        packageName: '@fixture/global-peer',
        tableName: 'global_peer_record_2763',
      })
      class Record extends SmrtObject {
        @field({ type: 'text', nullable: true })
        tenantId: string | null = null;
      }
    }

    expect(
      ObjectRegistry.getTenantScopedConfig('@fixture/tenant-owner:Record'),
    ).toMatchObject({ mode: 'required', field: 'tenantId' });
    expect(
      ObjectRegistry.getConflictColumns('@fixture/tenant-owner:Record'),
    ).toEqual(['tenant_id', 'slug', 'context']);
    expect(
      ObjectRegistry.getTenantScopedConfig('@fixture/global-peer:Record'),
    ).toBeUndefined();
    expect(
      ObjectRegistry.getConflictColumns('@fixture/global-peer:Record'),
    ).toEqual(['slug', 'context']);
  });

  it('does not give a same-name peer without a tenant field a tenant marker', () => {
    {
      @smrt({ packageName: '@fixture/tenant-owner-no-field' })
      @TenantScoped({ mode: 'required' })
      class Record extends SmrtObject {
        @tenantId()
        tenantId = '';

        @field({ type: 'integer' })
        ownerOnly = 0;
      }
    }
    {
      @smrt({ packageName: '@fixture/global-peer-no-field' })
      class Record extends SmrtObject {
        @field({ type: 'text' })
        title = '';
      }
    }
    expect(
      ObjectRegistry.getTenantScopedConfig(
        '@fixture/global-peer-no-field:Record',
      ),
    ).toBeUndefined();
    expect(
      ObjectRegistry.getConflictColumns('@fixture/global-peer-no-field:Record'),
    ).toEqual(['slug', 'context']);
    const fields = ObjectRegistry.getFields(
      '@fixture/global-peer-no-field:Record',
    );
    expect(fields.has('tenantId')).toBe(false);
    expect(fields.has('ownerOnly')).toBe(false);
    expect(fields.get('title')?.type).toBe('text');
  });

  it('keeps a silent manifest authoritative in either real class-decorator order', () => {
    @TenantScoped({ mode: 'required' })
    @smrt({
      packageName: '@fixture/silent-manifest-outer-tenant',
      _manifest: {
        packageName: '@fixture/silent-manifest-outer-tenant',
        version: '1.0.0',
        timestamp: 0,
        objects: {
          SilentManifestOuterTenant: {
            className: 'SilentManifestOuterTenant',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      },
      _manifestKey: 'SilentManifestOuterTenant',
    })
    class SilentManifestOuterTenant extends SmrtObject {}

    @smrt({
      packageName: '@fixture/silent-manifest-inner-tenant',
      _manifest: {
        packageName: '@fixture/silent-manifest-inner-tenant',
        version: '1.0.0',
        timestamp: 0,
        objects: {
          SilentManifestInnerTenant: {
            className: 'SilentManifestInnerTenant',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      },
      _manifestKey: 'SilentManifestInnerTenant',
    })
    @TenantScoped({ mode: 'required' })
    class SilentManifestInnerTenant extends SmrtObject {}

    for (const className of [
      'SilentManifestOuterTenant',
      'SilentManifestInnerTenant',
    ]) {
      expect(ObjectRegistry.getTenantScopedConfig(className)).toBeUndefined();
      expect(ObjectRegistry.getConflictColumns(className)).toEqual([
        'slug',
        'context',
      ]);
    }
  });
});
