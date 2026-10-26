/**
 * #4381: host-declared allowed field values reach agents through
 * `data.inspect`/`data.discover`, guide `data.query` filters, and derive from
 * scanner-declared SMRT enums — never from row data.
 */
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceRequestError,
  type DataSurfaceSchema,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';
import {
  buildDataQuerySchemaForClass,
  clearSmrtCollectionQuerySchemaCache,
  createSmrtCollectionDataSurfaceDefinition,
  type SmrtCollectionQueryCollection,
} from './smrt-collection-data-surface.js';

const STATUS_VALUES = [
  { value: 'pending', label: 'Open', description: 'Awaiting work' },
  { value: 'in_progress', label: 'Open' },
  { value: 'done', label: 'Closed' },
];

const schema: DataSurfaceSchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', projectable: true, sortable: true },
    {
      id: 'status',
      type: 'string',
      projectable: true,
      filterOperators: ['eq', 'in'],
      values: STATUS_VALUES,
    },
    { id: 'name', type: 'string', projectable: true },
  ],
};

const TOOLS = [
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
];

function fakeRun(): PrincipalRun {
  const permissions = ['records.read'];
  return {
    context: {
      userId: 'user-a',
      tenantId: 'tenant-a',
      database: undefined,
      permissions,
      permissionSet: new Set(permissions),
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } satisfies SessionPermissionRuntimeContext,
    permissions,
    allowedTools: TOOLS,
    isToolAllowed: (tool) => TOOLS.includes(tool),
    assertToolAllowed(tool) {
      if (!TOOLS.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation() {
      return {
        allowed: true,
        permission: 'records.read',
        reason: 'permission_granted',
      };
    },
  };
}

function tools(execute = vi.fn()) {
  const map = new Map(
    createDataSurfaceTools({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute,
    }).map((tool) => [tool.slug, tool]),
  );
  return (slug: string, args: Record<string, unknown>) => {
    const tool = map.get(slug);
    if (!tool) throw new Error(`${slug} missing`);
    return tool.execute({ run: fakeRun(), args, db: undefined });
  };
}

function fieldsOf(descriptor: unknown) {
  return (descriptor as { fields: Array<Record<string, unknown>> }).fields;
}

describe('data surface allowed values (#4381)', () => {
  it('surfaces declared values in data.inspect and data.discover', async () => {
    const call = tools();
    const inspected = fieldsOf(
      await call(DATA_INSPECT_TOOL_SLUG, { surfaceId: 'records' }),
    );
    expect(inspected.find((field) => field.id === 'status')?.values).toEqual(
      STATUS_VALUES,
    );
    expect(inspected.find((field) => field.id === 'name')).not.toHaveProperty(
      'values',
    );
    const discovered = (await call(DATA_DISCOVER_TOOL_SLUG, {})) as unknown[];
    const discoveredStatus = fieldsOf(discovered[0]).find(
      (field) => field.id === 'status',
    );
    expect(discoveredStatus?.values).toEqual(STATUS_VALUES);
    // A hand-written declaration is authoritative.
    expect(discoveredStatus?.valuesEnforced).toBe(true);
    expect(
      inspected.find((field) => field.id === 'status')?.valuesEnforced,
    ).toBe(true);
    expect(inspected.find((field) => field.id === 'name')).not.toHaveProperty(
      'valuesEnforced',
    );
  });

  it('rejects an undeclared filter value with the allowed list', async () => {
    const execute = vi.fn();
    const call = tools(execute);
    let caught: unknown;
    try {
      await call(DATA_QUERY_TOOL_SLUG, {
        surfaceId: 'records',
        request: {
          mode: 'count',
          filter: {
            kind: 'condition',
            field: 'status',
            operator: 'eq',
            value: 'open',
          },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DataSurfaceRequestError);
    const error = caught as DataSurfaceRequestError;
    expect(error.reason).toBe('DATA_QUERY_VALUE_NOT_ALLOWED');
    expect(error.message).toContain(
      'use one of: "pending", "in_progress", "done".',
    );
    expect(error.message).toContain('Call data.inspect');
    expect(execute).not.toHaveBeenCalled();
  });
});

const QUALIFIED_NAME = '@happyvertical/smrt-agents:SmrtSurfaceEnumFixture';

describe('smrt-collection allowed-value derivation (#4381)', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    ObjectRegistry.registerFromManifest(
      'SmrtSurfaceEnumFixture',
      {
        className: 'SmrtSurfaceEnumFixture',
        fields: {
          id: { type: 'text' },
          status: { type: 'text', enum: ['pending', 'in_progress', 'done'] },
          priority: { type: 'integer', _meta: { enum: [1, 2, 3] } },
          mismatched: { type: 'integer', enum: ['a'] },
          oversized: {
            type: 'text',
            enum: Array.from({ length: 101 }, (_, index) => `v${index}`),
          },
          unsafe: {
            type: 'text',
            enum: ['ok', `bad${String.fromCharCode(0x202e)}`],
          },
          name: { type: 'text' },
        },
        methods: {},
        decoratorConfig: { tableName: 'smrt_surface_enum_fixtures' },
        schema: {
          tableName: 'smrt_surface_enum_fixtures',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test',
        },
      } as never,
      '@happyvertical/smrt-agents',
    );
  });
  afterEach(() => {
    ObjectRegistry.clear();
    clearSmrtCollectionQuerySchemaCache();
  });

  async function enumSurface(enforceDerivedValues?: boolean) {
    const list = vi.fn(async (_options: Record<string, unknown>) => []);
    const collection: SmrtCollectionQueryCollection = {
      list,
      async count() {
        return 0;
      },
    };
    const surface = await createSmrtCollectionDataSurfaceDefinition({
      id: 'enum-records',
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'records',
      collection,
      facets: false,
      exclude: ['context', 'created_at', 'slug', 'updated_at'],
      ...(enforceDerivedValues === undefined ? {} : { enforceDerivedValues }),
    });
    const map = new Map(
      createDataSurfaceTools({ surfaces: [surface] }).map((tool) => [
        tool.slug,
        tool,
      ]),
    );
    const call = (slug: string, args: Record<string, unknown>) =>
      map.get(slug)?.execute({ run: fakeRun(), args, db: undefined });
    const countStatus = (value: unknown) =>
      call(DATA_QUERY_TOOL_SLUG, {
        surfaceId: 'enum-records',
        request: {
          mode: 'count',
          filter: { kind: 'condition', field: 'status', operator: 'eq', value },
        },
      });
    const status = fieldsOf(
      await call(DATA_INSPECT_TOOL_SLUG, { surfaceId: 'enum-records' }),
    ).find((field) => field.id === 'status');
    return { status, countStatus };
  }

  it('surfaces derived values as advisory and accepts legacy filter values by default', async () => {
    const { status, countStatus } = await enumSurface();
    expect(status?.values).toEqual([
      { value: 'pending' },
      { value: 'in_progress' },
      { value: 'done' },
    ]);
    expect(status?.valuesEnforced).toBe(false);
    await expect(countStatus('legacy_open')).resolves.toBeDefined();
  });

  it('enforces derived values when the host opts in', async () => {
    const { status, countStatus } = await enumSurface(true);
    expect(status?.valuesEnforced).toBe(true);
    await expect(countStatus('legacy_open')).rejects.toMatchObject({
      reason: 'DATA_QUERY_VALUE_NOT_ALLOWED',
    });
    await expect(countStatus('pending')).resolves.toBeDefined();
  });

  it('derives values from declared enums and omits out-of-bounds ones', async () => {
    const built = await buildDataQuerySchemaForClass(QUALIFIED_NAME, {
      exclude: ['context', 'created_at', 'slug', 'updated_at'],
    });
    const byId = new Map(built.fields.map((field) => [field.id, field]));
    expect(byId.get('status')?.values).toEqual([
      { value: 'pending' },
      { value: 'in_progress' },
      { value: 'done' },
    ]);
    expect(byId.get('status')?.valuesEnforced).toBe(false);
    expect(byId.get('priority')?.values).toEqual([
      { value: 1 },
      { value: 2 },
      { value: 3 },
    ]);
    for (const id of ['id', 'name', 'mismatched', 'oversized', 'unsafe']) {
      expect(byId.get(id)).not.toHaveProperty('values');
    }
  });
});
