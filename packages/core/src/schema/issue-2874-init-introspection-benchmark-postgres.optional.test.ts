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

      // Warmup run, excluded from both the statement count and the wall-time
      // samples below: the first `compare()` against a fresh connection pays
      // one-time JIT/connection-setup cost unrelated to the algorithm this
      // benchmark pins (#2890).
      {
        const warmup = new SchemaComparer(db, {});
        await warmup.compare(manifest);
      }

      const { counts } = wrapCountingQuery(db);

      const perRunMs: number[] = [];
      const started = performance.now();
      for (let run = 0; run < INIT_COUNT; run++) {
        const runStarted = performance.now();
        const comparer = new SchemaComparer(db, {});
        await comparer.compare(manifest);
        perRunMs.push(performance.now() - runStarted);
      }
      const elapsedMs = performance.now() - started;

      const { total, byPrefix } = counts();
      const perRun = total / INIT_COUNT;
      const perObjectPerRun = perRun / OBJECT_COUNT;
      const sortedMs = [...perRunMs].sort((a, b) => a - b);
      const medianMs = sortedMs[Math.floor(sortedMs.length / 2)];
      const slowestMs = sortedMs[sortedMs.length - 1];

      console.log(
        `[issue-2874-bench] total_statements=${total} runs=${INIT_COUNT} objects=${OBJECT_COUNT} ` +
          `statements_per_run=${perRun.toFixed(2)} statements_per_object_per_run=${perObjectPerRun.toFixed(3)} ` +
          `elapsed_ms=${elapsedMs.toFixed(1)} median_run_ms=${medianMs.toFixed(1)} slowest_run_ms=${slowestMs.toFixed(1)}`,
      );
      const top = [...byPrefix.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      for (const [sql, count] of top) {
        console.log(
          `[issue-2874-bench]   ${count.toString().padStart(6)}  ${sql}`,
        );
      }

      // Regression ceiling (#2874, tightened by #2878): before the #2876
      // fix, `detectRenameDataPending` (landed in 0.47.2, #2752/#2767)
      // issued one `SELECT 1 ... LIMIT 1` round trip per declared column,
      // then one more per type-compatible orphan column, for every table
      // with any orphan columns — measured at 427 statements/run for this
      // fixture (71 tables × ~6 columns/table), 5.9x the pre-regression 72
      // statements/run. #2876 batched every *table's* live-data probe into
      // one query each, independent of column count, but still paid at
      // least one round trip *per table* — measured at 143 statements/run
      // (72 pre-regression baseline + a 71-statement per-table floor, one
      // per table). #2878 batches the probe *across every table* into a
      // small, table-count-independent number of round trips instead of
      // one per table — measured at 73 statements/run for this fixture (72
      // pre-regression baseline + 1: the whole 71-table schema's
      // rename-pending probe now costs a single statement, not 71). The
      // ceiling below sits just above that fixed measurement: comfortably
      // clear of normal variance, but low enough that a reintroduced
      // per-table probe loop (143-shaped) or a per-column one (427-shaped)
      // both trip it.
      expect(perRun).toBeLessThan(90);

      // Wall-time ceiling. #2890 (closed; retitled) reported a downstream
      // migration pipeline running 3-4x slower wall-clock despite a matched
      // statement count; that regression was root-caused outside this
      // benchmark — in `smrt-vitest`'s `getDatabase()` auto-schema sync, not
      // in `SchemaComparer.compare()` — and fixed in #2892 (shipped in
      // 0.51.2; the affected downstream test was later confirmed at 2.03s on
      // the follow-up 0.51.3 release, down from 53.34s on 0.51.1 and better
      // than the pre-regression 0.45.1 baseline of 13.68s). Separately from
      // that specific incident, #2890 exposed a structural gap this
      // assertion closes: a pure round-trip *count* cannot see a round trip
      // that stays the same in number but grows individually more expensive
      // (or added non-SQL work between round trips), because count and cost
      // are independent dimensions. This second assertion adds the missing
      // cost dimension so a future regression of that shape inside
      // `compare()` itself — same statement count, worse per-statement or
      // per-run cost — still fails the suite, even though the specific 2890
      // incident did not originate here.
      //
      // What this ceiling can and cannot promise: measured on this session's
      // dev machine (16 cores, local Postgres 18 in Docker), idle wall-clock
      // medians across 5 runs were tight (662-677ms, ~2% spread) — but a
      // sixth and seventh run repeated under heavy concurrent CPU load (16
      // saturated cores, no code change at all) produced medians of 3725ms
      // and 3896ms, a 5.5-5.9x jump from noise alone, comfortably exceeding
      // what a 4x-regression-sized ceiling would need to allow. (Idle
      // baseline is environment-specific, not a portable constant: an
      // earlier measurement of this identical code on a different local
      // setup recorded ~300-400ms/run — over 2x faster than this session's
      // ~665ms idle median on the same fixture. Any "Nx baseline" framing
      // below is this machine's ratio, not a universal one.) That variance
      // rules out a tight absolute threshold: ordinary shared-runner
      // contention can produce swings larger than the regression class this
      // guard is meant to catch, so a threshold precise enough to reliably
      // flag a 4x `compare()` regression would also flag normal noise and
      // get disabled as flaky within weeks — the same failure mode that let
      // #2890 through in spirit, just inverted. The ceiling below is set
      // well above the worst noise-only sample observed on this machine
      // (3896ms, ~1.5x margin) so it does not fire on the contention level
      // measured here, which means it only reliably catches a gross,
      // order-of-magnitude regression (roughly 9x this session's idle
      // baseline, though that multiple shifts with the measuring
      // environment) — not a precise 4x one. This has only been exercised
      // against local dev-machine variance, not the actual ARC CI runner
      // this suite runs on nightly via `.github/workflows/postgres-tests.yml`
      // (`test:postgres`); the CI margin above is inferred from this
      // machine's noise profile, not observed on the runner itself. A
      // relative (version-over-version) comparison would need a second
      // build to diff against and does not fit this single-run shape;
      // median (not mean) still guards against one slow outlier run
      // tripping the suite while a real regression fails every run.
      expect(medianMs).toBeLessThan(6000);
    }, 120_000);
  },
);
