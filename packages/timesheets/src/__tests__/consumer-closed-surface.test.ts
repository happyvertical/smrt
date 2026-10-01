/**
 * #3288: a consumer can make tenant scoping required and close every
 * generated read and write on the shared time entry, the way teamworks-os
 * declares its time models (`api: { include: [] }`, writes through
 * permission-gated services, reads scoped to the caller's own rows).
 *
 * It does so with existing decorator options only: the consumer declares a
 * same-named subclass over `service_time_entries` with
 * `@TenantScoped({ mode: 'required' })` and
 * `@smrt({ api: { include: [] }, cli: { include: [] }, mcp: { include: [] } })`.
 * Its build-time manifest entry then replaces the package's (one table family,
 * child wins), so every manifest-driven surface — `smrt db:migrate`, route
 * and MCP generation, the registry the consumer's generated registration
 * seeds — reads the consumer's configuration.
 *
 * The consumer manifest below is the timesheets entry re-declared exactly as
 * that subclass scans: same fields and schema, the consumer's package, its
 * `extends`, and its decorator configuration.
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
const BASE = '@happyvertical/smrt-timesheets:ServiceTimeEntry';
const CONSUMER_KEY = `${CONSUMER}:ServiceTimeEntry`;
const CRUD = ['list', 'get', 'create', 'update', 'delete'] as const;
const CLOSED = { include: [] as string[] };

const timesheetsManifest = JSON.parse(
  readFileSync(
    createRequire(import.meta.url).resolve(
      '@happyvertical/smrt-timesheets/manifest.json',
    ),
    'utf8',
  ),
) as SmartObjectManifest;

function consumerManifest(): SmartObjectManifest {
  const base = timesheetsManifest.objects[BASE] as SmartObjectDefinition;
  const entry = structuredClone(base) as SmartObjectDefinition &
    Record<string, unknown>;
  entry.qualifiedName = CONSUMER_KEY;
  entry.packageName = CONSUMER;
  entry.filePath = 'src/lib/server/time/service-time-entry.ts';
  entry.extends = 'ServiceTimeEntry';
  entry.decoratorConfig = {
    ...base.decoratorConfig,
    tenantScoped: { mode: 'required' },
    api: CLOSED,
    cli: CLOSED,
    mcp: CLOSED,
  };
  return {
    version: timesheetsManifest.version,
    timestamp: 0,
    packageName: CONSUMER,
    objects: { [CONSUMER_KEY]: entry },
  } as SmartObjectManifest;
}

function context(operation: InterceptorContext['operation']) {
  return {
    className: 'ServiceTimeEntry',
    qualifiedClassName: CONSUMER_KEY,
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

  it('plans one table family owned by the consumer subtype', () => {
    expect(ObjectRegistry.getClassByQualifiedName(BASE)).toBeUndefined();
    expect(ObjectRegistry.getTableName(CONSUMER_KEY)).toBe(
      'service_time_entries',
    );
    const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
    expect(Object.keys(schemas.service_time_entries.columns)).toEqual(
      expect.arrayContaining(['tenant_id', 'work_ref_type', 'work_ref_id']),
    );
  });

  it('closes every generated REST, CLI, and MCP operation', async () => {
    for (const action of CRUD) {
      expect(isApiActionEnabledForObject(CONSUMER_KEY, action), action).toBe(
        false,
      );
    }
    const config = ObjectRegistry.getConfig(CONSUMER_KEY);
    expect(config.cli).toEqual(CLOSED);
    expect(config.mcp).toEqual(CLOSED);

    const tools = await new MCPGenerator().generateTools();
    expect(
      tools.filter((tool) => tool.name.startsWith('servicetimeentry_')),
    ).toEqual([]);
  });

  it('makes tenant scoping required for reads and writes', async () => {
    expect(getTenantScopedConfig(CONSUMER_KEY)?.mode).toBe('required');
    const interceptor = createTenantInterceptor();
    expect(() =>
      interceptor.beforeList?.('ServiceTimeEntry', {}, context('list')),
    ).toThrow(TenantContextError);

    await withTenant({ tenantId: 'tenant-1' }, async () => {
      expect(
        interceptor.beforeList?.('ServiceTimeEntry', {}, context('list')),
      ).toEqual({ where: { tenantId: 'tenant-1' } });
    });
  });
});
