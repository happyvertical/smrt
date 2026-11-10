/**
 * Null tests at the agent boundary (#4448): `data.inspect` shows them, the
 * argument schema states them, and a filter that tries to test a nullable
 * field for an empty value some other way fails with a hint that names
 * `isNull`/`isNotNull` and a valid example — never a hidden field, and never
 * for a field that cannot hold null.
 */
import type { DataQueryRequest } from '@happyvertical/smrt-types';
import type { SessionPermissionRuntimeContext } from '@happyvertical/smrt-users';
import { describe, expect, it, vi } from 'vitest';
import type { DataSurfaceSchema } from './data-surface.js';
import {
  createDataSurfaceTools,
  DATA_INSPECT_TOOL_SLUG,
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
      filterOperators: ['eq', 'in'],
    },
    {
      id: 'status',
      type: 'string',
      projectable: true,
      filterOperators: ['eq', 'ne', 'in', 'notIn', 'isNull', 'isNotNull'],
      values: [{ value: 'active' }, { value: 'break' }],
    },
    {
      id: 'endedAt',
      type: 'datetime',
      projectable: true,
      filterOperators: ['eq', 'ne', 'gt', 'lt', 'isNull', 'isNotNull'],
    },
    // Nullable, but only the null tests are declared.
    {
      id: 'closedBy',
      type: 'string',
      projectable: true,
      filterOperators: ['isNull', 'isNotNull'],
    },
    // Not nullable.
    {
      id: 'hours',
      type: 'number',
      projectable: true,
      filterOperators: ['eq', 'gt'],
    },
    {
      id: 'hiddenAt',
      type: 'datetime',
      projectable: true,
      filterOperators: ['eq', 'isNull', 'isNotNull'],
      sensitive: true,
    },
  ],
};

