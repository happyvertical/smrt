import type { DataQuerySchema } from '@happyvertical/smrt-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceDeniedError,
  DataSurfaceResultOrderError,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';

const schema: DataQuerySchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', projectable: true, sortable: true },
    { id: 'name', type: 'string', projectable: true, filterOperators: ['eq'] },
    { id: 'rank', type: 'number', projectable: true, sortable: true },
    // These extensions are intentionally stripped from descriptors/results.
    {
      id: 'secret',
      type: 'string',
      projectable: true,
      ...({ sensitive: true } as unknown as {}),
    },
    {
      id: 'restricted',
      type: 'string',
      projectable: true,
      ...({ readPermission: 'records.secret' } as unknown as {}),
    },
  ],
  defaultPageLimit: 2,
  maxPageLimit: 2,
  maxResultBytes: 10_000,
  supports: { cursorPagination: true },
};

function fakeRun(
  allowedTools: string[],
  permissions: string[] = ['records.read'],
  userId = 'delegated-user',
  tenantId: string | null = 'tenant-a',
): PrincipalRun {
  return {
    context: {
      userId,
      tenantId,
      database: undefined,
      permissions,
      permissionSet: new Set(permissions),
    } as PrincipalRun['context'],
    permissions,
    allowedTools,
    isToolAllowed: (tool) => allowedTools.includes(tool),
    assertToolAllowed(tool) {
      if (!allowedTools.includes(tool)) throw new Error(`denied:${tool}`);
    },
    async assertOperation(collection, action) {
      if (collection !== 'records' || action !== 'read') {
        throw new Error('rbac denied');
      }
      return {
        allowed: true,
        permission: 'records.read',
        reason: 'permission_granted',
      };
    },
  };
}

function toolSet(options: Parameters<typeof createDataSurfaceTools>[0]) {
  return new Map(
    createDataSurfaceTools(options).map((tool) => [tool.slug, tool]),
  );
}

