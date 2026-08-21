import { describe, expect, it } from 'vitest';
import {
  executeSmrtWebDataQuery,
  normalizeSmrtWebDataQueryResult,
  type SmrtWebDataQueryRequest,
} from './data-query.js';

const request: SmrtWebDataQueryRequest = {
  version: 1,
  requestId: 'browser-query-1',
  mode: 'rows',
  projection: ['name'],
  page: { kind: 'offset', offset: 0, limit: 10 },
};

const result = {
  version: 1,
  requestId: 'browser-query-1',
  queryFingerprint: 'dq1_bounded',
  identityField: 'id',
  rows: [{ id: 'row-1', name: 'Ada' }],
  page: { kind: 'offset', offset: 0, limit: 10, hasMore: false },
  total: { kind: 'exact', value: 1 },
  freshness: { state: 'fresh' },
  warnings: ['revalidated', 'cache-hit'],
  truncated: false,
};

describe('smrt-web bounded data-query transport', () => {
  it('normalizes the same result envelope returned by a server adapter', async () => {
    await expect(
      executeSmrtWebDataQuery(
        {
          query: async (received) =>
            received.requestId === request.requestId ? result : {},
        },
        request,
      ),
    ).resolves.toEqual({
      ...result,
      warnings: ['cache-hit', 'revalidated'],
    });
  });

  it('fails closed for malformed browser envelopes', () => {
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        rows: [{ id: 'row-1', name: 'Ada', nested: () => 'unsafe' }],
      }),
    ).toThrow(/plain object|JSON/i);
    expect(() =>
      normalizeSmrtWebDataQueryResult({ ...result, tenantId: 'other' }),
    ).toThrow(/contains tenantId/i);
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        page: { kind: 'cursor', limit: 10, hasMore: true },
      }),
    ).toThrow(/hasMore/i);
  });

  it('enforces row and facet response ceilings before copying a payload', () => {
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        rows: Array.from({ length: 1_001 }, (_, index) => ({
          id: `row-${index}`,
        })),
      }),
    ).toThrow(/rows exceed/i);
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        facets: Array.from({ length: 21 }, (_, index) => ({
          field: `facet-${index}`,
          values: [],
          truncated: false,
        })),
      }),
    ).toThrow(/facets exceed/i);
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        page: {
          kind: 'offset',
          offset: 1_000_001,
          limit: 10,
          hasMore: false,
        },
      }),
    ).toThrow(/offset exceeds/i);
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        rows: [
          { id: 'row-1', name: 'Ada' },
          { id: 'row-2', name: 'Grace' },
        ],
        page: { kind: 'offset', offset: 0, limit: 1, hasMore: true },
      }),
    ).toThrow(/declared page limit/i);
    expect(() =>
      normalizeSmrtWebDataQueryResult({
        ...result,
        rows: Array.from({ length: 1_000 }, (_, index) => ({
          id: `row-${index}`,
          name: 'x'.repeat(12_000),
        })),
        page: { kind: 'offset', offset: 0, limit: 1_000, hasMore: false },
      }),
    ).toThrow(/maximum byte limit/i);
  });
});
