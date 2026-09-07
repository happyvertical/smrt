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
import { field } from '../decorators/index.js';
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
