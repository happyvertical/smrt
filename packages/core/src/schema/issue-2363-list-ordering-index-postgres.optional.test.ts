/**
 * Issue #2363 — live PostgreSQL plan for the generated default list page.
 *
 * Runs only in the PostgreSQL lane (`pnpm --filter @happyvertical/smrt-core
 * test:postgres`, which supplies `DATABASE_URL`); skipped otherwise.
 *
 * The unit coverage in `generator-branches.test.ts` and
 * `schema-path-parity.test.ts` proves the index is *emitted* on every schema
 * path. Only a real planner can prove the thing the issue is actually about:
 * that the default list page — `ORDER BY created_at DESC, id ASC LIMIT n`
 * behind the tenancy interceptor's `tenant_id = ?` filter — stops being a
 * sequential scan plus a top-N sort over the whole table.
 *
 * SQLite would not show this: its planner reports a very different shape and
 * its cost model never chose the seq-scan plan the same way.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseInterface } from '../migrations/types.js';
import { DEFAULT_LIST_ORDER_BY } from '../query-bounds.js';
import { SchemaGenerator } from './generator.js';
import { renderIndexTarget } from './index-utils.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const TABLE = `i2363_listables_${suffix}`;

const TENANTS = 20;
const ROWS_PER_TENANT = 500;
const PAGE_SIZE = 50;

/** The page every generated REST/MCP/SvelteKit list route issues. */
const LIST_PAGE = `SELECT * FROM "${TABLE}" WHERE "tenant_id" = $1 ORDER BY ${DEFAULT_LIST_ORDER_BY.map(
  (clause) => {
    const [column, direction] = clause.split(' ');
    return `"${column}" ${direction}`;
  },
).join(', ')} LIMIT ${PAGE_SIZE}`;

/** Collect every node type in an EXPLAIN (FORMAT JSON) plan tree. */
function planNodes(node: Record<string, unknown>): string[] {
  const nodes = [String(node['Node Type'])];
  const children = (node.Plans ?? []) as Record<string, unknown>[];
  for (const child of children) nodes.push(...planNodes(child));
  return nodes;
}

/** Collect every index name the plan touches. */
function planIndexes(node: Record<string, unknown>): string[] {
  const names = node['Index Name'] ? [String(node['Index Name'])] : [];
  const children = (node.Plans ?? []) as Record<string, unknown>[];
  for (const child of children) names.push(...planIndexes(child));
  return names;
}

/**
 * `@happyvertical/sql` returns `{ rows, rowCount }` on PostgreSQL but a bare
 * array on other engines; normalize so the assertions read the same either way.
 */
function resultRows<T = Record<string, unknown>>(result: unknown): T[] {
  if (Array.isArray(result)) return result as T[];
  return ((result as { rows?: T[] })?.rows ?? []) as T[];
}

async function explain(
  db: DatabaseInterface,
  sql: string,
  params: unknown[],
  options = 'FORMAT JSON',
): Promise<Record<string, unknown>> {
  const rows = resultRows(
    await db.query(`EXPLAIN (${options}) ${sql}`, params),
  );
  const first = rows[0];
  const plan = (first['QUERY PLAN'] ?? first.query_plan) as
    | Array<{ Plan: Record<string, unknown> }>
    | string;
  const parsed = typeof plan === 'string' ? JSON.parse(plan) : plan;
  return parsed[0].Plan as Record<string, unknown>;
}

describe.skipIf(!pgUrl)(
  'default list ordering index on PostgreSQL (#2363)',
  () => {
    let db: DatabaseInterface;
    let tenantIds: string[];
    let orderingIndexName: string;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2363-${randomUUID()}`,
        max: 2,
      } as Parameters<typeof getDatabase>[0])) as unknown as DatabaseInterface;

      // Build the table from the PRODUCTION schema path, not by hand: the point
      // of the test is that what `smrt db:migrate` ships can serve the page.
      const generator = new SchemaGenerator();
      const schema = generator.generateCTISchemaFromManifest(
        'Listable',
        TABLE,
        {
          tenantId: {
            type: 'text',
            _meta: { __tenancy: { isTenantIdField: true } },
          },
          title: { type: 'text' },
        },
        { idType: 'text' },
      );

      const ordering = schema.indexes.find(
        (index) =>
          index.columns[0] === 'tenant_id' && index.columns[1] === 'created_at',
      );
      if (!ordering) {
        throw new Error(
          `generator emitted no (tenant_id, created_at) index: ${JSON.stringify(
            schema.indexes.map((i) => i.name),
          )}`,
        );
      }
      orderingIndexName = ordering.name;

      await db.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      await db.query(schema.ddl);
      for (const index of schema.indexes) {
        await db.query(
          `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX "${index.name}" ON "${TABLE}" (${renderIndexTarget(
            index,
            'postgres',
          )})`,
        );
      }

      tenantIds = Array.from({ length: TENANTS }, () => randomUUID());
      // One multi-row INSERT ... SELECT: 10k rows through the driver row by row
      // would dominate the runtime of the lane for no extra signal.
      await db.query(
        `INSERT INTO "${TABLE}" (id, slug, context, tenant_id, title, created_at, updated_at)
       SELECT gen_random_uuid()::text,
              t.tenant_id || '-' || g::text,
              '',
              t.tenant_id,
              'row ' || g::text,
              now() - (g || ' seconds')::interval,
              now()
       FROM unnest($1::text[]) AS t(tenant_id),
            generate_series(1, ${ROWS_PER_TENANT}) AS g`,
        [tenantIds],
      );
      await db.query(`ANALYZE "${TABLE}"`);
    }, 120_000);

    afterAll(async () => {
      try {
        await db?.query(`DROP TABLE IF EXISTS "${TABLE}"`);
      } finally {
        await (db as unknown as { close?: () => Promise<void> })?.close?.();
      }
    });

    it('serves the default tenant-scoped list page from the ordering index, with no full sort', async () => {
      const plan = await explain(db, LIST_PAGE, [tenantIds[0]]);
      const nodes = planNodes(plan);

      expect(planIndexes(plan)).toContain(orderingIndexName);
      expect(nodes.some((node) => node.includes('Index Scan'))).toBe(true);
      expect(nodes).not.toContain('Seq Scan');
      // A plain `Sort` node is the top-N sort of the whole tenant partition that
      // this index exists to remove. `Incremental Sort` is allowed and expected:
      // the default order mixes directions (`created_at DESC, id ASC`), so the
      // planner still orders `id` inside each same-timestamp group — over a
      // handful of rows, not the table.
      expect(nodes).not.toContain('Sort');
    });

    it('reads only the page, not the tenant partition', async () => {
      const plan = await explain(
        db,
        LIST_PAGE,
        [tenantIds[1]],
        'ANALYZE, FORMAT JSON',
      );

      // ROWS_PER_TENANT rows exist for this tenant and TENANTS * ROWS_PER_TENANT
      // in the table; the plan returns exactly one page.
      expect(Number(plan['Actual Rows'])).toBe(PAGE_SIZE);
    });

    it('still returns the rows the ordering promises', async () => {
      const rows = resultRows<{
        tenant_id: string;
        created_at: Date | string;
      }>(await db.query(LIST_PAGE, [tenantIds[2]]));

      expect(rows).toHaveLength(PAGE_SIZE);
      expect(new Set(rows.map((row) => row.tenant_id))).toEqual(
        new Set([tenantIds[2]]),
      );
      const timestamps = rows.map((row) => new Date(row.created_at).getTime());
      expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
    });
  },
);