function fakeRun(): PrincipalRun {
  const permissions = ['records.read'];
  const tools = [DATA_QUERY_TOOL_SLUG, DATA_INSPECT_TOOL_SLUG];
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
    allowedTools: tools,
    isToolAllowed: (tool) => tools.includes(tool),
    assertToolAllowed(tool) {
      if (!tools.includes(tool)) throw new Error(`denied:${tool}`);
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

function tools(execute = vi.fn(async (..._args: unknown[]) => emptyResult)) {
  const all = createDataSurfaceTools({
    surfaces: [{ id: 'punches', collection: 'punches', schema }],
    execute,
  });
  const call = (slug: string) => {
    const tool = all.find((candidate) => candidate.slug === slug);
    if (!tool) throw new Error(`${slug} missing`);
    return (args: Record<string, unknown>) =>
      tool.execute({ run: fakeRun(), args, db: undefined });
  };
  return {
    query: call(DATA_QUERY_TOOL_SLUG),
    inspect: call(DATA_INSPECT_TOOL_SLUG),
    execute,
  };
}

const emptyResult = { rows: [], total: { kind: 'exact', value: 0 } };

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

async function countError(filter: unknown): Promise<DataSurfaceRequestError> {
  return requestError(
    tools().query({ surfaceId: 'punches', request: { mode: 'count', filter } }),
  );
}

const IS_NULL_EXAMPLE =
  'Valid example: {"surfaceId":"punches","request":{"mode":"count","filter":{"kind":"condition","field":"endedAt","operator":"isNull"}}}';
const IS_NOT_NULL_EXAMPLE =
  'Valid example: {"surfaceId":"punches","request":{"mode":"count","filter":{"kind":"condition","field":"endedAt","operator":"isNotNull"}}}';

describe('data surface null tests (#4448)', () => {
  it('shows the null tests in data.inspect and the argument schema', async () => {
    const inspected = (await tools().inspect({ surfaceId: 'punches' })) as {
      fields: DataSurfaceSchema['fields'];
    };
    const byId = new Map(inspected.fields.map((field) => [field.id, field]));
    expect(byId.get('endedAt')?.filterOperators).toEqual([
      'eq',
      'gt',
      'isNotNull',
      'isNull',
      'lt',
      'ne',
    ]);
    expect(byId.get('hours')?.filterOperators).toEqual(['eq', 'gt']);
    expect(byId.has('hiddenAt')).toBe(false);

    const request = (
      DATA_QUERY_TOOL_PARAMETERS.properties as Record<string, any>
    ).request;
    expect(request.properties.filter.properties.operator.enum).toEqual(
      expect.arrayContaining(['isNull', 'isNotNull']),
    );
    expect(request.properties.filter.description).toContain(
      'isNull/isNotNull test for an empty value and take no value',
    );
  });

  it('runs a null test, alone and nested, with no value reaching the executor', async () => {
    const { query, execute } = tools();
    await query({
      surfaceId: 'punches',
      request: {
        mode: 'count',
        filter: {
          kind: 'all',
          filters: [
            {
              kind: 'condition',
              field: 'status',
              operator: 'in',
              value: ['active', 'break'],
            },
            {
              kind: 'condition',
              field: 'endedAt',
              operator: 'isNull',
              value: null,
            },
          ],
        },
      },
    });
    const request = execute.mock.calls[0]?.[1] as DataQueryRequest;
    expect(request.filter).toEqual({
      kind: 'all',
      filters: [
        { kind: 'condition', field: 'endedAt', operator: 'isNull' },
        {
          kind: 'condition',
          field: 'status',
          operator: 'in',
          value: ['active', 'break'],
        },
      ],
    });
  });

  it('keeps eq null working as before', async () => {
    const { query, execute } = tools();
    await query({
      surfaceId: 'punches',
      request: {
        mode: 'count',
        filter: {
          kind: 'condition',
          field: 'endedAt',
          operator: 'eq',
          value: null,
        },
      },
    });
    const request = execute.mock.calls[0]?.[1] as DataQueryRequest;
    expect(request.filter).toEqual({
      kind: 'condition',
      field: 'endedAt',
      operator: 'eq',
      value: null,
    });
  });

  it('points eq "null" on a nullable datetime at isNull', async () => {
    const error = await countError({
      kind: 'condition',
      field: 'endedAt',
      operator: 'eq',
      value: 'null',
    });
    expect(error.message).toContain('must be an RFC 3339 instant');
    expect(error.message).toContain(
      'To test whether endedAt is empty, use operator "isNull" with no value (or "isNotNull" for rows that have one): {"kind":"condition","field":"endedAt","operator":"isNull"}.',
    );
    expect(error.message).toContain(IS_NULL_EXAMPLE);
  });

  it('points ne [] at isNotNull', async () => {
    const error = await countError({
      kind: 'condition',
      field: 'endedAt',
      operator: 'ne',
      value: [],
    });
    expect(error.message).toContain('ne value must be a scalar');
    expect(error.message).toContain('operator "isNull" with no value');
    expect(error.message).toContain(IS_NOT_NULL_EXAMPLE);
  });

  it('points a not filter that names the field at the null tests', async () => {
    const bare = await countError({ kind: 'not', field: 'endedAt' });
    expect(bare.message).toContain('unsupported key "field"');
    expect(bare.message).toContain('To test whether endedAt is empty');
    expect(bare.message).toContain(IS_NULL_EXAMPLE);

    // not(eq null) written flat means "has a value".
    const flat = await countError({
      kind: 'not',
      field: 'endedAt',
      operator: 'eq',
      value: null,
    });
    expect(flat.message).toContain(IS_NOT_NULL_EXAMPLE);

    // A well-formed not around a bad null attempt flips the suggestion too.
    const nested = await countError({
      kind: 'not',
      filter: {
        kind: 'condition',
        field: 'endedAt',
        operator: 'eq',
        value: 'NULL',
      },
    });
    expect(nested.message).toContain(IS_NOT_NULL_EXAMPLE);
  });

  it('points eq null at the null tests where the field declares no eq', async () => {
    const error = await countError({
      kind: 'condition',
      field: 'closedBy',
      operator: 'eq',
      value: null,
    });
    expect(error.reason).toBe('DATA_QUERY_OPERATOR_NOT_ALLOWED');
    expect(error.message).toContain(
      'Allowed operators for closedBy: isNotNull, isNull.',
    );
    expect(error.message).toContain(
      '{"kind":"condition","field":"closedBy","operator":"isNull"}',
    );
  });

  it('reads exists and is_null operators as null-test attempts', async () => {
    const exists = await countError({
      kind: 'condition',
      field: 'endedAt',
      operator: 'exists',
    });
    expect(exists.message).toContain(IS_NOT_NULL_EXAMPLE);
    const isNullKind = await countError({ kind: 'is_null', field: 'endedAt' });
    expect(isNullKind.message).toContain(IS_NULL_EXAMPLE);
  });

  it('points a declared value check at isNull for "null" on a closed set', async () => {
    const error = await countError({
      kind: 'condition',
      field: 'status',
      operator: 'eq',
      value: 'null',
    });
    expect(error.reason).toBe('DATA_QUERY_VALUE_NOT_ALLOWED');
    expect(error.message).toContain(
      '{"kind":"condition","field":"status","operator":"isNull"}',
    );
  });

  it('gives no null hint for a field that cannot hold null, or a hidden one', async () => {
    const hours = await countError({
      kind: 'condition',
      field: 'hours',
      operator: 'eq',
      value: 'null',
    });
    expect(hours.message).toContain('must be a number');
    expect(hours.message).not.toContain('To test whether');

    const hidden = await countError({
      kind: 'condition',
      field: 'hiddenAt',
      operator: 'eq',
      value: 'null',
    });
    // Exactly the message an undeclared field gets: no null hint for it.
    expect(hidden.reason).toBe('DATA_QUERY_FIELD_NOT_ALLOWED');
    expect(hidden.message).not.toContain('To test whether');
  });

  it('rejects a value on a null test with the valueless shape', async () => {
    const error = await countError({
      kind: 'condition',
      field: 'endedAt',
      operator: 'isNull',
      value: 'true',
    });
    expect(error.message).toContain(
      'isNull takes no value; omit value: {"kind":"condition","field":"endedAt","operator":"isNull"}',
    );
  });
});
