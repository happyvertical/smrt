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
  DATA_INSPECT_TOOL_SLUG,
  DATA_QUERY_TOOL_PARAMETERS,
  DATA_QUERY_TOOL_SLUG,
  DataSurfaceDeniedError,
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

describe('data.query surfaceId placement (#4378)', () => {
  const count = {
    mode: 'count',
    filter: {
      kind: 'condition',
      field: 'id',
      operator: 'in',
      value: ['a'],
    },
  };
  function capture() {
    const seen: DataQueryRequest[] = [];
    const run = queryTool({
      execute: async (_surface: unknown, request: DataQueryRequest) => {
        seen.push(request);
        return { rows: [], total: { kind: 'exact' as const, value: 4 } };
      },
    });
    return { run, seen };
  }

  it('lifts a surfaceId nested in request to the top level', async () => {
    const { run, seen } = capture();
    await expect(
      run({ request: { ...count, surfaceId: 'records' } }),
    ).resolves.toMatchObject({ total: { value: 4 } });
    expect(seen[0]?.filter).toEqual(count.filter);
    expect(seen[0]).not.toHaveProperty('surfaceId');
  });

  it('accepts the same id at both levels, and unwraps a query wrapper', async () => {
    const { run, seen } = capture();
    await run({
      surfaceId: 'records',
      request: { ...count, surfaceId: 'records' },
    });
    await run({ request: { query: { ...count, surfaceId: 'records' } } });
    await run({ surfaceId: 'records', request: { query: count } });
    await run({ surfaceId: 'records', query: count });
    expect(seen).toHaveLength(4);
    for (const request of seen) {
      expect(request.mode).toBe('count');
      expect(request.filter).toEqual(count.filter);
    }
  });

  it('rejects two different ids as a request error, never echoing them', async () => {
    const error = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: { ...count, surfaceId: 'other-secret-id' },
      }),
    );
    expect(error.reason).toBe('DATA_QUERY_SURFACE_ID_CONFLICT');
    expect(error.message).not.toContain('other-secret-id');
    expect(error.message).toContain('at the top level, next to request');
  });

  it('rejects a missing surfaceId as a 400 with an example, not a denial', async () => {
    for (const args of [
      { request: count },
      { surfaceId: 7, request: count },
      { request: { ...count, surfaceId: 3 } },
    ]) {
      const error = await requestError(queryTool()(args));
      expect(error.status).toBe(400);
      expect(error.reason).toBe('DATA_QUERY_SURFACE_ID_REQUIRED');
      expect(error.message).toContain(
        'surfaceId is required at the top level, next to request',
      );
      expect(error.message).toContain(
        'Valid example: {"surfaceId":"<surface id from data.discover>","request":{"mode":"count"',
      );
    }
  });

  it('keeps the generic denial for an unknown surface id', async () => {
    await expect(
      queryTool()({ surfaceId: 'unknown', request: count }),
    ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
    await expect(
      queryTool()({ request: { ...count, surfaceId: 'unknown' } }),
    ).rejects.toBeInstanceOf(DataSurfaceDeniedError);
  });

  it('applies the same placement to data.inspect', async () => {
    const inspect = createDataSurfaceTools({
      surfaces: [{ id: 'records', collection: 'records', schema }],
    }).find((candidate) => candidate.slug === DATA_INSPECT_TOOL_SLUG);
    const run = fakeRun();
    run.assertToolAllowed = () => {};
    const call = (args: Record<string, unknown>) =>
      inspect?.execute({ run, args, db: undefined });
    await expect(
      call({ request: { surfaceId: 'records' } }),
    ).resolves.toMatchObject({ id: 'records' });
    const error = await requestError(call({}) as Promise<unknown>);
    expect(error.reason).toBe('DATA_QUERY_SURFACE_ID_REQUIRED');
    expect(error.message).toContain(
      'Valid example: {"surfaceId":"<surface id from data.discover>"}',
    );
  });

  it('explains a filter kind that is really an operator or a logical word', async () => {
    const inKind = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: {
          mode: 'count',
          filter: { kind: 'in', field: 'status', value: ['a'] },
        },
      }),
    );
    expect(inKind.message).toContain(
      'A filter kind is condition, all, any or not. in is an operator: use {"kind":"condition","field":f,"operator":"in","value":v}.',
    );
    const orKind = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: { mode: 'count', filter: { kind: 'or', filters: [] } },
      }),
    );
    expect(orKind.message).toContain(
      'For OR use {"kind":"any","filters":[...]}',
    );
  });
});

describe('data.query request errors', () => {
  it('appends a one-line valid example in the failed request mode, never the caller values (#4378)', async () => {
    const shapes: Array<[Record<string, unknown>, string]> = [
      [
        { mode: 'count', filter: { kind: 'or', filters: [] } },
        '{"mode":"count","filter":{"kind":"condition","field":"id","operator":"in"',
      ],
      [{ mode: 'count', page: { limit: 3 } }, '{"mode":"count","filter":'],
      [
        {
          mode: 'rows',
          filter: {
            kind: 'condition',
            field: 'status',
            operator: 'in',
            value: 'caller-secret-value',
          },
        },
        '{"mode":"rows","projection":["id"],"filter":',
      ],
      [
        { mode: 'facets', facets: [{ field: 'nope', limit: 3 }] },
        '{"mode":"facets","facets":[{"field":"status","limit":10}]}',
      ],
    ];
    for (const [request, expected] of shapes) {
      const error = await requestError(
        queryTool()({ surfaceId: 'records', request }),
      );
      expect(error.message).toContain(
        `Valid example: {"surfaceId":"records","request":${expected}`,
      );
      expect(error.message).not.toContain('caller-secret-value');
      expect(error.message).not.toMatch(/secret"|restricted/);
    }
  });

  it('rejects a filter placed beside request instead of dropping it (#4378)', async () => {
    const execute = vi.fn(async () => ({
      rows: [],
      total: { kind: 'exact' as const, value: 10 },
    }));
    const error = await requestError(
      queryTool({ execute })({
        surfaceId: 'records',
        request: { mode: 'count' },
        filter: {
          kind: 'condition',
          field: 'status',
          operator: 'eq',
          value: 'open-secret-value',
        },
      }),
    );
    expect(execute).not.toHaveBeenCalled();
    expect(error.status).toBe(400);
    expect(error.reason).toBe('DATA_QUERY_ARGUMENTS_UNEXPECTED');
    expect(error.message).toContain('move filter inside request');
    expect(error.message).toContain(
      'Valid example: {"surfaceId":"records","request":{"mode":"count","filter":{"kind":"condition","field":"id","operator":"in","value":["<value>","<value>"]}}}',
    );
    // Value-free: the model's argument values never come back.
    expect(error.message).not.toContain('open-secret-value');
  });

  it('rejects an unknown sibling key without echoing its name', async () => {
    const error = await requestError(
      queryTool()({
        surfaceId: 'records',
        request: { mode: 'count' },
        whereClauseXyz: 'status = open',
      }),
    );
    expect(error.reason).toBe('DATA_QUERY_ARGUMENTS_UNEXPECTED');
    expect(error.message).toContain('put every query option inside request');
    expect(error.message).not.toContain('whereClauseXyz');
    expect(error.message).not.toContain('status = open');
  });

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
    expect(error.message).toMatch(
      /^Data query value for id must be a complete id\. Valid example: \{"surfaceId":"records","request":\{"mode":/,
    );
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