describe('principal-bound data surface tools', () => {
  it('offers no usable read tool when the allow-list is empty', async () => {
    const tools = toolSet({ surfaces: [] });
    const run = fakeRun([]);
    await expect(
      tools
        .get(DATA_DISCOVER_TOOL_SLUG)
        ?.execute({ run, args: {}, db: undefined }),
    ).rejects.toThrow();
  });

  it('hides RBAC-denied surfaces instead of revealing their descriptors', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'other', schema }],
    });
    const run = fakeRun([DATA_DISCOVER_TOOL_SLUG]);
    const result = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    expect(result).toEqual([]);
  });

  it('redacts sensitive and permissioned fields from discovery and inspection', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
    });
    const run = fakeRun([DATA_DISCOVER_TOOL_SLUG, DATA_INSPECT_TOOL_SLUG]);
    const discover = await tools
      .get(DATA_DISCOVER_TOOL_SLUG)
      ?.execute({ run, args: {}, db: undefined });
    const inspect = await tools.get(DATA_INSPECT_TOOL_SLUG)?.execute({
      run,
      args: { surfaceId: 'records' },
      db: undefined,
    });
    expect(
      (discover as Array<{ fields: Array<{ id: string }> }>)[0].fields.map(
        (field) => field.id,
      ),
    ).toEqual(['id', 'name', 'rank']);
    expect(
      (inspect as { fields: Array<{ id: string }> }).fields.map(
        (field) => field.id,
      ),
    ).toEqual(['id', 'name', 'rank']);
  });

  it('passes the authenticated delegated principal and tenant to the executor', async () => {
    const seen: unknown[] = [];
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async (_surface, request, context) => {
        seen.push(context.principal);
        return [{ id: 'r1', name: 'one' }];
      },
    });
    const run = fakeRun(
      [DATA_QUERY_TOOL_SLUG],
      ['records.read'],
      'originating-user',
      'tenant-b',
    );
    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: 'records',
        request: {
          version: 1,
          requestId: 'req-1',
          mode: 'rows',
          projection: ['id', 'name'],
          page: { kind: 'offset', offset: 0, limit: 1 },
        },
      },
      db: undefined,
    });
    expect(seen).toEqual([
      { userId: 'originating-user', tenantId: 'tenant-b' },
    ]);
    expect(result).toMatchObject({
      rows: [{ id: 'r1', name: 'one' }],
      truncated: false,
    });
  });

  it('rejects an executor result that exceeds the requested page limit', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => [
        { id: 'r1', name: 'one' },
        { id: 'r2', name: 'two' },
      ],
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          surfaceId: 'records',
          request: {
            version: 1,
            requestId: 'req-2',
            mode: 'rows',
            projection: ['id', 'name'],
            page: { kind: 'offset', offset: 0, limit: 1 },
          },
        },
        db: undefined,
      }),
    ).rejects.toThrow();
  });

  it('rejects hidden or restricted fields crossing the query result boundary', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => [
        { id: 'r1', name: 'one', secret: 'do-not-return', restricted: 'nope' },
      ],
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          surfaceId: 'records',
          request: {
            version: 1,
            requestId: 'req-hidden',
            mode: 'rows',
            projection: ['id', 'name'],
            page: { kind: 'offset', offset: 0, limit: 1 },
          },
        },
        db: undefined,
      }),
    ).rejects.toThrow();
  });

  it('preserves executor order for cursor pages and validates each page', async () => {
    let page = 0;
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async (_surface, request) => {
        page += 1;
        expect(request.page?.kind).toBe('cursor');
        return page === 1
          ? {
              rows: [{ id: 'b' }, { id: 'a' }],
              nextCursor: 'page-2',
              truncated: true,
            }
          : { rows: [{ id: 'd' }, { id: 'c' }] };
      },
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const request = (after?: string) => ({
      version: 1,
      requestId: after ? 'cursor-2' : 'cursor-1',
      mode: 'rows' as const,
      projection: ['id'],
      sort: [{ field: 'id', direction: 'desc' as const }],
      page: { kind: 'cursor' as const, ...(after ? { after } : {}), limit: 2 },
    });
    const first = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: { surfaceId: 'records', request: request() },
      db: undefined,
    });
    const second = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: { surfaceId: 'records', request: request('page-2') },
      db: undefined,
    });
    expect((first as { rows: Array<{ id: string }> }).rows).toEqual([
      { id: 'b' },
      { id: 'a' },
    ]);
    expect((second as { rows: Array<{ id: string }> }).rows).toEqual([
      { id: 'd' },
      { id: 'c' },
    ]);
  });

  it('rejects a cursor page that is not in its requested canonical order', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => ({ rows: [{ id: 'a' }, { id: 'b' }] }),
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          surfaceId: 'records',
          request: {
            version: 1,
            requestId: 'cursor-invalid',
            mode: 'rows',
            projection: ['id'],
            sort: [{ field: 'id', direction: 'desc' }],
            page: { kind: 'cursor', limit: 2 },
          },
        },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceResultOrderError);
  });

  it('preserves executor order for multiple offset pages', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async (_surface, request) => {
        expect(request.page?.kind).toBe('offset');
        return request.page?.kind === 'offset' && request.page.offset === 0
          ? { rows: [{ id: 'b' }, { id: 'a' }], hasMore: true }
          : { rows: [{ id: 'd' }, { id: 'c' }] };
      },
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const request = (offset: number) => ({
      version: 1,
      requestId: `offset-${offset}`,
      mode: 'rows' as const,
      projection: ['id'],
      sort: [{ field: 'id', direction: 'desc' as const }],
      page: { kind: 'offset' as const, offset, limit: 2 },
    });
    const first = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: { surfaceId: 'records', request: request(0) },
      db: undefined,
    });
    const second = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: { surfaceId: 'records', request: request(2) },
      db: undefined,
    });
    expect((first as { rows: Array<{ id: string }> }).rows).toEqual([
      { id: 'b' },
      { id: 'a' },
    ]);
    expect((first as { page: { hasMore: boolean } }).page.hasMore).toBe(true);
    expect((second as { rows: Array<{ id: string }> }).rows).toEqual([
      { id: 'd' },
      { id: 'c' },
    ]);
  });

  it('validates numeric sort order numerically rather than lexically', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => ({
        rows: [
          { id: 'r2', rank: 2 },
          { id: 'r10', rank: 10 },
        ],
      }),
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: 'records',
        request: {
          version: 1,
          requestId: 'numeric-order',
          mode: 'rows',
          projection: ['id', 'rank'],
          sort: [{ field: 'rank', direction: 'asc' }],
        },
      },
      db: undefined,
    });
    expect(result).toMatchObject({
      rows: [
        { id: 'r2', rank: 2 },
        { id: 'r10', rank: 10 },
      ],
    });
  });

  it('does not let a caller select an unauthorized surface by changing args', async () => {
    const execute = vi.fn(async () => [{ id: 'r1', name: 'one' }]);
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute,
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: { surfaceId: 'other-tenant-records', request: {} },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    expect(execute).not.toHaveBeenCalled();
  });
});
