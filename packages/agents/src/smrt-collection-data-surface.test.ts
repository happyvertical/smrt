import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  registerTenantScopedClass,
  unregisterTenantScopedClass,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
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
  executeSmrtCollectionQuery,
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

/** Collection stub that records the `where`/`offset`/`limit` of every call. */
function recordingCollection(
  rows: Record<string, unknown>[],
  overrides: Partial<SmrtCollectionQueryCollection> = {},
): SmrtCollectionQueryCollection & {
  listCalls: unknown[];
  countCalls: unknown[];
} {
  const listCalls: unknown[] = [];
  const countCalls: unknown[] = [];
  return {
    listCalls,
    countCalls,
    async list(opts) {
      listCalls.push(opts.where);
      return rows;
    },
    async count(opts) {
      countCalls.push(opts?.where);
      return rows.length;
    },
    ...overrides,
  };
}

describe('review findings (#2910)', () => {
  const UNSCOPED_NAME = '@happyvertical/smrt-agents:SmrtSurfaceFixtureUnscoped';

  beforeEach(() => {
    ObjectRegistry.clear();
    registerFixture();
    ObjectRegistry.registerFromManifest(
      'SmrtSurfaceFixtureUnscoped',
      {
        className: 'SmrtSurfaceFixtureUnscoped',
        fields: {
          id: { type: 'text' },
          name: { type: 'text' },
        },
        methods: {},
        decoratorConfig: { tableName: 'smrt_surface_fixture_unscoped' },
        schema: {
          tableName: 'smrt_surface_fixture_unscoped',
          ddl: '',
          columns: {},
          indexes: [],
          version: 'test',
        },
      },
      '@happyvertical/smrt-agents',
    );
    enableTenancy();
    registerTenantScopedClass(QUALIFIED_NAME, { field: 'tenantId' });
  });
  afterEach(() => {
    unregisterTenantScopedClass(QUALIFIED_NAME);
    disableTenancy();
    ObjectRegistry.clear();
    clearSmrtCollectionQuerySchemaCache();
  });

  describe('finding 1: class-aware tenant scope', () => {
    it('scopes on the configured tenant field for a tenant-scoped class', async () => {
      registerTenantScopedClass(QUALIFIED_NAME, { field: 'orgId' });
      const rows = [{ id: 'event-a', name: 'Alpha' }];
      const collection = recordingCollection(rows);
      await withTenant({ tenantId: 'tenant-a' }, async () =>
        executeSmrtCollectionQuery(
          collection,
          {
            version: 1,
            requestId: 'r1',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'offset', offset: 0, limit: 10 },
          },
          {
            schema: await buildDataQuerySchemaForClass(QUALIFIED_NAME, {
              exclude: [
                'cachedTotal',
                'context',
                'created_at',
                'slug',
                'updated_at',
              ],
            }),
            qualifiedName: QUALIFIED_NAME,
          },
        ),
      );
      expect(JSON.stringify(collection.listCalls[0])).toContain('orgId');
      expect(JSON.stringify(collection.listCalls[0])).not.toContain(
        '"tenantId"',
      );
    });

    it('adds no tenant condition at all for an unscoped class', async () => {
      const rows = [{ id: 'event-a', name: 'Alpha' }];
      const collection = recordingCollection(rows);
      await executeSmrtCollectionQuery(
        collection,
        {
          version: 1,
          requestId: 'r2',
          mode: 'rows',
          projection: ['id'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        {
          schema: await buildDataQuerySchemaForClass(UNSCOPED_NAME, {}),
          qualifiedName: UNSCOPED_NAME,
        },
      );
      expect(collection.listCalls[0]).toBeUndefined();
    });
  });

  describe('finding 2: existing tenant/system context is preserved', () => {
    it('never re-enters withTenant when a system context is already active', async () => {
      const rows = [{ id: 'event-a', name: 'Alpha', status: 'live' }];
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: fakeCollection(rows),
      });
      const result = await withSystemContext(() =>
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'sys-1',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'offset', offset: 0, limit: 10 },
          },
          context('tenant-a'),
        ),
      );
      // System context bypasses tenant scoping entirely; every row is visible.
      expect(result).toMatchObject({ total: { kind: 'exact', value: 1 } });
    });

    it('keeps an already-active tenant context instead of overwriting it with the principal', async () => {
      registerTenantScopedClass(QUALIFIED_NAME, { field: 'tenantId' });
      const rows = [
        { id: 'event-a', tenantId: 'tenant-active', name: 'Alpha' },
      ];
      const collection = recordingCollection(rows);
      const schema = await buildDataQuerySchemaForClass(QUALIFIED_NAME, {
        exclude: ['cachedTotal', 'context', 'created_at', 'slug', 'updated_at'],
      });
      await withTenant({ tenantId: 'tenant-active' }, async () => {
        // Simulate execute()'s own guard directly against the exported
        // executor: a caller already inside a tenant context should never
        // be re-entered with a different (principal) tenant id.
        await executeSmrtCollectionQuery(
          collection,
          {
            version: 1,
            requestId: 'r3',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'offset', offset: 0, limit: 10 },
          },
          { schema, qualifiedName: QUALIFIED_NAME },
        );
      });
      expect(JSON.stringify(collection.listCalls[0])).toContain(
        'tenant-active',
      );
    });

    it('rejects execute() when an ambient tenant context disagrees with the authenticated principal', async () => {
      registerTenantScopedClass(QUALIFIED_NAME, { field: 'tenantId' });
      const rows = [{ id: 'event-a', tenantId: 'tenant-other', name: 'Leak' }];
      const list = vi.fn(async () => rows);
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: { list, count: async () => rows.length },
      });
      // A caller nested inside an unrelated ambient tenant context (e.g.
      // `executeAsPrincipal({ enterTenantContext: false })` running under a
      // stale outer `withTenant`) must never silently scope to that ambient
      // tenant instead of the authenticated principal's own tenant.
      await withTenant({ tenantId: 'tenant-other' }, async () => {
        await expect(
          definition.execute?.(
            definition,
            {
              version: 1,
              requestId: 'mismatch-1',
              mode: 'rows',
              projection: ['id'],
              page: { kind: 'offset', offset: 0, limit: 10 },
            },
            context('tenant-a'),
          ),
        ).rejects.toThrow(/tenant context/i);
      });
      expect(list).not.toHaveBeenCalled();
    });

    it('proceeds when the ambient tenant context matches the authenticated principal', async () => {
      registerTenantScopedClass(QUALIFIED_NAME, { field: 'tenantId' });
      const rows = [{ id: 'event-a', tenantId: 'tenant-a', name: 'Alpha' }];
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: fakeCollection(rows),
        scope: (execution) => ({ tenantId: execution.principal.tenantId }),
      });
      const result = await withTenant({ tenantId: 'tenant-a' }, () =>
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'match-1',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'offset', offset: 0, limit: 10 },
          },
          context('tenant-a'),
        ),
      );
      expect(result).toMatchObject({ total: { kind: 'exact', value: 1 } });
    });

    it('rejects execute() for a tenant-less principal when a mismatched ambient tenant context is active', async () => {
      registerTenantScopedClass(QUALIFIED_NAME, { field: 'tenantId' });
      const rows = [{ id: 'event-a', tenantId: 'tenant-other', name: 'Leak' }];
      const list = vi.fn(async () => rows);
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: { list, count: async () => rows.length },
      });
      // A principal that holds no tenant claim at all (`tenantId: null`)
      // must not silently fall through to `run()` when an unrelated ambient
      // tenant context is active: the mismatch check must not be gated on
      // the principal's own `tenantId` being truthy.
      await withTenant({ tenantId: 'tenant-other' }, async () => {
        await expect(
          definition.execute?.(
            definition,
            {
              version: 1,
              requestId: 'mismatch-null',
              mode: 'rows',
              projection: ['id'],
              page: { kind: 'offset', offset: 0, limit: 10 },
            },
            {
              run: {} as DataSurfaceExecutionContext['run'],
              principal: { userId: 'user-a', tenantId: null },
              signal: new AbortController().signal,
            },
          ),
        ).rejects.toThrow(/tenant context/i);
      });
      expect(list).not.toHaveBeenCalled();
    });
  });

  describe('finding 3: query-bound opaque cursors', () => {
    async function cursorDefinition() {
      const rows = Array.from({ length: 5 }, (_, index) => ({
        id: `event-${index}`,
        tenantId: 'tenant-a',
        name: `Event ${index}`,
        status: index % 2 === 0 ? 'live' : 'draft',
      }));
      return createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: fakeCollection(rows),
        scope: (execution) => ({ tenantId: execution.principal.tenantId }),
      });
    }

    it('rejects a cursor replayed against a different filter', async () => {
      const definition = await cursorDefinition();
      const first = await definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'c1',
          mode: 'rows',
          projection: ['id'],
          page: { kind: 'cursor', limit: 2 },
        },
        context('tenant-a'),
      );
      const nextCursor = (first as { page: { nextCursor?: string } }).page
        .nextCursor as string;
      await expect(
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'c2',
            mode: 'rows',
            projection: ['id'],
            filter: {
              kind: 'condition',
              field: 'status',
              operator: 'eq',
              value: 'live',
            },
            page: { kind: 'cursor', after: nextCursor, limit: 2 },
          },
          context('tenant-a'),
        ),
      ).rejects.toThrow(/cursor/i);
    });

    it('rejects a cursor replayed under a different tenant', async () => {
      const definition = await cursorDefinition();
      const first = await definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'c3',
          mode: 'rows',
          projection: ['id'],
          page: { kind: 'cursor', limit: 2 },
        },
        context('tenant-a'),
      );
      const nextCursor = (first as { page: { nextCursor?: string } }).page
        .nextCursor as string;
      await expect(
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'c4',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'cursor', after: nextCursor, limit: 2 },
          },
          context('tenant-b'),
        ),
      ).rejects.toThrow(/cursor/i);
    });

    it('rejects a forged/malformed cursor', async () => {
      const definition = await cursorDefinition();
      await expect(
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'c5',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'cursor', after: 'not-valid-base64url!!', limit: 2 },
          },
          context('tenant-a'),
        ),
      ).rejects.toThrow(/cursor/i);
    });

    it('rejects a cursor whose offset exceeds MAX_DATA_QUERY_OFFSET', async () => {
      const definition = await cursorDefinition();
      const forged = Buffer.from(
        JSON.stringify({ binding: 'x', offset: 5_000_000 }),
        'utf8',
      ).toString('base64url');
      await expect(
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'c6',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'cursor', after: forged, limit: 2 },
          },
          context('tenant-a'),
        ),
      ).rejects.toThrow(/cursor/i);
    });
  });

  describe('finding 4: facets capability derived from the collection', () => {
    it('defaults supports.facets to false for a static collection lacking facets()', async () => {
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: { list: async () => [], count: async () => 0 },
      });
      expect(definition.schema.supports?.facets).toBe(false);
    });

    it('defaults supports.facets to true for a resolver-backed collection', async () => {
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: async () => ({
          list: async () => [],
          count: async () => 0,
        }),
      });
      expect(definition.schema.supports?.facets).toBe(true);
    });

    it('respects an explicit facets: false override for a static collection that has facets()', async () => {
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        facets: false,
        collection: fakeCollection([]),
      });
      expect(definition.schema.supports?.facets).toBe(false);
    });
  });

  describe('finding 6: schema override intersected with registry exclusions', () => {
    it('drops an override field the registry marks sensitive even without its own annotation', async () => {
      const rows = [
        { id: 'event-a', tenantId: 'tenant-a', internalNote: 'leak-me' },
      ];
      const hostileSchema: DataSurfaceSchema = {
        version: 1,
        identityField: 'id',
        fields: [
          { id: 'id', type: 'string', projectable: true },
          // No `sensitive`/`readPermission` on this override entry, unlike
          // the registry's own declaration for `internalNote`.
          { id: 'internalNote', type: 'string', projectable: true },
        ],
      };
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        schema: hostileSchema,
        collection: fakeCollection(rows),
      });
      expect(definition.schema.fields.map((field) => field.id)).toEqual(['id']);
      await expect(
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: 'r4',
            mode: 'rows',
            projection: ['id', 'internalNote'],
            page: { kind: 'offset', offset: 0, limit: 10 },
          },
          context('tenant-a'),
        ),
      ).rejects.toThrow(/internalNote/);
    });
  });

  describe('finding 7: deny-all application scope short-circuits', () => {
    it('returns an empty result without ever calling the collection', async () => {
      const list = vi.fn(async () => []);
      const count = vi.fn(async () => 0);
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection: { list, count },
        scope: () => [],
      });
      const result = await definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'r5',
          mode: 'rows',
          projection: ['id'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        context('tenant-a'),
      );
      expect(result).toMatchObject({
        rows: [],
        total: { kind: 'exact', value: 0 },
      });
      expect(list).not.toHaveBeenCalled();
      expect(count).not.toHaveBeenCalled();
    });
  });

  describe('finding 8: collection-side limit clamping is detected', () => {
    it('warns when the collection returns fewer rows than requested but more remain', async () => {
      const allRows = Array.from({ length: 10 }, (_, index) => ({
        id: `event-${index}`,
        tenantId: 'tenant-a',
        name: `Event ${index}`,
      }));
      const collection: SmrtCollectionQueryCollection = {
        async list({ offset = 0 }) {
          // Simulate a host collection with its own maxListLimit of 3,
          // regardless of the limit the adapter requested.
          return allRows.slice(offset, offset + 3);
        },
        async count() {
          return allRows.length;
        },
      };
      const definition = await createSmrtCollectionDataSurfaceDefinition({
        qualifiedName: QUALIFIED_NAME,
        collectionName: 'events',
        collection,
        scope: (execution) => ({ tenantId: execution.principal.tenantId }),
      });
      const result = await definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'r6',
          mode: 'rows',
          projection: ['id'],
          page: { kind: 'offset', offset: 0, limit: 10 },
        },
        context('tenant-a'),
      );
      // `page.limit` stays the nominal requested limit (the shared result
      // normalizer requires exact agreement with the request); `hasMore` is
      // still computed from the actual clamped row count, and the clamp is
      // surfaced as a warning instead.
      expect(result).toMatchObject({
        page: { kind: 'offset', limit: 10, hasMore: true },
        rows: [{ id: 'event-0' }, { id: 'event-1' }, { id: 'event-2' }],
      });
      expect(
        (result as { warnings: string[] }).warnings.some((warning) =>
          /fewer rows|maxListLimit|maximum list limit/i.test(warning),
        ),
      ).toBe(true);
    });
  });

  describe('DNF filter lowering (finding 11)', () => {
    async function whereFor(filter: unknown) {
      const rows = [{ id: 'event-a', tenantId: 'tenant-a', status: 'live' }];
      const collection = recordingCollection(rows);
      await withTenant({ tenantId: 'tenant-a' }, async () =>
        executeSmrtCollectionQuery(
          collection,
          {
            version: 1,
            requestId: 'w1',
            mode: 'rows',
            projection: ['id'],
            filter,
            page: { kind: 'offset', offset: 0, limit: 10 },
          },
          {
            schema: await buildDataQuerySchemaForClass(QUALIFIED_NAME, {
              exclude: [
                'cachedTotal',
                'context',
                'created_at',
                'slug',
                'updated_at',
              ],
            }),
            qualifiedName: QUALIFIED_NAME,
          },
        ),
      );
      return collection.listCalls[0];
    }

    it('lowers nested all/any/not to bounded DNF', async () => {
      const where = await whereFor({
        kind: 'all',
        filters: [
          {
            kind: 'any',
            filters: [
              {
                kind: 'condition',
                field: 'status',
                operator: 'eq',
                value: 'live',
              },
              {
                kind: 'condition',
                field: 'status',
                operator: 'eq',
                value: 'draft',
              },
            ],
          },
          {
            kind: 'not',
            filter: {
              kind: 'condition',
              field: 'name',
              operator: 'eq',
              value: 'excluded',
            },
          },
        ],
      });
      // `status` values are deduplicated and canonically sorted by the core
      // normalizer, and the `not`-branch is crossed against each of them.
      expect(where).toEqual([
        [{ tenantId: 'tenant-a' }, { name: null }, { status: 'draft' }],
        [{ tenantId: 'tenant-a' }, { name: null }, { status: 'live' }],
        [
          { tenantId: 'tenant-a' },
          { 'name !=': 'excluded' },
          { status: 'draft' },
        ],
        [
          { tenantId: 'tenant-a' },
          { 'name !=': 'excluded' },
          { status: 'live' },
        ],
      ]);
    });

    it('lowers a null-safe ne complement', async () => {
      const where = await whereFor({
        kind: 'condition',
        field: 'status',
        operator: 'ne',
        value: 'live',
      });
      expect(where).toEqual([
        [{ tenantId: 'tenant-a' }, { status: null }],
        [{ tenantId: 'tenant-a' }, { 'status !=': 'live' }],
      ]);
    });

    it('lowers notIn with a null value', async () => {
      const where = await whereFor({
        kind: 'condition',
        field: 'status',
        operator: 'notIn',
        value: ['live', 'draft', null],
      });
      // Values are deduplicated and canonically sorted; `null` sorts last.
      expect(where).toEqual([
        [
          { tenantId: 'tenant-a' },
          { 'status !=': 'draft' },
          { 'status !=': 'live' },
          { 'status !=': null },
        ],
      ]);
    });

    it('lowers notIn without a null value', async () => {
      const where = await whereFor({
        kind: 'condition',
        field: 'status',
        operator: 'notIn',
        value: ['live', 'draft'],
      });
      expect(where).toEqual([
        [{ tenantId: 'tenant-a' }, { status: null }],
        [
          { tenantId: 'tenant-a' },
          { 'status !=': 'draft' },
          { 'status !=': 'live' },
        ],
      ]);
    });

    it('lowers a negated range operator with the null-safe complement', async () => {
      const where = await whereFor({
        kind: 'not',
        filter: {
          kind: 'condition',
          field: 'status',
          operator: 'gt',
          value: 'm',
        },
      });
      expect(where).toEqual([
        [{ tenantId: 'tenant-a' }, { status: null }],
        [{ tenantId: 'tenant-a' }, { 'status <=': 'm' }],
      ]);
    });

    it('rejects a filter that expands beyond MAX_OR_BRANCHES', async () => {
      // Cross two 12-branch `any` groups via `all` (12 * 12 = 144 > 128):
      // each individual `any` stays under the normalizer's own 50-child cap,
      // so it's the adapter's cross-product bound that must reject this.
      const anyOf = (prefix: string) => ({
        kind: 'any' as const,
        filters: Array.from({ length: 12 }, (_, index) => ({
          kind: 'condition' as const,
          field: 'status',
          operator: 'eq' as const,
          value: `${prefix}-${index}`,
        })),
      });
      await expect(
        whereFor({ kind: 'all', filters: [anyOf('a'), anyOf('b')] }),
      ).rejects.toThrow(/OR branches/);
    });
  });
});
