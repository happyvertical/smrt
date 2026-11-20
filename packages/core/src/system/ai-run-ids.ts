/**
 * The AI run id registry beyond the insert path (docs/content/ai-runs.md
 * section 8, "Run identity"; schema 1.20.0): the upgrade backfill and the
 * `smrt doctor --db` check. Runs are written only through
 * `insertAiRunRowTx` (`ai-run-model.ts`), which reserves each id's digest
 * in the opener's transaction; the row prune reserves the id of a row it
 * deletes (`ai-run-retention.ts`).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { aiRunIdDigest, aiRunQuery, getRows, num } from './ai-run-model.js';
import { getDatabaseEngine, tableExists } from './compatibility.js';

/** Every column that names a run id, existing or referenced. */
const RUN_ID_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['_smrt_ai_runs', 'id'],
  ['_smrt_ai_runs', 'parent_run_id'],
  ['_smrt_ai_runs', 'retry_of_run_id'],
  ['_smrt_ai_runs', 'stopped_by_run_id'],
  ['_smrt_ai_run_events', 'run_id'],
  ['_smrt_ai_run_events', 'child_run_id'],
  ['_smrt_ai_run_checkpoints', 'run_id'],
  ['_smrt_ai_usage', 'run_id'],
  ['_smrt_ai_evaluations', 'run_id'],
  ['_smrt_ai_transcripts', 'run_id'],
];

/** Distinct ids read (and reserved) per statement. */
const CHUNK = 500;

/** The distinct non-null values of one column, a keyset page at a time. */
async function* distinctIds(
  db: DatabaseInterface,
  table: string,
  column: string,
  extraWhere = '',
): AsyncGenerator<string[]> {
  let last: string | null = null;
  for (;;) {
    const page: string[] = getRows(
      await aiRunQuery(
        db,
        `SELECT DISTINCT ${column} AS v FROM ${table}
          WHERE ${column} IS NOT NULL${extraWhere}${
            last === null ? '' : ` AND ${column} > $2`
          }
          ORDER BY v LIMIT $1`,
        CHUNK,
        ...(last === null ? [] : [last]),
      ),
    ).map((row) => String(row.v));
    if (page.length === 0) return;
    yield page;
    if (page.length < CHUNK) return;
    last = page[page.length - 1] as string;
  }
}

/**
 * Reserve the digest of every run id that still exists or is still
 * referenced, idempotently (`ON CONFLICT DO NOTHING`). The bootstrap calls
 * it after its compatibility step and DDL replay (so the registry exists and
 * old labels are already evaluations) and before the version stamp, so an
 * interrupted backfill runs again on the next bootstrap. Each statement
 * covers one keyset page of one column: PostgreSQL and DuckDB hash in SQL,
 * SQLite in TypeScript; all three give the same hex SHA-256 of the UTF-8
 * bytes.
 *
 * @internal
 */
export async function backfillAiRunIdRegistry(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  const engine = getDatabaseEngine(db, typeHint);
  for (const [table, column] of RUN_ID_SOURCES) {
    if (!(await tableExists(db, table, typeHint))) continue;
    for await (const page of distinctIds(db, table, column)) {
      const first = page[0] as string;
      const last = page[page.length - 1] as string;
      if (engine === 'postgres' || engine === 'duckdb') {
        const digest =
          engine === 'postgres'
            ? `encode(sha256(convert_to(${column}, 'UTF8')), 'hex')`
            : `sha256(${column})`;
        await aiRunQuery(
          db,
          `INSERT INTO _smrt_ai_run_ids (id_digest, created_at)
           SELECT DISTINCT ${digest}, CURRENT_TIMESTAMP FROM ${table}
            WHERE ${column} >= $1 AND ${column} <= $2
           ON CONFLICT (id_digest) DO NOTHING`,
          first,
          last,
        );
      } else {
        const digests = [
          ...new Set(await Promise.all(page.map(aiRunIdDigest))),
        ];
        await aiRunQuery(
          db,
          `INSERT INTO _smrt_ai_run_ids (id_digest, created_at)
           VALUES ${digests.map((_, i) => `($${i + 2}, $1)`).join(', ')}
           ON CONFLICT (id_digest) DO NOTHING`,
          new Date().toISOString(),
          ...digests,
        );
      }
    }
  }
}

/** What {@link checkAiRunIdRegistry} found. */
export interface AiRunIdRegistryCheck {
  /**
   * Ids referenced by a run, event, checkpoint, usage row, evaluation or
   * transcript that have neither a run row nor a registry row: an older
   * core pruned or wrote them without reserving them, so they could be
   * opened again.
   */
  unregisteredIds: number;
  /**
   * Runs created before their own parent: a link whose parent id was reused
   * before the registry existed, so it names an unrelated run.
   */
  childrenOlderThanParent: number;
}

/**
 * The run id registry's health for `smrt doctor --db`: diagnostic only, it
 * writes nothing. Zero on both counts means every referenced id is
 * reserved and no parent link predates a reuse.
 */
export async function checkAiRunIdRegistry(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<AiRunIdRegistryCheck> {
  const unregistered = new Set<string>();
  for (const [table, column] of RUN_ID_SOURCES) {
    if (table === '_smrt_ai_runs' && column === 'id') continue;
    if (!(await tableExists(db, table, typeHint))) continue;
    const alias = table === '_smrt_ai_runs' ? 'src' : table;
    for await (const page of distinctIds(
      db,
      table === '_smrt_ai_runs' ? '_smrt_ai_runs src' : table,
      `${alias}.${column}`,
      ` AND NOT EXISTS (SELECT 1 FROM _smrt_ai_runs r WHERE r.id = ${alias}.${column})`,
    )) {
      const digests = await Promise.all(page.map(aiRunIdDigest));
      const known = new Set(
        getRows(
          await aiRunQuery(
            db,
            `SELECT id_digest FROM _smrt_ai_run_ids
              WHERE id_digest IN (${digests.map((_, i) => `$${i + 1}`).join(', ')})`,
            ...digests,
          ),
        ).map((row) => String(row.id_digest)),
      );
      page.forEach((id, i) => {
        if (!known.has(digests[i] as string)) unregistered.add(id);
      });
    }
  }
  const older = getRows(
    await aiRunQuery(
      db,
      `SELECT COUNT(*) AS n FROM _smrt_ai_runs c
         JOIN _smrt_ai_runs p ON p.id = c.parent_run_id
        WHERE c.created_at < p.created_at`,
    ),
  )[0];
  return {
    unregisteredIds: unregistered.size,
    childrenOlderThanParent: num(older?.n),
  };
}
