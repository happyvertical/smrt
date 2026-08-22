import type {
  DataQueryRequest,
  DataQuerySchema,
} from '@happyvertical/smrt-types';
import { describe, expect, it } from 'vitest';
import {
  createDataQueryFingerprint,
  normalizeDataQueryRequest,
  normalizeDataQueryResult,
  normalizeDataQuerySchema,
} from './data-query';

const schema: DataQuerySchema = {
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
      id: 'name',
      type: 'string',
      projectable: true,
      sortable: true,
      filterOperators: ['eq', 'like', 'in'],
    },
    {
      id: 'price',
      type: 'number',
      projectable: true,
      sortable: true,
      facetable: true,
      filterOperators: ['eq', 'gt', 'gte', 'lt', 'lte', 'in'],
    },
    {
      id: 'apiSecret',
      type: 'string',
    },
  ],
  defaultPageLimit: 25,
  maxPageLimit: 100,
  maxResultBytes: 10_000,
  supports: { cursorPagination: true, consistency: true, facets: true },
};

function rowsRequest(
  overrides: Partial<DataQueryRequest> = {},
): DataQueryRequest {
  return {
    version: 1,
    requestId: 'request-1',
    mode: 'rows',
    projection: ['name'],
    filter: {
      kind: 'all',
      filters: [
        { kind: 'condition', field: 'price', operator: 'gte', value: 10 },
        {
          kind: 'condition',
          field: 'name',
          operator: 'in',
          value: ['Grace', 'Ada'],
        },
      ],
    },
    sort: [{ field: 'name', direction: 'asc' }],
    page: { kind: 'offset', offset: 0, limit: 25 },
    ...overrides,
  };
}

