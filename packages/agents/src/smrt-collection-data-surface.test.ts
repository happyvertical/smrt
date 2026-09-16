import { ObjectRegistry } from '@happyvertical/smrt-core';
import { disableTenancy, enableTenancy } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  type DataSurfaceExecutionContext,
  type DataSurfaceSchema,
} from './data-surface.js';
import {
  buildDataQuerySchemaForClass,
  type CreateSmrtCollectionDataSurfaceOptions,
  clearSmrtCollectionQuerySchemaCache,
  createSmrtCollectionDataSurfaceDefinition,
  type SmrtCollectionQueryCollection,
} from './smrt-collection-data-surface.js';

const QUALIFIED_NAME = '@happyvertical/smrt-agents:SmrtSurfaceFixtureEvent';

function registerFixture(): void {
  ObjectRegistry.registerFromManifest(
    'SmrtSurfaceFixtureEvent',
    {
      className: 'SmrtSurfaceFixtureEvent',
      fields: {
        id: { type: 'text' },
        tenantId: {
          type: 'text',
          _meta: { __tenancy: { isTenantIdField: true } },
        },
        name: { type: 'text' },
        status: { type: 'text' },
        internalNote: { type: 'text', _meta: { sensitive: true } },
        billingToken: {
          type: 'text',
          _meta: { readPermission: 'events.billing.read' },
        },
        cachedTotal: { type: 'decimal', _meta: { transient: true } },
      },
      methods: {},
      decoratorConfig: { tableName: 'smrt_surface_fixture_events' },
      schema: {
        tableName: 'smrt_surface_fixture_events',
        ddl: '',
        columns: {},
        indexes: [],
        version: 'test',
      },
    },
    '@happyvertical/smrt-agents',
  );
}

function context(tenantId = 'tenant-a'): DataSurfaceExecutionContext {
  return {
    run: {
      context: { userId: 'user-a', tenantId },
    } as DataSurfaceExecutionContext['run'],
    principal: { userId: 'user-a', tenantId },
    signal: new AbortController().signal,
  };
}

function principalRun(tenantId: string): DataSurfaceExecutionContext['run'] {
  const allowedTools = [DATA_DISCOVER_TOOL_SLUG, DATA_QUERY_TOOL_SLUG];
  return {
    context: { userId: 'user-a', tenantId },
    permissions: ['events.read'],
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation(collection, action) {
      if (collection !== 'events' || action !== 'read') {
        throw new Error('rbac denied');
      }
      return {
        allowed: true,
        permission: 'events.read',
        reason: 'permission_granted',
      };
    },
  } as DataSurfaceExecutionContext['run'];
}

function fakeCollection(
  rows: Record<string, unknown>[],
): SmrtCollectionQueryCollection {
  return {
    async list({ where, offset = 0, limit }) {
      const matched = where
        ? rows.filter((row) =>
            JSON.stringify(where).includes(String(row.tenantId)),
          )
        : rows;
      const paged = matched.slice(offset);
      return limit === undefined ? paged : paged.slice(0, limit);
    },
    async count({ where } = {}) {
      if (!where) return rows.length;
      const text = JSON.stringify(where);
      return rows.filter((row) => text.includes(String(row.tenantId))).length;
    },
    async facets({ fields }) {
      return fields.map((field) => ({
        field: field.field,
        values: [{ value: 'active', count: rows.length }],
      }));
    },
  };
}

describe('buildDataQuerySchemaForClass', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
  });
  afterEach(() => {
    ObjectRegistry.clear();
    clearSmrtCollectionQuerySchemaCache();
  });

  const BASE_FIELDS = [
    'cachedTotal',
    'context',
    'created_at',
    'slug',
    'updated_at',
  ];

  it('derives a bounded schema from registry field metadata for an arbitrary class', async () => {
    const schema = await buildDataQuerySchemaForClass(QUALIFIED_NAME, {
      exclude: BASE_FIELDS,
    });
    expect(schema.identityField).toBe('id');
    const ids = schema.fields.map((field) => field.id).sort();
    // sensitive, readPermission-gated, transient, and tenant fields are never declared
    expect(ids).toEqual(['id', 'name', 'status']);
  });

  it('respects a caller-supplied exclude list', async () => {
    const schema = await buildDataQuerySchemaForClass(QUALIFIED_NAME, {
      exclude: [...BASE_FIELDS, 'status'],
    });
    expect(schema.fields.map((field) => field.id).sort()).toEqual([
      'id',
      'name',
    ]);
  });
});

