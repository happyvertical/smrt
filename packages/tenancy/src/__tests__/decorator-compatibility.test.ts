import { ObjectRegistry, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { beforeEach, describe, expect, it } from 'vitest';
import { TenantScoped, tenantId } from '../decorators.js';

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
  });
});
