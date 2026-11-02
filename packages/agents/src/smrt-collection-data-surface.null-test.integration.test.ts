/**
 * Null tests on the generic SMRT collection surface (#4448), end to end.
 *
 * "Who is still clocked in" is `endedAt isNull`. The SQLite lane always runs;
 * the PostgreSQL lane runs when `SMRT_TEST_POSTGRES_URL` is set, through
 * `pnpm --filter @happyvertical/smrt-agents test:postgres`. Both lanes run the
 * same scenarios against the same fixture, so IS NULL / IS NOT NULL, their
 * negations, a nested `all`, and today's null-inclusive `ne` are proven on
 * each dialect.
 */

import { randomUUID } from 'node:crypto';
import {
  field,
  getTestDatabase,
  normalizeDataQueryRequest,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DataQueryFilter } from '@happyvertical/smrt-types';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DataSurfaceDefinition,
  DataSurfaceExecutionContext,
} from './data-surface.js';
import {
  clearSmrtCollectionQuerySchemaCache,
  createSmrtCollectionDataSurfaceDefinition,
} from './smrt-collection-data-surface.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

// PostgreSQL keeps tenant ids in a native `uuid` column.
const TENANT_ID = '7c0e3a52-1b4d-4e8f-a9c6-2d5b8f1e3a74';

@smrt({ tenantScoped: { mode: 'required' } })
class SmrtSurfaceNullTestPunch extends SmrtObject {
  @field({ type: 'text' })
  tenantId = '';

  @field({ type: 'text', required: true })
  employee = '';

  @field({ type: 'text', nullable: true })
  status: string | null = null;

  @field({ type: 'datetime', required: true })
  startedAt: Date = new Date(0);

  @field({ type: 'datetime', nullable: true })
  endedAt: Date | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as any);
    for (const key of [
      'tenantId',
      'employee',
      'status',
      'startedAt',
      'endedAt',
    ] as const) {
      if (options[key] !== undefined) {
        (this as Record<string, unknown>)[key] = options[key];
      }
    }
  }
}

class SmrtSurfaceNullTestPunchCollection extends SmrtCollection<SmrtSurfaceNullTestPunch> {
  static readonly _itemClass = SmrtSurfaceNullTestPunch;
}

/**
 * Ada and Cy are still clocked in; Di is too, with no status at all; Bo has
 * clocked out.
 */
const PUNCHES = [
  { employee: 'Ada', status: 'active', endedAt: null },
  {
    employee: 'Bo',
    status: 'active',
    endedAt: new Date('2026-10-01T17:00:00.000Z'),
  },
  { employee: 'Cy', status: 'break', endedAt: null },
  { employee: 'Di', status: null, endedAt: null },
] as const;

function context(): DataSurfaceExecutionContext {
  return {
    run: {
      context: { userId: 'user-a', tenantId: TENANT_ID },
    } as DataSurfaceExecutionContext['run'],
    principal: { userId: 'user-a', tenantId: TENANT_ID },
    signal: new AbortController().signal,
  };
}

async function seed(punches: SmrtSurfaceNullTestPunchCollection) {
  await withTenant({ tenantId: TENANT_ID }, async () => {
    for (const punch of PUNCHES) {
      const row = await punches.create({
        tenantId: TENANT_ID,
        employee: punch.employee,
        status: punch.status,
        startedAt: new Date('2026-10-01T08:00:00.000Z'),
        endedAt: punch.endedAt,
      });
      await row.save();
    }
  });
}