describe('createSmrtCollectionDataSurfaceDefinition', () => {
  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
    enableTenancy();
  });
  afterEach(() => {
    disableTenancy();
    ObjectRegistry.clear();
    clearSmrtCollectionQuerySchemaCache();
  });

  it('builds a generic surface for a registered SmrtObject class and executes a bounded read', async () => {
    const rows = [
      { id: 'event-a', tenantId: 'tenant-a', name: 'Alpha', status: 'live' },
    ];
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'events',
      exclude: ['cachedTotal', 'context', 'created_at', 'slug', 'updated_at'],
      collection: fakeCollection(rows),
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });

    expect(definition).toMatchObject({
      collection: 'events',
      className: QUALIFIED_NAME,
    });
    expect(definition.schema.fields.map((field) => field.id).sort()).toEqual([
      'id',
      'name',
      'status',
    ]);

    const result = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'req-1',
        mode: 'rows',
        projection: ['id', 'name'],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      context('tenant-a'),
    );
    expect(result).toMatchObject({
      rows: [{ id: 'event-a', name: 'Alpha' }],
      total: { kind: 'exact', value: 1 },
    });
  });

  it('never exposes a sensitive or readPermission-gated field in the descriptor or in rows', async () => {
    const rows = [
      {
        id: 'event-a',
        tenantId: 'tenant-a',
        name: 'Alpha',
        status: 'live',
        internalNote: 'do-not-leak',
        billingToken: 'secret-token',
      },
    ];
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'events',
      collection: fakeCollection(rows),
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });

    // Not declared in the descriptor schema at all.
    const declaredIds = definition.schema.fields.map((field) => field.id);
    expect(declaredIds).not.toContain('internalNote');
    expect(declaredIds).not.toContain('billingToken');

    // A request naming the restricted field is rejected before the
    // collection is ever resolved/queried.
    await expect(
      definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'req-2',
          mode: 'rows',
          projection: ['id', 'internalNote'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        context('tenant-a'),
      ),
    ).rejects.toThrow(/projection field is not allowed: internalNote/);

    // Even a hostile host-supplied schema override that tries to re-include a
    // sensitive field is redacted before it is ever advertised or executed.
    const hostileSchema: DataSurfaceSchema = {
      version: 1,
      identityField: 'id',
      fields: [
        { id: 'id', type: 'string', projectable: true },
        {
          id: 'internalNote',
          type: 'string',
          projectable: true,
          sensitive: true,
        },
        {
          id: 'billingToken',
          type: 'string',
          projectable: true,
          readPermission: 'events.billing.read',
        },
      ],
    };
    const hostileDefinition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'events',
      schema: hostileSchema,
      collection: fakeCollection(rows),
    });
    expect(hostileDefinition.schema.fields.map((field) => field.id)).toEqual([
      'id',
    ]);
  });

  it('redacts protected fields from data.discover and denies data.query for them end to end', async () => {
    const rows = [
      {
        id: 'event-a',
        tenantId: 'tenant-a',
        name: 'Alpha',
        status: 'live',
        internalNote: 'do-not-leak',
      },
    ];
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'events',
      collection: fakeCollection(rows),
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });
    const tools = new Map(
      createDataSurfaceTools({ surfaces: [definition] }).map((tool) => [
        tool.slug,
        tool,
      ]),
    );
    const run = principalRun('tenant-a');

    const discover = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    expect(JSON.stringify(discover)).not.toContain('internalNote');

    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: definition.id,
        request: {
          version: 1,
          requestId: 'req-3',
          mode: 'rows',
          projection: ['id', 'name'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
      },
      db: undefined,
    });
    expect(JSON.stringify(result)).not.toContain('internalNote');
  });

  it('supports opaque cursor pagination alongside offset pagination', async () => {
    const rows = Array.from({ length: 3 }, (_, index) => ({
      id: `event-${index}`,
      tenantId: 'tenant-a',
      name: `Event ${index}`,
      status: 'live',
    }));
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'events',
      collection: fakeCollection(rows),
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });

    const first = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'cursor-1',
        mode: 'rows',
        projection: ['id'],
        page: { kind: 'cursor', limit: 2 },
      },
      context('tenant-a'),
    );
    expect(first).toMatchObject({
      page: { kind: 'cursor', hasMore: true },
    });
    const nextCursor = (first as { page: { nextCursor?: string } }).page
      .nextCursor;
    expect(typeof nextCursor).toBe('string');
  });

  it('propagates an already-aborted signal before touching the collection', async () => {
    const list = vi.fn(async () => []);
    const definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: QUALIFIED_NAME,
      collectionName: 'events',
      collection: { list, count: vi.fn(async () => 0) },
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'aborted',
          mode: 'rows',
          projection: ['id'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        {
          run: {} as DataSurfaceExecutionContext['run'],
          principal: { userId: 'user-a', tenantId: 'tenant-a' },
          signal: controller.signal,
        },
      ),
    ).rejects.toThrow(/aborted/i);
    expect(list).not.toHaveBeenCalled();
  });

  it('fails factory configuration before exposing an unusable surface', async () => {
    await expect(
      createSmrtCollectionDataSurfaceDefinition({
        id: ' ',
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: fakeCollection([]),
      } satisfies CreateSmrtCollectionDataSurfaceOptions),
    ).rejects.toThrow(
      'SmrtObject collection data surface id must be a non-empty string',
    );
  });
});
