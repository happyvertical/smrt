/**
 * `data.query` as an agent writes it: envelope defaults, an argument schema
 * that states the request grammar, and request errors that say what was wrong
 * and what is allowed — without revealing hidden fields.
 */
import { DataQueryValidationError } from '@happyvertical/smrt-core';
import type { DataQueryRequest } from '@happyvertical/smrt-types';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import { describe, expect, it, vi } from 'vitest';
import type { DataSurfaceSchema } from './data-surface.js';
import {
  createDataSurfaceTools,
  DATA_QUERY_TOOL_PARAMETERS,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceRequestError,
} from './data-surface.js';
import type { PrincipalRun } from './execute-as-principal.js';

const schema: DataSurfaceSchema = {
  version: 1,
  identityField: 'id',
  fields: [
    {
      id: 'id',
      type: 'string',
      projectable: true,
      sortable: true,
      filterOperators: ['eq', 'in'],
    },
    {
      id: 'status',
      type: 'string',
      projectable: true,
      facetable: true,
      filterOperators: ['eq', 'ne'],
    },
    { id: 'updatedAt', type: 'datetime', projectable: true, sortable: true },
    {
      id: 'secret',
      type: 'string',
      projectable: true,
      sortable: true,
      filterOperators: ['eq'],
      sensitive: true,
    },
    {
      id: 'restricted',
      type: 'string',
      projectable: true,
      filterOperators: ['eq'],
      readPermission: 'records.secret',
    },
  ],
  defaultPageLimit: 5,
  maxPageLimit: 5,
  supports: { facets: true },
};

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
    allowedTools: [DATA_QUERY_TOOL_SLUG],
    isToolAllowed: (tool) => tool === DATA_QUERY_TOOL_SLUG,
    assertToolAllowed(tool) {
      if (tool !== DATA_QUERY_TOOL_SLUG) throw new Error(`denied:${tool}`);
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

function queryTool(
  options: Partial<Parameters<typeof createDataSurfaceTools>[0]> = {},
) {
  const tool = createDataSurfaceTools({
    surfaces: [{ id: 'records', collection: 'records', schema }],
    execute: async () => ({ rows: [], total: { kind: 'exact', value: 0 } }),
    ...options,
  }).find((candidate) => candidate.slug === DATA_QUERY_TOOL_SLUG);
  if (!tool) throw new Error('data.query missing');
  return (args: Record<string, unknown>) =>
    tool.execute({ run: fakeRun(), args, db: undefined });
}

async function requestError(
  run: Promise<unknown>,
): Promise<DataSurfaceRequestError> {
  try {
    await run;
  } catch (error) {
    expect(error).toBeInstanceOf(DataSurfaceRequestError);
    return error as DataSurfaceRequestError;
  }
  throw new Error('expected a request error');
}

describe('data.query argument schema', () => {
  it('states the request grammar instead of an opaque object', () => {
    const request = (
      DATA_QUERY_TOOL_PARAMETERS.properties as Record<string, any>
    ).request;
    expect(request.additionalProperties).toBe(false);
    expect(request.properties.mode.enum).toEqual(['rows', 'count', 'facets']);
    expect(request.properties.filter.properties.operator.enum).toEqual(
      expect.arrayContaining(['eq', 'in', 'like']),
    );
    expect(request.properties.sort.items.properties.direction.enum).toEqual([
      'asc',
      'desc',
    ]);
    expect(request.properties.page.properties.kind.enum).toEqual([
      'offset',
      'cursor',
    ]);
  });
});

describe('data.query envelope defaults', () => {
  it('fills version, requestId, mode and the offset page for a model-shaped request', async () => {
    const execute = vi.fn(
      async (_surface: unknown, request: DataQueryRequest) => {
        expect(request.version).toBe(1);
        expect(request.requestId).toMatch(/^dq_/);
        expect(request.mode).toBe('rows');
        expect(request.page).toEqual({ kind: 'offset', offset: 0, limit: 3 });
        return { rows: [], total: { kind: 'exact' as const, value: 0 } };
      },
    );
    const result = await queryTool({ execute })({
      surfaceId: 'records',
      request: {
        filter: {
          kind: 'condition',
          field: 'status',
          operator: 'eq',
          value: 'published',
        },
        page: { limit: 3 },
      },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ rows: [] });
  });

  it('accepts a flat call with the request keys beside surfaceId', async () => {
    await expect(
      queryTool()({ surfaceId: 'records', mode: 'count' }),
    ).resolves.toMatchObject({ total: { kind: 'exact', value: 0 } });
  });
});

describe('data.query request errors', () => {
  it('names the filterable fields for an unknown or hidden filter field, never the hidden ones', async () => {
    for (const field of ['published_at', 'secret', 'restricted']) {
      const error = await requestError(
        queryTool()({
          surfaceId: 'records',
          request: {
            mode: 'count',
            filter: { kind: 'condition', field, operator: 'eq', value: 'x' },
          },
        }),
      );
      expect(error.status).toBe(400);
      expect(error.reason).toBe('DATA_QUERY_FIELD_NOT_ALLOWED');
      expect(error.message).toContain('Filterable fields: id, status.');
      expect(error.message.replace(field, '')).not.toMatch(/secret|restricted/);
    }
  });

  it('gives a hidden field exactly the message a missing field gets', async () => {
    const message = async (field: string) =>
      (
        await requestError(
          queryTool()({
            surfaceId: 'records',
            request: { mode: 'rows', sort: [{ field, direction: 'asc' }] },
          }),
        )
      ).message.replace(field, '<field>');
    expect(await message('secret')).toBe(await message('nope'));
  });

  it('lists the allowed operators for a disallowed one', async () => {
    const error = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: {
          mode: 'count',
          filter: {
            kind: 'all',
            filters: [
              {
                kind: 'condition',
                field: 'status',
                operator: 'contains',
                value: 'x',
              },
            ],
          },
        },
      }),
    );
    expect(error.message).toContain('Allowed operators for status: eq, ne.');
  });

  it('lists sortable and facetable fields', async () => {
    const sort = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: { sort: [{ field: 'status', direction: 'desc' }] },
      }),
    );
    expect(sort.message).toContain('Sortable fields: id, updatedAt.');
    const facet = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: { mode: 'facets', facets: [{ field: 'id', limit: 5 }] },
      }),
    );
    expect(facet.message).toContain('Facetable fields: status.');
  });

  it('appends the request grammar to a structural error', async () => {
    const error = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: { mode: 'rows', limit: 5, filter: { status: 'published' } },
      }),
    );
    expect(error.message).toContain('unsupported key "limit"');
    expect(error.message).toContain('Request shape:');
    expect(error.message).toContain('data.inspect');
  });

  it('passes an adapter refusal of the request through as a 400, not a failed query', async () => {
    const onFailure = vi.fn();
    const error = await requestError(
      queryTool({
        onFailure,
        execute: async () => {
          throw new DataQueryValidationError(
            'Data query value for id must be a complete id',
            'DATA_QUERY_VALUE_INVALID',
          );
        },
      })({
        surfaceId: 'records',
        request: {
          mode: 'count',
          filter: {
            kind: 'condition',
            field: 'id',
            operator: 'eq',
            value: 'abc',
          },
        },
      }),
    );
    expect(error.message).toBe('Data query value for id must be a complete id');
    expect(error.reason).toBe('DATA_QUERY_VALUE_INVALID');
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('still hides an adapter result error behind the stable query failure', async () => {
    const onFailure = vi.fn();
    const run = queryTool({
      onFailure,
      execute: async () => {
        throw new DataQueryValidationError(
          'Data query row returned a non-projected field: secret',
          'DATA_QUERY_RESULT_NOT_ALLOWED',
        );
      },
    })({ surfaceId: 'records', request: { mode: 'count' } });
    await expect(run).rejects.toMatchObject({
      code: 'DATA_SURFACE_QUERY_FAILED',
      message: 'Data surface query failed.',
    });
    expect(onFailure).toHaveBeenCalledOnce();
  });
});
