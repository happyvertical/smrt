import type {
  DataSurfaceExecutionContext,
  DataSurfaceSchema,
} from '@happyvertical/smrt-agents';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
} from '@happyvertical/smrt-agents';
import { describe, expect, it, vi } from 'vitest';
import type { ContentQueryCollection } from '../content-query.js';
import {
  CONTENT_LIST_DATA_SURFACE_COLLECTION,
  CONTENT_LIST_DATA_SURFACE_ID,
  createContentListDataSurfaceDefinition,
} from './content-list-data-surface.js';

const schema: DataSurfaceSchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', projectable: true, sortable: true },
    {
      id: 'title',
      type: 'string',
      projectable: true,
      sortable: true,
      facetable: true,
      filterOperators: ['eq', 'like'],
    },
    {
      id: 'tenant_id',
      type: 'string',
      projectable: true,
      filterOperators: ['eq'],
      sensitive: true,
    },
    {
      id: 'audit_note',
      type: 'string',
      projectable: true,
      sortable: true,
      facetable: true,
      filterOperators: ['eq'],
      readPermission: 'contents.audit.read',
    },
  ],
  defaultPageLimit: 1,
  maxPageLimit: 2,
  maxResultBytes: 10_000,
  supports: { cursorPagination: false, consistency: false, facets: true },
};

function context(
  tenantId = 'tenant-a',
  permissions: readonly string[] | undefined = [],
): DataSurfaceExecutionContext {
  const run: Record<string, unknown> = {
    context: { userId: 'user-a', tenantId },
  };
  if (permissions !== undefined) run.permissions = [...permissions];
  return {
    run: run as DataSurfaceExecutionContext['run'],
    principal: { userId: 'user-a', tenantId },
    signal: new AbortController().signal,
  };
}

function principalRun(
  tenantId: string,
  permissions: string[] = ['contents.read'],
): DataSurfaceExecutionContext['run'] {
  const allowedTools = [DATA_DISCOVER_TOOL_SLUG, DATA_QUERY_TOOL_SLUG];
  return {
    context: { userId: 'user-a', tenantId },
    permissions,
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation(collection, action) {
      if (collection !== 'contents' || action !== 'read') {
        throw new Error('rbac denied');
      }
      return {
        allowed: true,
        permission: 'contents.read',
        reason: 'permission_granted',
      };
    },
  } as DataSurfaceExecutionContext['run'];
}

