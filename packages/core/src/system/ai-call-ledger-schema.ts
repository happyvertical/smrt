/**
 * The 1.21.0 cutover of the AI call ledger (#5516; ai-runs page "Upgrading
 * to 1.21.0").
 *
 * Two renames close the AI tables to every older writer:
 * `_smrt_ai_run_events.reservation` becomes `call_state` (every 1.20.0
 * statement that reserves, settles, releases, abandons, sweeps or prunes a
 * trajectory names it) and `_smrt_ai_usage.duration` becomes `duration_ms`
 * (`NOT NULL` without a default, so every older usage insert either names
 * the old column or omits a required one; no compatibility pass of any
 * version adds `duration` back). Then the ledger's columns are added and the
 * DDL replay recreates the indexes.
 *
 * The events rename runs in one transaction that first takes the table's
 * lock (`ACCESS EXCLUSIVE` on PostgreSQL, the write transaction elsewhere),
 * so no reservation is inserted between the count and the rename. A
 * reservation the sweep would still treat as live (younger than the
 * smallest `callTimeoutMs` on its chain plus the grace, else than the stale
 * threshold) blocks it with `AI_RUN_CUTOVER_BLOCKED`, unless
 * {@link AI_RUN_CUTOVER_ABANDON_ENV} names the oldest live reservation on
 * this database, which abandons the live ones explicitly. Stale ones are
 * carried over as pre-1.21.0 reservations and counted in a warning.
 *
 * Internal: not re-exported by any entry point.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import { withEmbeddedWriteTransaction } from '../embedded-write-queue.js';
import { SmrtError } from '../smrt-error.js';
import { AI_RUN_SWEEP_DEFAULTS } from './ai-run-accounting.js';
import { getAiRun, readAiRunChainIds } from './ai-run-model.js';
import { getDatabaseEngine, tableExists } from './compatibility.js';

const logger = createLogger({ level: 'info' });

/** The bootstrap found a live reservation and changed nothing. */
export class AiRunCutoverBlockedError extends SmrtError {
  constructor(message: string, details: Record<string, unknown>) {
    super(message, 'AI_RUN_CUTOVER_BLOCKED', 'database', details);
  }
}

/**
 * The override: set to the event id `AI_RUN_CUTOVER_BLOCKED` named as the
 * oldest live reservation. It applies only while that reservation is still
 * the oldest live one on the database being bootstrapped.
 */
export const AI_RUN_CUTOVER_ABANDON_ENV = 'SMRT_AI_RUN_CUTOVER_ABANDON';

/**
 * The override's value, read only where `process` exists (the browser entry
 * never evaluates it).
 */
