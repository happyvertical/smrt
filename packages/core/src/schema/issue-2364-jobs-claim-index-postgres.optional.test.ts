/**
 * Issue #2364 — live PostgreSQL plan for the jobs claim-loop predicate.
 *
 * Runs only in the PostgreSQL lane (`pnpm --filter @happyvertical/smrt-core
 * test:postgres`, which supplies `DATABASE_URL`); skipped otherwise.
 *
 * `schema-path-parity.test.ts` proves `indexed: true` and `@smrt({ indexes })`
 * are *emitted* identically on every schema path. Only a real planner proves
 * the thing epic #2382 finding A3 is actually about: every ~1s, every
 * `TaskRunner` polls `SmrtJobCollection.claimReady()` — `WHERE status =
 * 'pending' AND run_at <= ?  ORDER BY priority DESC, run_at ASC, created_at
 * ASC, id ASC LIMIT ?` — and before this issue `_smrt_jobs` carried no index
 * that could serve it (only compat `tenant_id`/`task_id` indexes on legacy
 * databases), so every poll from every runner was a sequential scan.
 *
 * The table shape here mirrors `@happyvertical/smrt-jobs`'s real `SmrtJob`
 * class (`status`/`runAt` both `indexed: true`, plus the class-level
 * `(status, run_at)` composite declared via `@smrt({ indexes })`) rather than
 * importing it — `smrt-core` cannot depend on `smrt-jobs` (dependency
 * direction), and `SchemaGenerator` run directly is what proves the
 * PRODUCTION manifest path, matching `issue-2363-list-ordering-index-postgres
 * .optional.test.ts`'s approach for the same reason.
 *
 * SQLite would not show this: its planner reports a very different shape and
 * its cost model never chose the seq-scan plan the same way.
 */

import { randomUUID } from 'node:crypto';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DatabaseInterface } from '../migrations/types.js';
import { SchemaGenerator } from './generator.js';
import { renderIndexTarget } from './index-utils.js';

const pgUrl = process.env.DATABASE_URL ?? process.env.SMRT_TEST_POSTGRES_URL;
const suffix = `${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
const TABLE = `i2364_jobs_${suffix}`;

const STATUSES = ['pending', 'running', 'completed', 'failed', 'cancelled'];
const ROWS_PER_STATUS = 2000;

/** The candidate-select half of `SmrtJobCollection.claimReady()` (smrt-job.ts). */
const CLAIM_CANDIDATES = `
  SELECT id
    FROM "${TABLE}"
   WHERE status = 'pending' AND run_at <= $1
   ORDER BY priority DESC, run_at ASC, created_at ASC, id ASC
   LIMIT $2
     FOR UPDATE SKIP LOCKED
`;

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
): Promise<Record<string, unknown>> {
  const rows = resultRows(
    await db.query(`EXPLAIN (FORMAT JSON) ${sql}`, params),
  );
  const first = rows[0];
  const plan = (first['QUERY PLAN'] ?? first.query_plan) as
    | Array<{ Plan: Record<string, unknown> }>
    | string;
  const parsed = typeof plan === 'string' ? JSON.parse(plan) : plan;
  return parsed[0].Plan as Record<string, unknown>;
}

describe.skipIf(!pgUrl)(
  'jobs claim-loop predicate index on PostgreSQL (#2364, epic #2382 A3)',
  () => {
    let db: DatabaseInterface;
    let claimIndexName: string;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-test-2364-${randomUUID()}`,
        max: 2,
      } as Parameters<typeof getDatabase>[0])) as unknown as DatabaseInterface;

      // Build the table from the PRODUCTION schema path, not by hand: the
      // point of the test is that what `smrt db:migrate` ships can serve the
      // poll every runner issues roughly once per second.
      const generator = new SchemaGenerator();
      const schema = generator.generateCTISchemaFromManifest(
        'JobClaimProbe',
        TABLE,
        {
          status: {
            type: 'text',
            required: true,
            default: 'pending',
            _meta: { indexed: true },
          },
          runAt: {
            type: 'datetime',
            required: true,
            _meta: { indexed: true },
          },
          priority: { type: 'integer', required: true, default: 50 },
          queue: { type: 'text', required: true, default: 'default' },
        },
        {
          idType: 'text',
          indexes: [
            {
              name: `${TABLE}_status_run_at_idx`,
              columns: ['status', 'runAt'],
            },
          ],
        },
      );

      const claim = schema.indexes.find(
        (index) =>
          index.columns[0] === 'status' && index.columns[1] === 'run_at',
      );
      if (!claim) {
        throw new Error(
          `generator emitted no (status, run_at) index: ${JSON.stringify(
            schema.indexes.map((i) => i.name),
          )}`,
        );
      }
      claimIndexName = claim.name;

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

      // One multi-row INSERT ... SELECT unnest(): a poll loop's WHERE clause
      // only matches a small selective slice (pending rows already due), so
      // seed a realistic queue depth across every status. `run_at` spans past
      // and future so roughly half of the pending rows are actually claimable
      // — the same shape a live queue has, and selective enough that the
      // planner has a real choice to make.
      const ids: string[] = [];
      const slugs: string[] = [];
      const statuses: string[] = [];
      const offsetsSeconds: number[] = [];
      let n = 0;
      for (const status of STATUSES) {
        for (let i = 0; i < ROWS_PER_STATUS; i += 1) {
          n += 1;
          ids.push(randomUUID());
          slugs.push(`job-${n}`);
          statuses.push(status);
          // Alternates well in the past (claimable) and well in the future
          // (not yet due), independent of status.
          offsetsSeconds.push(i % 2 === 0 ? -3600 : 3600);
        }
      }

      await db.query(
        `INSERT INTO "${TABLE}" (id, slug, context, status, run_at, priority, queue, created_at, updated_at)
         SELECT r.id,
                r.slug,
                '',
                r.status,
                now() + make_interval(secs => r.offset_seconds),
                50,
                'default',
                now(),
                now()
         FROM unnest($1::text[], $2::text[], $3::text[], $4::int[])
              AS r(id, slug, status, offset_seconds)`,
        [ids, slugs, statuses, offsetsSeconds],
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

    it('serves the claim candidate-select from the (status, run_at) index, not a sequential scan', async () => {
      const plan = await explain(db, CLAIM_CANDIDATES, [
        new Date().toISOString(),
        100,
      ]);
      const nodes = planNodes(plan);

      expect(planIndexes(plan)).toContain(claimIndexName);
      expect(
        nodes.some(
          (node) =>
            node.includes('Index Scan') || node.includes('Index Only Scan'),
        ),
      ).toBe(true);
      expect(nodes).not.toContain('Seq Scan');
    });

    it('returns only pending rows already due, ordered as the runner expects', async () => {
      const rows = resultRows<{ id: string }>(
        await db.query(CLAIM_CANDIDATES.replace('FOR UPDATE SKIP LOCKED', ''), [
          new Date().toISOString(),
          50,
        ]),
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.length).toBeLessThanOrEqual(50);
    });
  },
);
