import { createDataQueryFingerprint } from '@happyvertical/smrt-core';
import type { DataQuerySchema } from '@happyvertical/smrt-types';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import { describe, expect, it, vi } from 'vitest';
import type { DataSurfaceSchema } from './data-surface.js';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceDeniedError,
  DataSurfaceQueryError,
  DataSurfaceRequestError,
  DataSurfaceResultOrderError,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';

const schema: DataSurfaceSchema = {
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
      sensitive: true,
    },
    {
      id: 'restricted',
      type: 'string',
      projectable: true,
      readPermission: 'records.secret',
    },
  ],
  defaultPageLimit: 2,
  maxPageLimit: 2,
  maxResultBytes: 10_000,
  supports: { cursorPagination: true },
};

const querySchema: DataQuerySchema = {
  ...schema,
  fields: schema.fields.map(
    ({
      sensitive: _sensitive,
      readPermission: _readPermission,
      metadata: _metadata,
      ...field
    }) => field,
  ),
};

function wideSchema(): DataSurfaceSchema {
  return {
    ...schema,
    fields: [
      ...schema.fields,
      ...Array.from({ length: 50 }, (_, index) => ({
        id: `field-${index}`,
        type: 'string' as const,
        projectable: true,
      })),
    ],
  };
}

const versionedRequest = {
  version: 1 as const,
  requestId: 'versioned-result',
  mode: 'rows' as const,
  projection: ['id'],
};

function versionedResult(
  overrides: Partial<{
    requestId: string;
    queryFingerprint: string;
    identityField: string;
  }> = {},
) {
  return {
    version: 1 as const,
    requestId: versionedRequest.requestId,
    queryFingerprint: createDataQueryFingerprint(versionedRequest, querySchema),
    identityField: 'id',
    rows: [{ id: 'r1' }],
    total: { kind: 'unavailable' as const },
    freshness: { state: 'unknown' as const },
    warnings: [],
    truncated: false,
    ...overrides,
  };
}

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
      membership: null,
      postgresRls: false,
      session: null,
      sessionId: null,
      superAdminBypass: false,
      systemContext: false,
      user: null,
    } satisfies SessionPermissionRuntimeContext,
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

function fieldIds(value: unknown): string[] {
  if (!Array.isArray(value)) throw new Error('Expected surface list');
  const first = value[0];
  if (!first || typeof first !== 'object' || !('fields' in first)) {
    throw new Error('Expected surface descriptor');
  }
  const fields = first.fields;
  if (!Array.isArray(fields)) throw new Error('Expected field list');
  return fields.map((field) => {
    if (!field || typeof field !== 'object' || typeof field.id !== 'string') {
      throw new Error('Expected field descriptor');
    }
    return field.id;
  });
}

function rowIds(value: unknown): string[] {
  if (!value || typeof value !== 'object' || !('rows' in value)) {
    throw new Error('Expected query result');
  }
  const rows = value.rows;
  if (!Array.isArray(rows)) throw new Error('Expected row list');
  return rows.map((row) => {
    if (!row || typeof row !== 'object' || typeof row.id !== 'string') {
      throw new Error('Expected row identity');
    }
    return row.id;
  });
}

function rowFieldNames(value: unknown): string[][] {
  if (!value || typeof value !== 'object' || !('rows' in value)) {
    throw new Error('Expected query result');
  }
  const rows = value.rows;
  if (!Array.isArray(rows)) throw new Error('Expected row list');
  return rows.map((row) => {
    if (!row || typeof row !== 'object') throw new Error('Expected row');
    return Object.keys(row).sort();
  });
}