describe('bounded data-query protocol', () => {
  it('canonicalizes equivalent request structure and retains an identity tiebreak', () => {
    const first = rowsRequest();
    const second = rowsRequest({
      requestId: 'request-2',
      projection: ['name', 'name'],
      filter: {
        kind: 'all',
        filters: [
          {
            kind: 'condition',
            field: 'name',
            operator: 'in',
            value: ['Ada', 'Grace'],
          },
          { kind: 'condition', field: 'price', operator: 'gte', value: 10 },
        ],
      },
      page: { kind: 'offset', offset: 50, limit: 10 },
    });

    const normalized = normalizeDataQueryRequest(first, schema);
    expect(normalized).toMatchObject({
      projection: ['id', 'name'],
      sort: [
        { field: 'name', direction: 'asc' },
        { field: 'id', direction: 'asc' },
      ],
      page: { kind: 'offset', offset: 0, limit: 25 },
    });
    expect(createDataQueryFingerprint(first, schema)).toBe(
      createDataQueryFingerprint(second, schema),
    );
    expect(
      normalizeDataQueryRequest(
        rowsRequest({
          filter: {
            kind: 'condition',
            field: 'name',
            operator: 'in',
            value: ['ä', 'z'],
          },
        }),
        schema,
      ).filter,
    ).toEqual({
      kind: 'condition',
      field: 'name',
      operator: 'in',
      value: ['z', 'ä'],
    });
    expect(
      normalizeDataQueryRequest(
        rowsRequest({
          consistency: {
            mode: 'snapshot',
            asOf: '2026-08-21T23:00:00-06:00',
          },
        }),
        schema,
      ).consistency,
    ).toEqual({ mode: 'snapshot', asOf: '2026-08-22T05:00:00.000Z' });
  });

  it('rejects authority, SQL, paths, and non-allowlisted fields before execution', () => {
    expect(() =>
      normalizeDataQueryRequest(
        {
          ...rowsRequest(),
          tenantId: 'other-tenant',
        } as unknown as DataQueryRequest,
        schema,
      ),
    ).toThrow(/unsupported key/i);
    expect(() =>
      normalizeDataQueryRequest(
        {
          ...rowsRequest(),
          filter: {
            kind: 'condition',
            field: 'apiSecret',
            operator: 'eq',
            value: 'secret',
          },
        },
        schema,
      ),
    ).toThrow(/not allowed/i);
    expect(() =>
      normalizeDataQueryRequest(
        {
          ...rowsRequest(),
          filter: {
            kind: 'condition',
            field: 'name.path',
            operator: 'eq',
            value: 'Ada',
          },
        },
        schema,
      ),
    ).toThrow(/not declared/i);
    expect(() =>
      normalizeDataQueryRequest(
        {
          ...rowsRequest(),
          sql: 'SELECT * FROM users',
        } as unknown as DataQueryRequest,
        schema,
      ),
    ).toThrow(/unsupported key/i);
    expect(() =>
      normalizeDataQueryRequest(
        {
          ...rowsRequest(),
          filter: {
            kind: 'condition',
            field: 'price',
            operator: 'gte',
            value: 'ten',
          },
        },
        schema,
      ),
    ).toThrow(/must be a number/i);
  });

  it('normalizes bounded facet and count requests without carrying row controls', () => {
    expect(
      normalizeDataQueryRequest(
        {
          version: 1,
          requestId: 'facet-request',
          mode: 'facets',
          facets: [{ field: 'price', limit: 500 }],
        },
        schema,
      ),
    ).toMatchObject({
      mode: 'facets',
      facets: [{ field: 'price', limit: 100 }],
    });
    expect(() =>
      normalizeDataQueryRequest(
        {
          version: 1,
          requestId: 'bad-count-request',
          mode: 'count',
          page: { kind: 'offset', offset: 0, limit: 1 },
        },
        schema,
      ),
    ).toThrow(/cannot carry projection, sort, or page/i);
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({ page: { kind: 'offset', offset: 0, limit: 0 } }),
        schema,
      ),
    ).toThrow(/positive safe integer/i);
  });

  it('validates a projected result and rejects forged fingerprints or sensitive rows', () => {
    const request = rowsRequest();
    const queryFingerprint = createDataQueryFingerprint(request, schema);
    const valid = {
      version: 1,
      requestId: 'request-1',
      queryFingerprint,
      identityField: 'id',
      rows: [{ id: 'person-1', name: 'Ada' }],
      page: { kind: 'offset', limit: 25, offset: 0, hasMore: false },
      total: { kind: 'exact', value: 1 },
      freshness: { state: 'fresh' },
      warnings: [],
      truncated: false,
    };

    expect(normalizeDataQueryResult(valid, request, schema)).toEqual(valid);
    expect(() =>
      normalizeDataQueryResult(
        { ...valid, queryFingerprint: 'dq1_forged' },
        request,
        schema,
      ),
    ).toThrow(/fingerprint/i);
    expect(() =>
      normalizeDataQueryResult(
        {
          ...valid,
          rows: [{ id: 'person-1', name: 'Ada', apiSecret: 'never expose' }],
        },
        request,
        schema,
      ),
    ).toThrow(/non-projected field/i);
    expect(() =>
      normalizeDataQueryResult(
        { ...valid, rows: [{ id: 'person-1', name: 42 }] },
        request,
        schema,
      ),
    ).toThrow(/must be a string/i);
    expect(() =>
      normalizeDataQueryResult(
        {
          ...valid,
          rows: [{ id: 'person-1', name: 'x'.repeat(1_000) }],
        },
        request,
        { ...schema, maxResultBytes: 100 },
      ),
    ).toThrow(/maximum byte limit/i);
  });

  it('fails closed for prototype-bearing input and keeps schema normalization deterministic', () => {
    expect(() =>
      normalizeDataQueryRequest(
        JSON.parse(
          JSON.stringify({
            ...rowsRequest(),
            filter: {
              kind: 'condition',
              field: 'name',
              operator: 'eq',
              value: JSON.parse('{"__proto__":{"tenantId":"other"}}'),
            },
          }),
        ),
        schema,
      ),
    ).toThrow(/forbidden key|JSON scalar/i);
    expect(normalizeDataQuerySchema(schema)).toEqual(
      normalizeDataQuerySchema({
        ...schema,
        fields: [...schema.fields].reverse(),
      }),
    );
    expect(() =>
      normalizeDataQuerySchema({
        ...schema,
        maxResultBytes: 10_000_001,
      }),
    ).toThrow(/maximum result bytes/i);
  });

  it('bounds the total filter tree, not only any one boolean group', () => {
    const condition = {
      kind: 'condition' as const,
      field: 'price',
      operator: 'gte' as const,
      value: 10,
    };
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          filter: {
            kind: 'all',
            filters: [
              {
                kind: 'all',
                filters: Array.from({ length: 30 }, () => condition),
              },
              {
                kind: 'all',
                filters: Array.from({ length: 30 }, () => condition),
              },
            ],
          },
        }),
        schema,
      ),
    ).toThrow(/cannot exceed 50 expressions/i);
  });

  it('bounds an otherwise-valid large request payload', () => {
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          filter: {
            kind: 'condition',
            field: 'name',
            operator: 'in',
            value: Array.from(
              { length: 30 },
              (_, index) => `${index}-${'x'.repeat(4_090)}`,
            ),
          },
        }),
        schema,
      ),
    ).toThrow(/maximum byte limit/i);
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          filter: {
            kind: 'condition',
            field: 'name',
            operator: 'in',
            value: Array.from({ length: 100 }, () => 'x'.repeat(4_096)),
          },
        }),
        schema,
      ),
    ).toThrow(/maximum byte limit/i);
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          sort: Array.from({ length: 51 }, () => ({
            field: 'name',
            direction: 'asc',
          })),
        }),
        schema,
      ),
    ).toThrow(/cannot exceed 50 terms/i);
  });

  it('rejects invalid instants, unusable identities, and ambiguous pagination', () => {
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          consistency: { mode: 'snapshot', asOf: '2026-02-30T00:00:00Z' },
        }),
        schema,
      ),
    ).toThrow(/RFC 3339/i);
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          consistency: { mode: 'snapshot', asOf: '2026-08-22T01:00:00' },
        }),
        schema,
      ),
    ).toThrow(/RFC 3339/i);
    expect(() =>
      normalizeDataQuerySchema({
        ...schema,
        identityField: 'active',
        fields: [
          ...schema.fields,
          { id: 'active', type: 'boolean', projectable: true },
        ],
      }),
    ).toThrow(/identity field must use/i);
    expect(() =>
      normalizeDataQueryRequest(
        rowsRequest({
          page: { kind: 'offset', offset: 1_000_001, limit: 25 },
        }),
        schema,
      ),
    ).toThrow(/offset cannot exceed/i);

    const request = rowsRequest({
      page: { kind: 'cursor', limit: 25 },
    });
    const result = {
      version: 1,
      requestId: request.requestId,
      queryFingerprint: createDataQueryFingerprint(request, schema),
      identityField: 'id',
      rows: [{ id: 'person-1', name: 'Ada' }],
      page: {
        kind: 'cursor',
        limit: 25,
        offset: 0,
        nextCursor: 'cursor-2',
        hasMore: true,
      },
      total: { kind: 'exact', value: 1 },
      freshness: { state: 'fresh' },
      warnings: [],
      truncated: false,
    };
    expect(() => normalizeDataQueryResult(result, request, schema)).toThrow(
      /cannot return an offset/i,
    );
  });

  it('bounds and rejects cyclic JSON result fields before cloning them', () => {
    const jsonSchema: DataQuerySchema = {
      ...schema,
      fields: [
        ...schema.fields,
        { id: 'metadata', type: 'json', projectable: true },
      ],
    };
    const request = rowsRequest({ projection: ['metadata'] });
    const baseResult = {
      version: 1,
      requestId: request.requestId,
      queryFingerprint: createDataQueryFingerprint(request, jsonSchema),
      identityField: 'id',
      rows: [{ id: 'person-1', metadata: [] }],
      page: { kind: 'offset', limit: 25, offset: 0, hasMore: false },
      total: { kind: 'exact', value: 1 },
      freshness: { state: 'fresh' },
      warnings: [],
      truncated: false,
    };
    expect(() =>
      normalizeDataQueryResult(
        {
          ...baseResult,
          rows: [
            {
              id: 'person-1',
              metadata: Array.from({ length: 1_001 }, () => 1),
            },
          ],
        },
        request,
        jsonSchema,
      ),
    ).toThrow(/container-item limit/i);
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(() =>
      normalizeDataQueryResult(
        { ...baseResult, rows: [{ id: 'person-1', metadata: cyclic }] },
        request,
        jsonSchema,
      ),
    ).toThrow(/cannot contain a cycle/i);
  });

  it('validates facet values against the requested field type', () => {
    const request: DataQueryRequest = {
      version: 1,
      requestId: 'facet-result',
      mode: 'facets',
      facets: [{ field: 'price', limit: 10 }],
    };
    const result = {
      version: 1,
      requestId: 'facet-result',
      queryFingerprint: createDataQueryFingerprint(request, schema),
      identityField: 'id',
      rows: [],
      total: { kind: 'unavailable' },
      facets: [
        {
          field: 'price',
          values: [{ value: 10, count: 2 }],
          truncated: false,
        },
      ],
      freshness: { state: 'fresh' },
      warnings: [],
      truncated: false,
    };
    expect(normalizeDataQueryResult(result, request, schema)).toMatchObject(
      result,
    );
    expect(() =>
      normalizeDataQueryResult(
        {
          ...result,
          facets: [
            {
              ...result.facets[0],
              values: [{ value: 'ten', count: 2 }],
            },
          ],
        },
        request,
        schema,
      ),
    ).toThrow(/must be a number/i);
  });
});