/** The same scenarios, run against each dialect's collection. */
function nullTestScenarios(
  getPunches: () => SmrtSurfaceNullTestPunchCollection,
) {
  let definition: DataSurfaceDefinition;

  beforeAll(async () => {
    clearSmrtCollectionQuerySchemaCache();
    definition = await createSmrtCollectionDataSurfaceDefinition({
      qualifiedName: 'SmrtSurfaceNullTestPunch',
      collectionName: 'punches',
      exclude: ['context', 'slug'],
      collection: () => getPunches(),
      scope: (execution) => ({ tenantId: execution.principal.tenantId }),
    });
  });

  async function employees(filter: DataQueryFilter): Promise<string[]> {
    const request = normalizeDataQueryRequest(
      {
        version: 1,
        requestId: `null-test-${randomUUID()}`,
        mode: 'rows',
        projection: ['id', 'employee'],
        filter,
        sort: [{ field: 'employee', direction: 'asc' }],
        page: { kind: 'offset', offset: 0, limit: 10 },
      },
      definition.schema,
    );
    const result = (await definition.execute?.(
      definition,
      request,
      context(),
    )) as { rows: Record<string, unknown>[]; total: { value: number } };
    expect(result.total.value).toBe(result.rows.length);
    return result.rows.map((row) => String(row.employee));
  }

  it('declares null tests only on nullable columns', () => {
    const byId = new Map(
      definition.schema.fields.map((entry) => [entry.id, entry]),
    );
    for (const id of ['endedAt', 'status']) {
      expect(byId.get(id)?.filterOperators, id).toEqual(
        expect.arrayContaining(['isNull', 'isNotNull']),
      );
    }
    for (const id of ['id', 'employee', 'startedAt']) {
      expect(byId.get(id)?.filterOperators, id).not.toContain('isNull');
      expect(byId.get(id)?.filterOperators, id).not.toContain('isNotNull');
    }
  });

  it('isNull selects the rows still clocked in, isNotNull the rest', async () => {
    expect(
      await employees({
        kind: 'condition',
        field: 'endedAt',
        operator: 'isNull',
      }),
    ).toEqual(['Ada', 'Cy', 'Di']);
    expect(
      await employees({
        kind: 'condition',
        field: 'endedAt',
        operator: 'isNotNull',
      }),
    ).toEqual(['Bo']);
  });

  it('a negated null test is its exact complement', async () => {
    expect(
      await employees({
        kind: 'not',
        filter: { kind: 'condition', field: 'endedAt', operator: 'isNull' },
      }),
    ).toEqual(['Bo']);
    expect(
      await employees({
        kind: 'not',
        filter: { kind: 'condition', field: 'status', operator: 'isNotNull' },
      }),
    ).toEqual(['Di']);
  });

  it('combines with in inside all, and with eq inside any', async () => {
    expect(
      await employees({
        kind: 'all',
        filters: [
          {
            kind: 'condition',
            field: 'status',
            operator: 'in',
            value: ['active', 'break'],
          },
          { kind: 'condition', field: 'endedAt', operator: 'isNull' },
        ],
      }),
    ).toEqual(['Ada', 'Cy']);
    expect(
      await employees({
        kind: 'any',
        filters: [
          { kind: 'condition', field: 'status', operator: 'isNull' },
          {
            kind: 'condition',
            field: 'status',
            operator: 'eq',
            value: 'break',
          },
        ],
      }),
    ).toEqual(['Cy', 'Di']);
    // De Morgan through not(any): neither clocked out nor without a status.
    expect(
      await employees({
        kind: 'not',
        filter: {
          kind: 'any',
          filters: [
            { kind: 'condition', field: 'endedAt', operator: 'isNotNull' },
            { kind: 'condition', field: 'status', operator: 'isNull' },
          ],
        },
      }),
    ).toEqual(['Ada', 'Cy']);
  });

  it('keeps eq null and the null-inclusive ne unchanged', async () => {
    // `eq null` was already the null test; it still means IS NULL.
    expect(
      await employees({
        kind: 'condition',
        field: 'endedAt',
        operator: 'eq',
        value: null,
      }),
    ).toEqual(['Ada', 'Cy', 'Di']);
    // `ne x` matches rows with no value too (IS NULL OR <> x), so Di is in.
    expect(
      await employees({
        kind: 'condition',
        field: 'status',
        operator: 'ne',
        value: 'active',
      }),
    ).toEqual(['Cy', 'Di']);
  });
}

describe('SMRT collection surface null tests (#4448, real SQLite)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let punches: SmrtSurfaceNullTestPunchCollection;

  beforeAll(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['SmrtSurfaceNullTestPunch'],
    });
    enableTenancy();
    punches = await SmrtSurfaceNullTestPunchCollection.create({ db });
    await seed(punches);
  });

  afterAll(async () => {
    disableTenancy();
    clearSmrtCollectionQuerySchemaCache();
    await db?.close?.();
  });

  nullTestScenarios(() => punches);
});

postgresDescribe(
  'SMRT collection surface null tests (#4448, PostgreSQL)',
  () => {
    let db: Awaited<ReturnType<typeof getDatabase>>;
    let punches: SmrtSurfaceNullTestPunchCollection;

    beforeAll(async () => {
      db = await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-4448-${randomUUID()}`,
        __smrtSkipVitestSchemaPreparation: true,
      } as Parameters<typeof getDatabase>[0]);
      await getTestDatabase({
        db: db as never,
        classes: ['SmrtSurfaceNullTestPunch'],
      });
      enableTenancy();
      punches = await SmrtSurfaceNullTestPunchCollection.create({
        db: db as never,
      });
      await seed(punches);
    });

    afterAll(async () => {
      disableTenancy();
      ObjectRegistry.clear();
      clearSmrtCollectionQuerySchemaCache();
      await db?.close?.();
    });

    nullTestScenarios(() => punches);
  },
);
