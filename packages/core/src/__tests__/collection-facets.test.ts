import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_FACET_LIMIT,
  MAX_FACET_FIELDS,
  MAX_FACET_LIMIT,
  SmrtCollection,
  type SmrtFacetResult,
} from '../collection.js';
import { field, SmrtObject, smrt } from '../index.js';
import { GlobalInterceptors } from '../interceptors.js';
import { getTestDatabase } from '../testing/database.js';

@smrt({
  tenantScoped: { mode: 'optional', autoPopulate: false },
})
class FacetOpportunity extends SmrtObject {
  @field({ type: 'text', nullable: true })
  status: string | null = null;

  @field({ type: 'text', nullable: true })
  workMode: string | null = null;

  @field({ type: 'json', nullable: true })
  skills: string[] | null = null;

  tenantId: string | null = null;
}

class FacetOpportunityCollection extends SmrtCollection<FacetOpportunity> {
  static readonly _itemClass = FacetOpportunity;
}

describe('SmrtCollection database-backed facets and counts (#1904)', () => {
  let db: DatabaseInterface;
  let opportunities: FacetOpportunityCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['FacetOpportunity'],
    });
    opportunities = await FacetOpportunityCollection.create({ db });
  });

  afterEach(async () => {
    GlobalInterceptors.unregister('facet-opportunity-tenant');
    await db?.close?.();
  });

  async function seed() {
    await opportunities.create({
      status: 'open',
      workMode: 'remote',
      skills: ['typescript', 'sql'],
      tenantId: 'tenant-a',
    });
    await opportunities.create({
      status: 'open',
      workMode: 'hybrid',
      skills: ['typescript'],
      tenantId: 'tenant-a',
    });
    await opportunities.create({
      status: 'closed',
      workMode: 'remote',
      skills: ['sql'],
      tenantId: 'tenant-b',
    });
    await opportunities.create({
      status: null,
      workMode: null,
      skills: null,
      tenantId: 'tenant-a',
    });
  }

  it('returns scalar value counts for multiple fields without hydration', async () => {
    await seed();
    const queries: string[] = [];
    const originalQuery = db.query.bind(db);
    db.query = (async (sql: string, ...params: unknown[]) => {
      queries.push(sql);
      return originalQuery(sql, ...params);
    }) as DatabaseInterface['query'];

    const result = await opportunities.facets({
      fields: ['status', { field: 'workMode', limit: 1 }],
    });

    expect(result).toEqual([
      {
        field: 'status',
        values: [
          { value: 'open', count: 2 },
          { value: null, count: 1 },
          { value: 'closed', count: 1 },
        ],
      },
      {
        field: 'workMode',
        values: [{ value: 'remote', count: 2 }],
      },
    ] satisfies SmrtFacetResult[]);

    const facetQueries = queries.filter((sql) =>
      sql.includes(`FROM ${opportunities.tableName}`),
    );
    expect(facetQueries).toHaveLength(2);
    expect(facetQueries[0]).toContain('GROUP BY "status"');
    expect(facetQueries[0]).not.toContain('SELECT *');
  });

  it('keeps omitted and explicit limits bounded, including empty strings', async () => {
    await opportunities.create({
      status: '',
      workMode: 'remote',
      skills: null,
      tenantId: 'tenant-a',
    });

    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const originalQuery = db.query.bind(db);
    db.query = (async (sql: string, ...params: unknown[]) => {
      queries.push({ sql, params });
      return originalQuery(sql, ...params);
    }) as DatabaseInterface['query'];

    const result = await opportunities.facets({
      fields: [{ field: 'status', limit: MAX_FACET_LIMIT + 1 }],
    });

    expect(result[0]?.values).toContainEqual({ value: '', count: 1 });
    expect(queries.at(-1)?.sql).toContain('LIMIT $1');
    expect(queries.at(-1)?.params).toEqual([MAX_FACET_LIMIT]);

    await opportunities.facets({ fields: ['status'] });
    expect(queries.at(-1)?.params).toEqual([DEFAULT_FACET_LIMIT]);

    const boundedCollection = await FacetOpportunityCollection.create({
      db,
      defaultListLimit: 1,
    });
    const bounded = await boundedCollection.facets({ fields: ['status'] });
    expect(bounded[0]?.values).toHaveLength(1);

    const cappedCollection = await FacetOpportunityCollection.create({
      db,
      maxListLimit: 1,
    });
    const capped = await cappedCollection.facets({
      fields: [{ field: 'status', limit: MAX_FACET_LIMIT }],
    });
    expect(capped[0]?.values).toHaveLength(1);

    await expect(
      opportunities.facets({
        fields: Array.from(
          { length: MAX_FACET_FIELDS + 1 },
          (_, index) => `field${index}` as never,
        ),
      }),
    ).rejects.toThrow(`at most ${MAX_FACET_FIELDS} fields`);
    expect(DEFAULT_FACET_LIMIT).toBe(50);
  });

  it('composes facets with where and groups array fields by stored value', async () => {
    await seed();

    const result = await opportunities.facets({
      where: { workMode: 'remote' },
      fields: ['status', 'skills'],
    });

    expect(result[0]).toEqual({
      field: 'status',
      values: [
        { value: 'closed', count: 1 },
        { value: 'open', count: 1 },
      ],
    });
    // JSON/string-list fields are not unnested. Each stored JSON value is one
    // facet. This encoding assertion is intentionally scoped to SQLite; the
    // portable scalar adapter cases below cover SQLite and DuckDB, while the
    // optional PostgreSQL test covers scalar grouping only.
    expect(result[1]).toEqual({
      field: 'skills',
      values: [
        { value: ['sql'], count: 1 },
        { value: ['typescript', 'sql'], count: 1 },
      ],
    });
  });

  it('returns tenant-scoped total and filtered counts', async () => {
    await seed();
    GlobalInterceptors.register({
      name: 'facet-opportunity-tenant',
      beforeList(_className, options) {
        return {
          ...options,
          where: { ...options.where, tenantId: 'tenant-a' },
        };
      },
    });

    await expect(opportunities.facets({ fields: ['status'] })).resolves.toEqual(
      [
        {
          field: 'status',
          values: [
            { value: 'open', count: 2 },
            { value: null, count: 1 },
          ],
        },
      ],
    );
    await expect(
      opportunities.counts({ where: { status: 'open' } }),
    ).resolves.toEqual({ total: 3, filtered: 2 });
  });

  it('rejects duplicate, unknown, and invalid facet requests', async () => {
    await expect(
      opportunities.facets({ fields: ['status', 'status'] }),
    ).rejects.toThrow(/requested more than once/);
    await expect(
      opportunities.facets({ fields: ['missing' as never] }),
    ).rejects.toThrow(/Invalid select field: 'missing'/);
    await expect(
      opportunities.facets({
        fields: [{ field: 'status', limit: -1 }],
      }),
    ).rejects.toThrow(/facet limit/);
  });

  it.each([
    { name: 'SQLite', type: 'sqlite' as const },
    { name: 'DuckDB', type: 'duckdb' as const },
  ])('runs portable scalar facets on $name', async ({ type }) => {
    const portableDb = await getTestDatabase({
      type,
      url: ':memory:',
      classes: ['FacetOpportunity'],
    });
    try {
      const portable = await FacetOpportunityCollection.create({
        db: portableDb,
      });
      await portable.create({
        status: 'open',
        workMode: 'remote',
        skills: null,
        tenantId: 'tenant-a',
      });
      await portable.create({
        status: 'closed',
        workMode: 'remote',
        skills: null,
        tenantId: 'tenant-a',
      });

      await expect(portable.facets({ fields: ['status'] })).resolves.toEqual([
        {
          field: 'status',
          values: [
            { value: 'closed', count: 1 },
            { value: 'open', count: 1 },
          ],
        },
      ]);
    } finally {
      await portableDb.close?.();
    }
  });
});