export function readAiRunCutoverOverride(
  source: {
    process?: { env?: Record<string, string | undefined> };
  } = globalThis as never,
): string | undefined {
  const env =
    typeof source.process === 'object' ? source.process?.env : undefined;
  const value = env?.[AI_RUN_CUTOVER_ABANDON_ENV];
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

type Engine = ReturnType<typeof getDatabaseEngine>;

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function hasColumn(
  db: DatabaseInterface,
  engine: Engine,
  table: string,
  column: string,
): Promise<boolean> {
  try {
    if (engine === 'postgres') {
      return (
        rowsOf(
          await db.query(
            'SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2 LIMIT 1',
            table,
            column,
          ),
        ).length > 0
      );
    }
    return rowsOf(await db.query(`PRAGMA table_info(${table})`)).some(
      (row) => row.name === column,
    );
  } catch {
    return false;
  }
}

/** DuckDB refuses to alter a table its explicit indexes depend on. */
async function dropDuckDbIndexes(db: DatabaseInterface, table: string) {
  const indexes = rowsOf(
    await db.query(
      'SELECT index_name FROM duckdb_indexes() WHERE table_name = $1',
      table,
    ),
  );
  for (const row of indexes) {
    await db.query(`DROP INDEX IF EXISTS ${String(row.index_name)}`);
  }
}

/**
 * The ledger's columns on `_smrt_ai_run_events` (and the record of refused
 * late amounts on `_smrt_ai_runs`), typed as the fresh DDL types them on
 * each engine.
 */
function ledgerColumns(engine: Engine): Array<[string, string, string]> {
  const integer = engine === 'sqlite' ? 'INTEGER' : 'BIGINT';
  const timestamp = engine === 'postgres' ? 'TIMESTAMPTZ' : 'TIMESTAMP';
  return [
    ['_smrt_ai_run_events', 'call_proof', 'TEXT'],
    ['_smrt_ai_run_events', 'call_row', 'TEXT'],
    ['_smrt_ai_run_events', 'call_rate', 'TEXT'],
    ['_smrt_ai_run_events', 'call_usage', 'TEXT'],
    ['_smrt_ai_run_events', 'ended_at', timestamp],
    ['_smrt_ai_run_events', 'usage_source', 'TEXT'],
    ['_smrt_ai_run_events', 'charged_tokens', integer],
    ['_smrt_ai_run_events', 'charged_cost', 'DOUBLE PRECISION'],
    ['_smrt_ai_runs', 'refused_usage', 'TEXT'],
  ];
}

/** Whether both renamed columns exist: the fast path's second condition. */
export async function aiCallLedgerColumnsPresent(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<boolean> {
  const engine = getDatabaseEngine(db, typeHint);
  return (
    (await hasColumn(db, engine, '_smrt_ai_run_events', 'call_state')) &&
    (await hasColumn(db, engine, '_smrt_ai_usage', 'duration_ms'))
  );
}

interface ReservedCall {
  id: string;
  runId: string;
  callId: string;
  createdAt: number;
  reservedTokens: number;
  reservedCost: number;
}

/** The sweep's threshold for one reservation's chain. */
async function thresholdOf(
  db: DatabaseInterface,
  runId: string,
  cache: Map<string, number>,
): Promise<number> {
  const known = cache.get(runId);
  if (known !== undefined) return known;
  let timeout: number | undefined;
  try {
    for (const id of await readAiRunChainIds(db, runId)) {
      const value = (await getAiRun(db, id))?.budget.callTimeoutMs;
      if (value !== undefined && (timeout === undefined || value < timeout)) {
        timeout = value;
      }
    }
  } catch {
    timeout = undefined;
  }
  const threshold =
    timeout !== undefined
      ? timeout + AI_RUN_SWEEP_DEFAULTS.graceMs
      : AI_RUN_SWEEP_DEFAULTS.staleReservationMs;
  cache.set(runId, threshold);
  return threshold;
}

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  const parsed = new Date(String(value)).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Return a live reservation's room to its chain and mark it abandoned. */
async function abandonReservation(
  db: DatabaseInterface,
  call: ReservedCall,
): Promise<void> {
  const moved = rowsOf(
    await db.query(
      `UPDATE _smrt_ai_run_events SET reservation = 'abandoned', status = 'abandoned'
        WHERE id = $1 AND reservation = 'reserved' RETURNING id`,
      call.id,
    ),
  );
  if (moved.length === 0) return;
  let chain: string[] = [call.runId];
  try {
    chain = await readAiRunChainIds(db, call.runId);
  } catch {
    // A run that is gone has no totals to return the room to.
  }
  for (const runId of chain) {
    await db.query(
      `UPDATE _smrt_ai_runs
          SET reserved_calls = reserved_calls - 1,
              reserved_tokens = reserved_tokens - $2,
              reserved_cost = reserved_cost - $3
        WHERE id = $1`,
      runId,
      call.reservedTokens,
      call.reservedCost,
    );
  }
}

/** Count, decide and rename, on a handle that holds the table's lock. */
async function renameEventsLocked(
  db: DatabaseInterface,
  engine: Engine,
): Promise<void> {
  if (engine === 'postgres') {
    await db.query('LOCK TABLE _smrt_ai_run_events IN ACCESS EXCLUSIVE MODE');
  }
  // Rechecked under the lock: a concurrent bootstrap may have renamed it.
  if (!(await hasColumn(db, engine, '_smrt_ai_run_events', 'reservation'))) {
    return;
  }
  const now = Date.now();
  const reserved: ReservedCall[] = rowsOf(
    await db.query(
      `SELECT id, run_id, call_id, created_at, reserved_tokens, reserved_cost
         FROM _smrt_ai_run_events
        WHERE type = 'call' AND reservation = 'reserved'
        ORDER BY created_at, id`,
    ),
  ).map((row) => ({
    id: String(row.id),
    runId: String(row.run_id),
    callId: String(row.call_id),
    createdAt: timeOf(row.created_at),
    reservedTokens: Number(row.reserved_tokens ?? 0),
    reservedCost: Number(row.reserved_cost ?? 0),
  }));
  const thresholds = new Map<string, number>();
  const live: ReservedCall[] = [];
  let stale = 0;
  for (const call of reserved) {
    const threshold = await thresholdOf(db, call.runId, thresholds);
    if (call.createdAt > now - threshold) live.push(call);
    else stale++;
  }
  if (live.length > 0) {
    const oldest = live[0] as ReservedCall;
    if (readAiRunCutoverOverride() !== oldest.id) {
      throw new AiRunCutoverBlockedError(
        `The 1.21.0 AI call ledger cutover is blocked: ${live.length} AI call reservation(s) are still live (oldest ${oldest.id}, ${Math.round(
          (now - oldest.createdAt) / 1000,
        )}s old). Stop every older worker and retry; for a worker that crashed, wait out the call's timeout or set ${AI_RUN_CUTOVER_ABANDON_ENV}=${oldest.id}.`,
        {
          count: live.length,
          oldestEventId: oldest.id,
          oldestCallId: oldest.callId,
          oldestAgeMs: now - oldest.createdAt,
        },
      );
    }
    for (const call of live) await abandonReservation(db, call);
    logger.warn(
      `[smrt] 1.21.0 cutover: ${AI_RUN_CUTOVER_ABANDON_ENV} abandoned ${live.length} live AI call reservation(s): ${live
        .map((call) => call.id)
        .join(', ')}`,
    );
  }
  if (stale > 0) {
    logger.warn(
      `[smrt] 1.21.0 cutover: ${stale} stale AI call reservation(s) carried over as pre-1.21.0 calls; the sweep settles or abandons them`,
    );
  }
  if (engine === 'duckdb') await dropDuckDbIndexes(db, '_smrt_ai_run_events');
  await db.query(
    'ALTER TABLE _smrt_ai_run_events RENAME COLUMN reservation TO call_state',
  );
}

/**
 * Bring `_smrt_ai_run_events`, `_smrt_ai_usage` and `_smrt_ai_runs` to the
 * 1.21.0 shape. Every step is guarded by a column probe, so an interrupted
 * bootstrap converges when it runs again; the DDL replay that follows
 * recreates the indexes.
 */
export async function ensureAiCallLedgerCutover(
  db: DatabaseInterface,
  typeHint?: string,
): Promise<void> {
  const engine = getDatabaseEngine(db, typeHint);
  if (
    (await tableExists(db, '_smrt_ai_run_events', typeHint)) &&
    (await hasColumn(db, engine, '_smrt_ai_run_events', 'reservation')) &&
    !(await hasColumn(db, engine, '_smrt_ai_run_events', 'call_state'))
  ) {
    if (engine === 'postgres') {
      // The bootstrap's own transaction: the lock is held until it commits.
      await renameEventsLocked(db, engine);
    } else {
      await withEmbeddedWriteTransaction(db, true, (bound) =>
        renameEventsLocked(bound, engine),
      );
    }
  }
  if (
    (await tableExists(db, '_smrt_ai_usage', typeHint)) &&
    (await hasColumn(db, engine, '_smrt_ai_usage', 'duration')) &&
    !(await hasColumn(db, engine, '_smrt_ai_usage', 'duration_ms'))
  ) {
    if (engine === 'duckdb') await dropDuckDbIndexes(db, '_smrt_ai_usage');
    await db.query(
      'ALTER TABLE _smrt_ai_usage RENAME COLUMN duration TO duration_ms',
    );
  }
  for (const [table, column, definition] of ledgerColumns(engine)) {
    if (!(await tableExists(db, table, typeHint))) continue;
    if (await hasColumn(db, engine, table, column)) continue;
    await db.query(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
