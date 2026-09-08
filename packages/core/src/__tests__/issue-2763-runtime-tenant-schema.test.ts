/**
 * Issue #2763: direct runtime registration of report system models must retain
 * their optional tenant scope when no package manifest has been preloaded.
 *
 * `@TenantScoped()` lives in smrt-tenancy and class decorators run before
 * `@smrt()`. The registry must therefore recover its configuration from the
 * already-registered `@tenantId()` field rather than silently falling back to
 * the global `(slug, context)` conflict key.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildCascadePlan } from '../cascade.js';
import { field, foreignKey } from '../decorators/index.js';
import { ConfigurationError } from '../errors.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { snapshotObjectRegistryState } from '../test-utils.js';

function registerTenantField(
  className: string,
  { nullable }: { nullable: boolean },
): void {
  ObjectRegistry.registerFieldDecorator(className, 'tenantId', {
    type: 'foreignKey',
    related: 'Tenant',
    sqlType: 'UUID',
    required: false,
    nullable,
    __tenancy: {
      isTenantIdField: true,
      field: 'tenantId',
      autoFilter: true,
      autoPopulate: true,
      allowSuperAdminBypass: false,
    },
  });
}

function tenantConfig(mode: 'required' | 'optional') {
  return {
    mode,
    field: 'tenantId',
    autoFilter: true,
    autoPopulate: true,
    allowSuperAdminBypass: false,
  };
}

describe('runtime tenant schema registration (#2763)', () => {
  let restoreRegistry: () => void;

  beforeEach(() => {
    restoreRegistry = snapshotObjectRegistryState();
  });

  afterEach(() => {
    restoreRegistry();
  });

  it('keeps direct optional-tenant report runtime tables on their tenant-led conflict key', () => {
    registerTenantField('ReportRun', { nullable: true });
    @smrt({ tableName: '_smrt_report_runs_2763' })
    class ReportRun extends SmrtObject {
      tenantId: string | null = null;

      @field({ type: 'text', required: true })
      reportClass = '';
    }

    registerTenantField('ReportRefreshTask', { nullable: true });
    @smrt({ tableName: '_smrt_report_refresh_tasks_2763' })
    class ReportRefreshTask extends SmrtObject {
      tenantId: string | null = null;

      @field({ type: 'text', required: true })
      reportClass = '';
    }

    for (const [className, tableName] of [
      ['ReportRun', '_smrt_report_runs_2763'],
      ['ReportRefreshTask', '_smrt_report_refresh_tasks_2763'],
    ] as const) {
      expect(ObjectRegistry.getConflictColumns(className)).toEqual([
        'tenant_id',
        'slug',
        'context',
      ]);
      expect(ObjectRegistry.getTenantScopedConfig(className)?.mode).toBe(
        'optional',
      );
      expect(
        ObjectRegistry.getAllSchemasAsDefinitions()[tableName]?.indexes,
      ).toContainEqual({
        name: `${tableName}_slug_context_idx`,
        columns: ['tenant_id', 'slug', 'context'],
        unique: true,
      });
    }
  });

  it('uses required tenancy for a non-null direct tenant field', () => {
    registerTenantField('RequiredRuntimeTenant', { nullable: false });
    @smrt({ tableName: 'required_runtime_tenants_2763' })
    class RequiredRuntimeTenant extends SmrtObject {
      tenantId = '';
    }

    expect(
      ObjectRegistry.getTenantScopedConfig('RequiredRuntimeTenant'),
    ).toMatchObject({
      mode: 'required',
      field: 'tenantId',
      autoFilter: true,
      autoPopulate: true,
      allowSuperAdminBypass: false,
    });
    expect(ObjectRegistry.getConflictColumns('RequiredRuntimeTenant')).toEqual([
      'tenant_id',
      'slug',
      'context',
    ]);
  });

  it('matches the optional tenancy contract from the manifest path', () => {
    ObjectRegistry.registerFromManifest(
      'ManifestOptionalRuntimeTenant',
      {
        className: 'ManifestOptionalRuntimeTenant',
        fields: {
          tenantId: {
            type: 'foreignKey',
            nullable: true,
            _meta: { __tenancy: { isTenantIdField: true } },
          },
        },
        methods: {},
        decoratorConfig: { tenantScoped: { mode: 'optional' } },
        schema: {
          tableName: 'manifest_optional_runtime_tenants_2763',
          ddl: '',
          columns: {},
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      '@test/runtime',
    );

    expect(
      ObjectRegistry.getTenantScopedConfig('ManifestOptionalRuntimeTenant'),
    ).toMatchObject({ mode: 'optional', field: 'tenantId' });
    expect(
      ObjectRegistry.getConflictColumns('ManifestOptionalRuntimeTenant'),
    ).toEqual(['tenant_id', 'slug', 'context']);
  });

  it('does not reinterpret a present manifest that omits tenantScoped', () => {
    registerTenantField('ManifestSilentTenant', { nullable: true });
    @smrt({
      packageName: '@test/runtime',
      _manifest: {
        packageName: '@test/runtime',
        version: '1.0.0',
        timestamp: 0,
        objects: {
          ManifestSilentTenant: {
            className: 'ManifestSilentTenant',
            fields: {
              tenantId: {
                type: 'foreignKey',
                nullable: true,
                _meta: { __tenancy: { isTenantIdField: true } },
              },
            },
            methods: {},
            decoratorConfig: {},
            schema: {
              tableName: 'manifest_silent_tenants_2763',
              ddl: '',
              columns: {},
              indexes: [],
              triggers: [],
              foreignKeys: [],
              dependencies: [],
              version: '1.0.0',
            },
          },
        },
      },
      _manifestKey: 'ManifestSilentTenant',
    })
    class ManifestSilentTenant extends SmrtObject {
      tenantId: string | null = null;
    }

    expect(
      ObjectRegistry.getTenantScopedConfig('ManifestSilentTenant'),
    ).toBeUndefined();
    expect(ObjectRegistry.getConflictColumns('ManifestSilentTenant')).toEqual([
      'slug',
      'context',
    ]);
  });

  it('keeps same-name tenant declarations bound to their constructors', () => {
    const FirstTenantCollision = class TenantCollision extends SmrtObject {};
    const SecondTenantCollision = class TenantCollision extends SmrtObject {};

    ObjectRegistry.registerFieldDecoratorForConstructor(
      FirstTenantCollision,
      'tenantId',
      {
        type: 'foreignKey',
        nullable: false,
        __tenancy: { isTenantIdField: true },
      },
    );
    ObjectRegistry.registerFieldDecoratorForConstructor(
      SecondTenantCollision,
      'tenantId',
      {
        type: 'foreignKey',
        nullable: true,
        __tenancy: { isTenantIdField: true },
      },
    );

    ObjectRegistry.register(FirstTenantCollision, {
      packageName: '@fixture/tenant-a',
      tableName: 'tenant_collision_a_2763',
    });
    ObjectRegistry.register(SecondTenantCollision, {
      packageName: '@fixture/tenant-b',
      tableName: 'tenant_collision_b_2763',
    });
    ObjectRegistry.reconcileTenantScopedConfig(
      SecondTenantCollision,
      tenantConfig('optional'),
    );

    expect(
      ObjectRegistry.getClassByConstructor(FirstTenantCollision)
        ?.tenantScopedConfig,
    ).toMatchObject({ mode: 'required' });
    expect(
      ObjectRegistry.getClassByConstructor(SecondTenantCollision)
        ?.tenantScopedConfig,
    ).toMatchObject({ mode: 'optional' });
  });

  it('does not leak a same-name tenant marker into an ordinary peer field', () => {
    const TenantRecord = class Record extends SmrtObject {};
    const GlobalRecord = class Record extends SmrtObject {};
    ObjectRegistry.registerFieldDecoratorForConstructor(
      TenantRecord,
      'tenantId',
      {
        type: 'foreignKey',
        related: 'Tenant',
        nullable: false,
        __tenancy: { isTenantIdField: true },
      },
    );
    ObjectRegistry.registerFieldDecoratorForConstructor(
      GlobalRecord,
      'tenantId',
      { type: 'text', nullable: true },
    );

    ObjectRegistry.register(TenantRecord, {
      packageName: '@fixture/tenant-a',
      tableName: 'tenant_record_a_2763',
    });
    ObjectRegistry.register(GlobalRecord, {
      packageName: '@fixture/tenant-b',
      tableName: 'tenant_record_b_2763',
    });

    expect(
      ObjectRegistry.getClassByConstructor(GlobalRecord)?.tenantScopedConfig,
    ).toBeUndefined();
    expect(
      ObjectRegistry.getConflictColumns('@fixture/tenant-b:Record'),
    ).toEqual(['slug', 'context']);
  });

  it('adopts a standalone exact-constructor tenancy declaration with an ordinary field', () => {
    const StandaloneTenantRecord = class StandaloneTenantRecord extends SmrtObject {};
    ObjectRegistry.reconcileTenantScopedConfig(
      StandaloneTenantRecord,
      tenantConfig('optional'),
    );
    ObjectRegistry.registerFieldDecoratorForConstructor(
      StandaloneTenantRecord,
      'tenantId',
      { type: 'text', nullable: true },
    );
    ObjectRegistry.register(StandaloneTenantRecord, {
      tableName: 'standalone_tenant_record_2763',
    });

    expect(
      ObjectRegistry.getTenantScopedConfig('StandaloneTenantRecord'),
    ).toMatchObject({ mode: 'optional', field: 'tenantId' });
    expect(ObjectRegistry.getConflictColumns('StandaloneTenantRecord')).toEqual(
      ['tenant_id', 'slug', 'context'],
    );
  });

  it('injects the tenant field and refreshes schema assembly when a declaration arrives after registration', () => {
    class PostRegistrationTenant extends SmrtObject {}
    ObjectRegistry.register(PostRegistrationTenant, {
      tableName: 'post_registration_tenants_2763',
    });

    ObjectRegistry.reconcileTenantScopedConfig(
      PostRegistrationTenant,
      tenantConfig('required'),
    );

    const registered = ObjectRegistry.getClassByConstructor(
      PostRegistrationTenant,
    );
    expect(registered?.fields.get('tenantId')).toMatchObject({
      type: 'foreignKey',
      related: 'Tenant',
    });
    expect(ObjectRegistry.getConflictColumns('PostRegistrationTenant')).toEqual(
      ['tenant_id', 'slug', 'context'],
    );
    expect(
      ObjectRegistry.getAllSchemasAsDefinitions().post_registration_tenants_2763
        ?.indexes,
    ).toContainEqual({
      name: 'post_registration_tenants_2763_slug_context_idx',
      columns: ['tenant_id', 'slug', 'context'],
      unique: true,
    });
  });

  it('keeps a caught post-registration silent-manifest conflict unavailable to schema and conflict resolution', () => {
    class CaughtSilentManifestTenant extends SmrtObject {}
    ObjectRegistry.register(CaughtSilentManifestTenant, {
      packageName: '@test/caught-silent-manifest',
      _manifest: {
        packageName: '@test/caught-silent-manifest',
        version: '1.0.0',
        timestamp: 0,
        objects: {
          CaughtSilentManifestTenant: {
            className: 'CaughtSilentManifestTenant',
            fields: {},
            methods: {},
            decoratorConfig: {},
          },
        },
      },
      _manifestKey: 'CaughtSilentManifestTenant',
    });

    expect(() =>
      ObjectRegistry.reconcileTenantScopedConfig(
        CaughtSilentManifestTenant,
        tenantConfig('required'),
      ),
    ).toThrow(ConfigurationError);

    const identity = '@test/caught-silent-manifest:CaughtSilentManifestTenant';
    expect(() => ObjectRegistry.getConflictColumns(identity)).toThrow(
      ConfigurationError,
    );
    expect(() => ObjectRegistry.getTenantColumn(identity)).toThrow(
      ConfigurationError,
    );
    expect(() => ObjectRegistry.getAllSchemasAsDefinitions()).toThrow(
      ConfigurationError,
    );

    expect(() =>
      ObjectRegistry.reconcileTenantScopedConfig(
        CaughtSilentManifestTenant,
        tenantConfig('required'),
      ),
    ).toThrow(ConfigurationError);

    ObjectRegistry.registerFromManifest(
      '@test/caught-silent-manifest:CaughtSilentManifestTenant',
      {
        className: 'CaughtSilentManifestTenant',
        fields: {},
        methods: {},
        decoratorConfig: { tenantScoped: { mode: 'required' } },
      },
      '@test/caught-silent-manifest',
    );

    expect(ObjectRegistry.getTenantScopedConfig(identity)).toMatchObject({
      mode: 'required',
      field: 'tenantId',
    });
    expect(ObjectRegistry.getConflictColumns(identity)).toEqual([
      'tenant_id',
      'slug',
      'context',
    ]);
  });

  it('rejects a silent isolated manifest before it can promote an exact runtime constructor', () => {
    class PromotedSilentManifestTenant extends SmrtObject {}
    ObjectRegistry.reconcileTenantScopedConfig(
      PromotedSilentManifestTenant,
      tenantConfig('required'),
    );
    ObjectRegistry.register(PromotedSilentManifestTenant, {
      tableName: 'promoted_silent_manifest_tenants_2763',
    });

    expect(() =>
      ObjectRegistry.register(PromotedSilentManifestTenant, {
        packageName: '@test/promoted-silent-manifest',
        _manifest: {
          packageName: '@test/promoted-silent-manifest',
          version: '1.0.0',
          timestamp: 0,
          objects: {
            PromotedSilentManifestTenant: {
              className: 'PromotedSilentManifestTenant',
              fields: {},
              methods: {},
              decoratorConfig: {},
            },
          },
        },
        _manifestKey: 'PromotedSilentManifestTenant',
      }),
    ).toThrow(ConfigurationError);

    expect(
      ObjectRegistry.getClassByConstructor(PromotedSilentManifestTenant)
        ?.tenantScopedConfig,
    ).toMatchObject({ mode: 'required', field: 'tenantId' });
    expect(
      ObjectRegistry.getConflictColumns('PromotedSilentManifestTenant'),
    ).toEqual(['tenant_id', 'slug', 'context']);
  });

  it('does not widen inverse relationships across same-name package targets', () => {
    const ParentA = class Parent extends SmrtObject {};
    const ParentB = class Parent extends SmrtObject {};
    const Child = class Child extends SmrtObject {};
    ObjectRegistry.registerFieldDecoratorForConstructor(Child, 'parentId', {
      type: 'crossPackageRef',
      related: '@fixture/parent-b:Parent',
    });
    ObjectRegistry.register(ParentA, {
      packageName: '@fixture/parent-a',
      tableName: 'parent_a_2763',
    });
    ObjectRegistry.register(ParentB, {
      packageName: '@fixture/parent-b',
      tableName: 'parent_b_2763',
    });
    ObjectRegistry.register(Child, {
      packageName: '@fixture/child',
      tableName: 'child_2763',
    });

    expect(
      ObjectRegistry.getInverseRelationshipsForSelf('@fixture/parent-a:Parent'),
    ).toEqual([]);
    expect(
      ObjectRegistry.getInverseRelationshipsForSelf('@fixture/parent-b:Parent'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          fieldName: 'parentId',
          targetClass: '@fixture/parent-b:Parent',
        }),
      ]),
    );
  });

  it('keeps a constructor foreign key with its same-package parent', () => {
    const ParentA = class Parent extends SmrtObject {};
    const ParentB = class Parent extends SmrtObject {};
    ObjectRegistry.register(ParentA, { packageName: '@fixture/parent-a' });
    ObjectRegistry.register(ParentB, { packageName: '@fixture/parent-b' });
    class Child extends SmrtObject {
      parentId = '';
    }
    foreignKey(ParentB)(Child.prototype, 'parentId');
    ObjectRegistry.register(Child, { packageName: '@fixture/child-b' });
    expect(
      ObjectRegistry.getInverseRelationshipsForSelf('@fixture/parent-a:Parent'),
    ).toEqual([]);
    expect(
      ObjectRegistry.getInverseRelationshipsForSelf('@fixture/parent-b:Parent'),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fieldName: 'parentId' }),
      ]),
    );
    expect(
      buildCascadePlan(ObjectRegistry, '@fixture/parent-a:Parent').references,
    ).toEqual([]);
    expect(
      buildCascadePlan(ObjectRegistry, '@fixture/parent-b:Parent').references,
    ).toEqual(expect.arrayContaining([expect.anything()]));
  });

  it('lets a late silent manifest clear provisional field tenancy', () => {
    registerTenantField('LateManifestSilentTenant', { nullable: true });
    @smrt({
      packageName: '@test/late-manifest',
      tableName: 'late_manifest_silent_tenants_2763',
    })
    class LateManifestSilentTenant extends SmrtObject {
      tenantId: string | null = null;
    }

    expect(
      ObjectRegistry.getTenantScopedConfig('LateManifestSilentTenant'),
    ).toMatchObject({ mode: 'optional' });

    ObjectRegistry.registerFromManifest(
      '@test/late-manifest:LateManifestSilentTenant',
      {
        className: 'LateManifestSilentTenant',
        fields: {},
        methods: {},
        decoratorConfig: {},
        schema: {
          tableName: 'late_manifest_silent_tenants_2763',
          ddl: '',
          columns: {},
          indexes: [],
          triggers: [],
          foreignKeys: [],
          dependencies: [],
          version: '1.0.0',
        },
      },
      '@test/late-manifest',
    );

    expect(
      ObjectRegistry.getTenantScopedConfig('LateManifestSilentTenant'),
    ).toBeUndefined();
    expect(
      ObjectRegistry.getConflictColumns('LateManifestSilentTenant'),
    ).toEqual(['slug', 'context']);
  });

  it('refuses a late silent manifest without mutating an exact runtime tenancy declaration', () => {
    class LateManifestReconciledTenant extends SmrtObject {}
    ObjectRegistry.reconcileTenantScopedConfig(
      LateManifestReconciledTenant,
      tenantConfig('required'),
    );
    ObjectRegistry.register(LateManifestReconciledTenant, {
      packageName: '@test/late-manifest-reconciled',
      tableName: 'late_manifest_reconciled_tenants_2763',
    });

    expect(() =>
      ObjectRegistry.registerFromManifest(
        '@test/late-manifest-reconciled:LateManifestReconciledTenant',
        {
          className: 'LateManifestReconciledTenant',
          fields: {},
          methods: {},
          decoratorConfig: {},
        },
        '@test/late-manifest-reconciled',
      ),
    ).toThrow(ConfigurationError);

    expect(
      ObjectRegistry.getTenantScopedConfig('LateManifestReconciledTenant'),
    ).toMatchObject({ mode: 'required', field: 'tenantId' });
    expect(
      ObjectRegistry.getConflictColumns('LateManifestReconciledTenant'),
    ).toEqual(['tenant_id', 'slug', 'context']);
  });

  it('keeps explicit core tenancy when a late manifest is silent', () => {
    @smrt({
      packageName: '@test/explicit-manifest',
      tableName: 'explicit_manifest_silent_tenants_2763',
      tenantScoped: { mode: 'required' },
    })
    class ExplicitManifestSilentTenant extends SmrtObject {}

    ObjectRegistry.registerFromManifest(
      '@test/explicit-manifest:ExplicitManifestSilentTenant',
      {
        className: 'ExplicitManifestSilentTenant',
        fields: {},
        methods: {},
        decoratorConfig: {},
      },
      '@test/explicit-manifest',
    );

    expect(
      ObjectRegistry.getTenantScopedConfig('ExplicitManifestSilentTenant'),
    ).toMatchObject({ mode: 'required', field: 'tenantId' });
  });

  it('does not infer tenancy from an ordinary field', () => {
    @smrt({ tableName: 'global_runtime_records_2763' })
    class GlobalRuntimeRecord extends SmrtObject {
      @field({ type: 'text', nullable: true })
      tenantId: string | null = null;
    }

    expect(
      ObjectRegistry.getTenantScopedConfig('GlobalRuntimeRecord'),
    ).toBeUndefined();
    expect(ObjectRegistry.getConflictColumns('GlobalRuntimeRecord')).toEqual([
      'slug',
      'context',
    ]);
  });

  it('keeps explicit tenancy and conflict options ahead of inferred field metadata', () => {
    registerTenantField('ExplicitRuntimeTenant', { nullable: true });
    @smrt({
      tableName: 'explicit_runtime_tenants_2763',
      tenantScoped: {
        mode: 'required',
        autoFilter: false,
        autoPopulate: false,
        allowSuperAdminBypass: true,
      },
      conflictColumns: ['externalId'],
    })
    class ExplicitRuntimeTenant extends SmrtObject {
      tenantId: string | null = null;

      @field({ type: 'text', required: true })
      externalId = '';
    }

    expect(
      ObjectRegistry.getTenantScopedConfig('ExplicitRuntimeTenant'),
    ).toMatchObject({
      mode: 'required',
      field: 'tenantId',
      autoFilter: false,
      autoPopulate: false,
      allowSuperAdminBypass: true,
    });
    expect(ObjectRegistry.getConflictColumns('ExplicitRuntimeTenant')).toEqual([
      'externalId',
    ]);
  });
});
