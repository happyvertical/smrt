import type { DataQuerySchema } from '@happyvertical/smrt-types';
import { describe, expect, it, vi } from 'vitest';
import {
  createDataSurfaceTools,
  DATA_DISCOVER_TOOL_SLUG,
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceDeniedError,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';

const schema: DataQuerySchema = {
  version: 1,
  identityField: 'id',
  fields: [
    { id: 'id', type: 'string', projectable: true, sortable: true },
    { id: 'name', type: 'string', projectable: true, filterOperators: ['eq'] },
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
  defaultPageLimit: 1,
  maxPageLimit: 1,
  maxResultBytes: 10_000,
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
    expect(JSON.stringify(discover)).not.toContain('secret');
    expect(JSON.stringify(inspect)).not.toContain('restricted');
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