function resultHasMore(value: unknown): boolean {
  if (!value || typeof value !== 'object' || !('page' in value)) {
    throw new Error('Expected paginated result');
  }
  const page = value.page;
  if (!page || typeof page !== 'object' || typeof page.hasMore !== 'boolean') {
    throw new Error('Expected page metadata');
  }
  return page.hasMore;
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
    expect(fieldIds(discover)).toEqual(['id', 'name', 'rank']);
    expect(fieldIds([inspect])).toEqual(['id', 'name', 'rank']);
  });

  it('includes a restricted field only when its read permission is present', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => [{ id: 'r1', restricted: 'allowed' }],
    });
    const run = fakeRun(
      [DATA_DISCOVER_TOOL_SLUG, DATA_INSPECT_TOOL_SLUG, DATA_QUERY_TOOL_SLUG],
      ['records.read', 'records.secret'],
    );
    const discover = await tools.get(DATA_DISCOVER_TOOL_SLUG)?.execute({
      run,
      args: {},
      db: undefined,
    });
    expect(fieldIds(discover)).toEqual(['id', 'name', 'rank', 'restricted']);
    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: 'records',
        request: {
          version: 1,
          requestId: 'restricted-allowed',
          mode: 'rows',
          projection: ['id', 'restricted'],
        },
      },
      db: undefined,
    });
    expect(result).toMatchObject({
      rows: [{ id: 'r1', restricted: 'allowed' }],
    });
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
    ).rejects.toBeInstanceOf(DataSurfaceQueryError);
  });

  it('rejects oversized pages before reading or cloning adapter rows', async () => {
    let rowRead = false;
    const row: Record<string, unknown> = {};
    Object.defineProperty(row, 'id', {
      enumerable: true,
      get() {
        rowRead = true;
        throw new Error('row should not be read');
      },
    });
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => [row, row],
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          surfaceId: 'records',
          request: {
            version: 1,
            requestId: 'oversized-before-read',
            mode: 'rows',
            projection: ['id'],
            page: { kind: 'offset', offset: 0, limit: 1 },
          },
        },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceQueryError);
    expect(rowRead).toBe(false);
  });

  it('rejects versioned executor results with mismatched correlation fields', async () => {
    const mismatches = [
      versionedResult({ requestId: 'wrong-request' }),
      versionedResult({ queryFingerprint: 'wrong-fingerprint' }),
      versionedResult({ identityField: 'wrong-identity' }),
    ];
    for (const result of mismatches) {
      const tools = toolSet({
        surfaces: [{ id: 'records', collection: 'records', schema }],
        execute: async () => result,
      });
      const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
      await expect(
        tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
          run,
          args: {
            surfaceId: 'records',
            request: versionedRequest,
          },
          db: undefined,
        }),
      ).rejects.toBeInstanceOf(DataSurfaceQueryError);
    }
  });

  it('does not reveal hidden field names in caller request errors', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    await expect(
      tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
        run,
        args: {
          surfaceId: 'records',
          request: {
            version: 1,
            requestId: 'request-hidden',
            mode: 'rows',
            projection: ['id', 'secret'],
          },
        },
        db: undefined,
      }),
    ).rejects.toBeInstanceOf(DataSurfaceRequestError);
  });

  it('returns a stable public error while retaining detailed failure telemetry server-side', async () => {
    const failures: Array<{ error: unknown }> = [];
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      onFailure: async (entry) => {
        failures.push({ error: entry.error });
      },
      execute: async () => {
        throw new Error(
          'SQL failed for tenant tenant-b: secret row r-private is not visible',
        );
      },
    });
    const run = fakeRun(
      [DATA_QUERY_TOOL_SLUG],
      ['records.read'],
      'user-a',
      'tenant-b',
    );
    const execute = tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: 'records',
        request: {
          version: 1,
          requestId: 'failure-redaction',
          mode: 'rows',
          projection: ['id'],
        },
      },
      db: undefined,
    });
    await expect(execute).rejects.toMatchObject({
      code: 'DATA_SURFACE_QUERY_FAILED',
      message: 'Data surface query failed.',
    });
    await expect(execute).rejects.not.toThrow(/tenant-b|r-private|secret|SQL/);
    expect(failures).toHaveLength(1);
    expect(failures[0].error).toBeInstanceOf(Error);
    if (!(failures[0].error instanceof Error)) {
      throw new Error('Expected detailed error telemetry');
    }
    expect(failures[0].error.message).toContain('tenant-b');
  });

  it('preserves executor order for cursor pages and validates each page', async () => {
    let page = 0;
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async (_surface, request) => {
        page += 1;
        expect(request.page?.kind).toBe('cursor');
        expect(request.projection).toEqual(['id', 'rank']);
        return page === 1
          ? {
              rows: [
                { id: 'b', rank: 10 },
                { id: 'a', rank: 2 },
              ],
              nextCursor: 'page-2',
              truncated: true,
            }
          : {
              rows: [
                { id: 'd', rank: 8 },
                { id: 'c', rank: 4 },
              ],
            };
      },
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const request = (after?: string) => ({
      version: 1,
      requestId: after ? 'cursor-2' : 'cursor-1',
      mode: 'rows' as const,
      projection: ['id'],
      sort: [{ field: 'rank', direction: 'desc' as const }],
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
    expect(rowIds(first)).toEqual(['b', 'a']);
    expect(rowIds(second)).toEqual(['d', 'c']);
    expect(rowFieldNames(first)).toEqual([['id'], ['id']]);
    expect(rowFieldNames(second)).toEqual([['id'], ['id']]);
  });

  it('rejects a cursor page that is not in its requested canonical order', async () => {
    const tools = toolSet({
      surfaces: [{ id: 'records', collection: 'records', schema }],
      execute: async () => ({
        rows: [
          { id: 'a', rank: 1 },
          { id: 'b', rank: 2 },
        ],
      }),
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
            sort: [{ field: 'rank', direction: 'desc' }],
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
          ? {
              rows: [
                { id: 'b', rank: 10 },
                { id: 'a', rank: 2 },
              ],
              hasMore: true,
            }
          : {
              rows: [
                { id: 'd', rank: 8 },
                { id: 'c', rank: 4 },
              ],
            };
      },
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const request = (offset: number) => ({
      version: 1,
      requestId: `offset-${offset}`,
      mode: 'rows' as const,
      projection: ['id'],
      sort: [{ field: 'rank', direction: 'desc' as const }],
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
    expect(rowIds(first)).toEqual(['b', 'a']);
    expect(resultHasMore(first)).toBe(true);
    expect(rowIds(second)).toEqual(['d', 'c']);
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

  it('accepts fifty requested fields plus the identity field internally', async () => {
    const fields = [
      'rank',
      ...Array.from({ length: 49 }, (_, index) => `field-${index}`),
    ];
    let executorProjection: string[] | undefined;
    const tools = toolSet({
      surfaces: [
        { id: 'records', collection: 'records', schema: wideSchema() },
      ],
      execute: async (_surface, request) => {
        executorProjection = request.projection;
        return [{ id: 'r1', rank: 1 }];
      },
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: 'records',
        request: {
          version: 1,
          requestId: 'wide-projection',
          mode: 'rows',
          projection: fields,
          sort: [{ field: 'rank', direction: 'asc' }],
        },
      },
      db: undefined,
    });
    expect(executorProjection).toHaveLength(51);
    expect(executorProjection).toEqual(
      expect.arrayContaining(['id', 'rank', 'field-0']),
    );
    expect(rowFieldNames(result)).toEqual([['id', 'rank']]);
  });

  it('allows sort-key expansion beyond fifty requested projection fields', async () => {
    const fields = Array.from({ length: 50 }, (_, index) => `field-${index}`);
    let executorProjection: string[] | undefined;
    const tools = toolSet({
      surfaces: [
        { id: 'records', collection: 'records', schema: wideSchema() },
      ],
      execute: async (_surface, request) => {
        executorProjection = request.projection;
        return [{ id: 'r1', rank: 1 }];
      },
    });
    const run = fakeRun([DATA_QUERY_TOOL_SLUG]);
    const result = await tools.get(DATA_QUERY_TOOL_SLUG)?.execute({
      run,
      args: {
        surfaceId: 'records',
        request: {
          version: 1,
          requestId: 'wide-sort-expansion',
          mode: 'rows',
          projection: fields,
          sort: [{ field: 'rank', direction: 'asc' }],
        },
      },
      db: undefined,
    });
    expect(executorProjection).toHaveLength(52);
    expect(executorProjection).toEqual(
      expect.arrayContaining(['id', 'rank', 'field-0']),
    );
    expect(rowFieldNames(result)).toEqual([['id']]);
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
