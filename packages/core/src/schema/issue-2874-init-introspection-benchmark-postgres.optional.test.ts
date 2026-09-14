/**
 * Statement-count benchmark for #2874.
 *
 * Reproduces the shape of the downstream regression (issue #2874) without a
 * downstream consumer: a realistic object count (71 declared tables, mirroring
 * anytown.ai's registered-object count) with the legacy-column shape a real
 * schema accumulates over time (a handful of undeclared "orphan" columns per
 * table, left behind by additive migrations), compared via `SchemaComparer`
 * the way `getPendingSchemaStatements()`/`migrateSmrtSchemas()` and the CLI's
 * `db:status`/`db:diff`/`db:migrate` do, run N times the way the downstream
 * test's seven `Agent initializing` lines suggested seven comparisons.
 *
 * Counts *statements issued*, not just wall time — wall time is noisy across
 * machines; round-trip count is the thing that regressed and is what this
 * suite pins going forward.
 *
 * PostgreSQL only, matches the original bisect's database engine. Skipped
 * without `SMRT_TEST_POSTGRES_URL` (see `scripts/run-with-ci-postgres.mjs`).
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SchemaComparer } from '../migrations/differ.js';
import type { SchemaDefinition } from './types.js';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;
const postgresDescribe = pgUrl ? describe.sequential : describe.skip;

const OBJECT_COUNT = 71;
const ORPHAN_COLUMNS_PER_TABLE = 3;
const INIT_COUNT = 7;

function tableName(i: number): string {
  return `issue_2874_bench_obj_${i}`;
}

/** One declared table: an id, a handful of ordinary columns. */
function buildManifest(): Record<string, SchemaDefinition> {
  const manifest: Record<string, SchemaDefinition> = {};
  for (let i = 0; i < OBJECT_COUNT; i++) {
    manifest[tableName(i)] = {
      tableName: tableName(i),
      columns: {
        id: { type: 'TEXT', primaryKey: true },
        name: { type: 'TEXT' },
        status: { type: 'TEXT' },
        tenant_id: { type: 'TEXT' },
        created_at: { type: 'TIMESTAMP' },
      },
      indexes: [],
    } as unknown as SchemaDefinition;
  }
  return manifest;
}

/**
 * Live tables shaped like a schema that has drifted from a manifest the way
 * a real, long-lived application does: every declared column present and
 * populated, plus a few undeclared ("orphan") legacy columns of a
 * type-compatible, populated shape — the exact precondition
 * `detectRenameDataPending()` (#2752, landed in 0.47.2) probes for.
 */
async function createLiveTables(db: DatabaseInterface): Promise<void> {
  for (let i = 0; i < OBJECT_COUNT; i++) {
    const t = tableName(i);
    await db.query(`DROP TABLE IF EXISTS "${t}"`);
    const orphanCols = Array.from(
      { length: ORPHAN_COLUMNS_PER_TABLE },
      (_, j) => `legacy_col_${j} TEXT`,
    ).join(', ');
    await db.query(`
      CREATE TABLE "${t}" (
        id TEXT PRIMARY KEY,
        name TEXT,
        status TEXT,
        tenant_id TEXT,
        created_at TIMESTAMP,
        ${orphanCols}
      )
    `);
    await db.query(
      `INSERT INTO "${t}" (id, name, status, tenant_id, created_at, ${Array.from(
        { length: ORPHAN_COLUMNS_PER_TABLE },
        (_, j) => `legacy_col_${j}`,
      ).join(', ')})
       VALUES ($1, 'a', 'active', 't1', now(), ${Array.from(
         { length: ORPHAN_COLUMNS_PER_TABLE },
         (_, j) => `'legacy-value-${j}'`,
       ).join(', ')})`,
      randomUUID(),
    );
  }
}

function wrapCountingQuery(db: DatabaseInterface): {
  db: DatabaseInterface;
  counts: () => { total: number; byPrefix: Map<string, number> };
} {
  let total = 0;
  const byPrefix = new Map<string, number>();
  const originalQuery = db.query.bind(db);
  (db as { query: typeof db.query }).query = ((...args: unknown[]) => {
    total++;
    const sql = String(args[0] ?? '').trim();
    const key = sql
      .replace(/\s+/g, ' ')
      .slice(0, 60)
      .replace(/"issue_2874_bench_obj_\d+"/g, '"<table>"');
    byPrefix.set(key, (byPrefix.get(key) ?? 0) + 1);
    return (originalQuery as (...a: unknown[]) => unknown)(...args);
  }) as typeof db.query;
  return { db, counts: () => ({ total, byPrefix }) };
}

postgresDescribe(
  'issue #2874: per-object schema-introspection statement count',
  () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: `smrt-bench-2874-${randomUUID()}`,
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await createLiveTables(db);
    });

    afterAll(async () => {
      for (let i = 0; i < OBJECT_COUNT; i++) {
        await db.query(`DROP TABLE IF EXISTS "${tableName(i)}"`);
      }
      await (db as { close?: () => Promise<void> }).close?.();
    });

    it(`issues a bounded number of statements across ${INIT_COUNT} SchemaComparer.compare() runs at ${OBJECT_COUNT} objects`, async () => {
      const manifest = buildManifest();
      const { counts } = wrapCountingQuery(db);

      const started = performance.now();
      for (let run = 0; run < INIT_COUNT; run++) {
        const comparer = new SchemaComparer(db, {});
        await comparer.compare(manifest);
      }
      const elapsedMs = performance.now() - started;

      const { total, byPrefix } = counts();
      const perRun = total / INIT_COUNT;
      const perObjectPerRun = perRun / OBJECT_COUNT;

      console.log(
        `[issue-2874-bench] total_statements=${total} runs=${INIT_COUNT} objects=${OBJECT_COUNT} ` +
          `statements_per_run=${perRun.toFixed(2)} statements_per_object_per_run=${perObjectPerRun.toFixed(3)} ` +
          `elapsed_ms=${elapsedMs.toFixed(1)}`,
      );
      const top = [...byPrefix.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [sql, count] of top) {
        console.log(
          `[issue-2874-bench]   ${count.toString().padStart(6)}  ${sql}`,
        );
      }

      // Regression ceiling (#2874): before the fix, `detectRenameDataPending`
      // (landed in 0.47.2, #2752/#2767) issued one `SELECT 1 ... LIMIT 1`
      // round trip per declared column, then one more per type-compatible
      // orphan column, for every table with any orphan columns — measured
      // at 427 statements/run for this fixture (71 tables × ~6
      // columns/table), 5.9x the pre-regression 72 statements/run. The fix
      // batches every table's live-data probe into one aggregate query
      // (plus, only when needed, one UUID-shape query), independent of
      // column count — measured at 143 statements/run for this fixture (2
      // statements/table: one batched probe, one `pg_indexes` read). The
      // ceiling below sits between the fixed measurement (143) and the
      // regressed one (427): comfortably above normal variance, but low
      // enough that a reintroduced per-column probe loop trips it.
      expect(perRun).toBeLessThan(200);
    }, 120_000);
  },
);
