/**
 * #3288: a consumer can make tenant scoping required and close every
 * generated read and write on the shared time entry, the way teamworks-os
 * declares its time models (`api: { include: [] }`, writes through
 * permission-gated services, reads scoped to the caller's own rows).
 *
 * It does so with existing decorator options only: the consumer declares a
 * same-named subclass over each table (`service_time_entries`,
 * `service_charge_snapshots`, `service_compensation_snapshots`) with
 * `@TenantScoped({ mode: 'required' })` and
 * `@smrt({ api: { include: [] }, cli: { include: [] }, mcp: { include: [] } })`.
 * Its build-time manifest entry then replaces the package's (one table family,
 * child wins), so every manifest-driven surface — `smrt db:migrate`, route
 * and MCP generation, the registry the consumer's generated registration
 * seeds — reads the consumer's configuration.
 *
 * The consumer manifest below re-declares each timesheets model exactly as
 * that subclass scans: same fields and schema, the consumer's package, its
 * `extends`, and its decorator configuration. The snapshots keep their
 * explicit `time_entry_id` conflict key (see the README for that decision).
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  type InterceptorContext,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  isApiActionEnabledForObject,
  MCPGenerator,
} from '@happyvertical/smrt-core/generators';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '@happyvertical/smrt-core/scanner/types';
import {
  createTenantInterceptor,
  getTenantScopedConfig,
  TenantContextError,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const CONSUMER = '@fixture/teamworks-os';
const CRUD = ['list', 'get', 'create', 'update', 'delete'] as const;
const CLOSED = { include: [] as string[] };

/** Each moved model, its table, and its generated MCP tool prefix. */
const MODELS = [
  {
    className: 'ServiceTimeEntry',
    table: 'service_time_entries',
    toolPrefix: 'servicetimeentry_',
  },
  {
    className: 'ServiceChargeSnapshot',
    table: 'service_charge_snapshots',
    toolPrefix: 'servicechargesnapshot_',
  },
  {
    className: 'ServiceCompensationSnapshot',
    table: 'service_compensation_snapshots',
    toolPrefix: 'servicecompensationsnapshot_',
  },
] as const;

const baseKey = (className: string) =>
  `@happyvertical/smrt-timesheets:${className}`;
const consumerKey = (className: string) => `${CONSUMER}:${className}`;

const timesheetsManifest = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      '@happyvertical/smrt-timesheets/manifest.json',
    ),
    'utf8',
  ),
) as SmartObjectManifest;

function consumerManifest(): SmartObjectManifest {
  const objects: Record<string, SmartObjectDefinition> = {};
  for (const { className } of MODELS) {
    const base = timesheetsManifest.objects[
      baseKey(className)
    ] as SmartObjectDefinition;
    const entry = structuredClone(base) as SmartObjectDefinition &
      Record<string, unknown>;
    entry.qualifiedName = consumerKey(className);
    entry.packageName = CONSUMER;
    entry.filePath = 'src/lib/server/time/models.ts';
    entry.extends = className;
    entry.decoratorConfig = {
      ...base.decoratorConfig,
      tenantScoped: { mode: 'required' },
      api: CLOSED,
      cli: CLOSED,
      mcp: CLOSED,
    };
    objects[consumerKey(className)] = entry;
  }
  return {
    version: timesheetsManifest.version,
    timestamp: 0,
    packageName: CONSUMER,
    objects,
  } as SmartObjectManifest;
}

function context(
  className: string,
  operation: InterceptorContext['operation'],
) {
  return {
    className,
    qualifiedClassName: consumerKey(className),
    operation,
    timestamp: new Date(),
  } satisfies InterceptorContext;
}

describe('consumer-closed time entry surface', () => {
  beforeAll(() => {
    ObjectRegistry.clear();
    ObjectRegistry.registerPackageManifest(timesheetsManifest);
    ObjectRegistry.registerPackageManifest(consumerManifest());
  });

  afterAll(() => {
    ObjectRegistry.clear();
  });

  it('plans one table family per model, owned by the consumer subtype', () => {
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    for (const { className, table } of MODELS) {
      expect(
        ObjectRegistry.getClassByQualifiedName(baseKey(className)),
        className,
      ).toBeUndefined();
      expect(ObjectRegistry.getTableName(consumerKey(className))).toBe(table);
      expect(Object.keys(schemas[table].columns), table).toContain('tenant_id');
    }
    expect(Object.keys(schemas.service_time_entries.columns)).toEqual(
      expect.arrayContaining(['work_ref_type', 'work_ref_id']),
    );
    for (const table of [
      'service_charge_snapshots',
      'service_compensation_snapshots',
    ]) {
      expect(Object.keys(schemas[table].columns), table).toEqual(
        expect.arrayContaining(['time_entry_id', 'amount']),
      );
    }
  });

  it('closes every generated REST, CLI, and MCP operation', async () => {
    const tools = await new MCPGenerator().generateTools();
    for (const { className, toolPrefix } of MODELS) {
      const name = consumerKey(className);
      for (const action of CRUD) {
        expect(
          isApiActionEnabledForObject(name, action),
          `${className}.${action}`,
        ).toBe(false);
      }
      const config = ObjectRegistry.getConfig(name);
      expect(config.cli, className).toEqual(CLOSED);
      expect(config.mcp, className).toEqual(CLOSED);
      expect(
        tools.filter((tool) => tool.name.startsWith(toolPrefix)),
        className,
      ).toEqual([]);
    }
  });

  it('makes tenant scoping required for reads and writes', async () => {
    const interceptor = createTenantInterceptor();
    for (const { className } of MODELS) {
      expect(getTenantScopedConfig(consumerKey(className))?.mode).toBe(
        'required',
      );
      expect(() =>
        interceptor.beforeList?.(className, {}, context(className, 'list')),
      ).toThrow(TenantContextError);

      await withTenant({ tenantId: 'tenant-1' }, async () => {
        expect(
          interceptor.beforeList?.(className, {}, context(className, 'list')),
        ).toEqual({ where: { tenantId: 'tenant-1' } });
      });
    }
  });
});