describe('ContentList agent data surface', () => {
  it('publishes one bounded catalog schema and resolves reads from the live principal', async () => {
    const list = vi.fn(async () => [
      { id: 'content-a', title: 'Alpha', tenant_id: 'tenant-a' },
    ]);
    const count = vi.fn(async () => 1);
    const facets = vi.fn(async () => [
      { field: 'title', values: [{ value: 'Alpha', count: 1 }] },
    ]);
    const collection: ContentQueryCollection = { list, count, facets };
    const definition = await createContentListDataSurfaceDefinition({
      schema,
      collection: async (execution) => {
        expect(execution.principal).toEqual({
          userId: 'user-a',
          tenantId: 'tenant-a',
        });
        return collection;
      },
      scope: async (execution) => ({
        tenant_id: execution.principal.tenantId,
      }),
    });

    expect(definition).toMatchObject({
      id: CONTENT_LIST_DATA_SURFACE_ID,
      collection: CONTENT_LIST_DATA_SURFACE_COLLECTION,
      className: '@happyvertical/smrt-content:Content',
      metadata: {
        adapter: 'ContentList',
        queryModes: ['rows', 'count', 'facets'],
      },
    });
    expect(definition.schema.fields.map((field) => field.id)).toEqual([
      'id',
      'title',
    ]);

    const result = await definition.execute?.(
      definition,
      {
        version: 1,
        requestId: 'projected-page',
        mode: 'rows',
        projection: ['id', 'title'],
        page: { kind: 'offset', offset: 0, limit: 1 },
      },
      context(),
    );

    expect(result).toMatchObject({
      rows: [{ id: 'content-a', title: 'Alpha' }],
      total: { kind: 'exact', value: 1 },
      page: { kind: 'offset', offset: 0, limit: 1, hasMore: false },
    });
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({
        select: ['id', 'title'],
        limit: 1,
        where: [[{ tenant_id: 'tenant-a' }]],
      }),
    );
  });

  it('fails factory configuration before exposing an unusable surface', async () => {
    const collection: ContentQueryCollection = {
      list: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      facets: vi.fn(async () => []),
    };
    await expect(
      createContentListDataSurfaceDefinition({
        id: ' ',
        schema,
        collection,
      }),
    ).rejects.toThrow('ContentList data surface id must be a non-empty string');
  });

  it('redacts tenancy from discovery and resolves a silent query under the current tenant', async () => {
    const list = vi.fn(async (query: { where?: unknown }) => {
      const tenant = JSON.stringify(query.where).includes('tenant-b')
        ? 'tenant-b'
        : 'tenant-a';
      return [{ id: `${tenant}-content`, title: tenant, tenant_id: tenant }];
    });
    const definition = await createContentListDataSurfaceDefinition({
      schema,
      collection: {
        list,
        count: vi.fn(async () => 1),
        facets: vi.fn(async () => []),
      },
      scope: (execution) => ({ tenant_id: execution.principal.tenantId }),
    });
    const tools = new Map(
      createDataSurfaceTools({ surfaces: [definition] }).map((tool) => [
        tool.slug,
        tool,
      ]),
    );
    const run = principalRun('tenant-b');

    const discover = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    expect(discover).toMatchObject([{ id: CONTENT_LIST_DATA_SURFACE_ID }]);
    expect(JSON.stringify(discover)).not.toContain('tenant_id');

    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: CONTENT_LIST_DATA_SURFACE_ID,
        request: {
          version: 1,
          requestId: 'tenant-b-read',
          mode: 'rows',
          projection: ['id', 'title'],
          page: { kind: 'offset', offset: 0, limit: 1 },
        },
      },
      db: undefined,
    });

    expect(result).toMatchObject({
      rows: [{ id: 'tenant-b-content', title: 'tenant-b' }],
    });
    expect(JSON.stringify(result)).not.toContain('tenant_id');
    expect(list).toHaveBeenLastCalledWith(
      expect.objectContaining({ where: [[{ tenant_id: 'tenant-b' }]] }),
    );
  });

  it('rejects a protected host-schema projection before resolving the collection', async () => {
    const collection = vi.fn<
      (execution: DataSurfaceExecutionContext) => ContentQueryCollection
    >(() => ({
      list: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      facets: vi.fn(async () => []),
    }));
    const definition = await createContentListDataSurfaceDefinition({
      schema,
      collection,
    });

    for (const protectedField of ['tenant_id', 'audit_note']) {
      await expect(
        definition.execute?.(
          definition,
          {
            version: 1,
            requestId: `hostile-${protectedField}-projection`,
            mode: 'rows',
            projection: ['id', protectedField],
            page: { kind: 'offset', offset: 0, limit: 1 },
          },
          context(),
        ),
      ).rejects.toThrow(
        new RegExp(`projection field is not allowed: ${protectedField}`),
      );
    }
    expect(collection).not.toHaveBeenCalled();
  });

  it('treats a missing permission list as no permission before resolving the collection', async () => {
    const collection = vi.fn<
      (execution: DataSurfaceExecutionContext) => ContentQueryCollection
    >(() => ({
      list: vi.fn(async () => []),
      count: vi.fn(async () => 0),
      facets: vi.fn(async () => []),
    }));
    const definition = await createContentListDataSurfaceDefinition({
      schema,
      collection,
    });

    await expect(
      definition.execute?.(
        definition,
        {
          version: 1,
          requestId: 'missing-permission-audit-projection',
          mode: 'rows',
          projection: ['id', 'audit_note'],
          page: { kind: 'offset', offset: 0, limit: 1 },
        },
        context('tenant-a', undefined),
      ),
    ).rejects.toThrow(/projection field is not allowed: audit_note/);
    expect(collection).not.toHaveBeenCalled();
  });

  it('never advertises a read-permission field that collection projections cannot execute', async () => {
    const list = vi.fn(async () => [{ id: 'content-a', title: 'Alpha' }]);
    const facets = vi.fn(async () => []);
    const definition = await createContentListDataSurfaceDefinition({
      schema,
      collection: { list, count: vi.fn(async () => 1), facets },
    });
    const tools = new Map(
      createDataSurfaceTools({ surfaces: [definition] }).map((tool) => [
        tool.slug,
        tool,
      ]),
    );
    const run = principalRun('tenant-a', [
      'contents.read',
      'contents.audit.read',
    ]);

    const discover = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    const fields = (
      discover as Array<{ fields: Array<{ id: string }> }>
    )[0].fields.map((field) => field.id);
    expect(fields).toEqual(['id', 'title']);

    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          surfaceId: CONTENT_LIST_DATA_SURFACE_ID,
          request: {
            version: 1,
            requestId: 'authorized-but-unprojectable-audit-field',
            mode: 'rows',
            projection: ['id', 'audit_note'],
            page: { kind: 'offset', offset: 0, limit: 1 },
          },
        },
        db: undefined,
      }),
    ).rejects.toThrow('Data surface query request is invalid.');
    expect(list).not.toHaveBeenCalled();
    expect(facets).not.toHaveBeenCalled();
  });
});
