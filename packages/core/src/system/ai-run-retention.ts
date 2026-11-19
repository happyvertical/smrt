/**
 * Retention of AI runs (#5005; docs/content/ai-runs.md section 8).
 *
 * Two periods apply to a finished run:
 *
 * - **The trajectory** (its events) is kept whole for `maxAgeMs` after the
 *   run finishes (30 days by default) and then deleted whole. Before the
 *   events are deleted, the run's check and approval counts are saved on its
 *   row and `trajectory_pruned` is set, in the same transaction. With
 *   sampling on, a run outside the sample loses its trajectory as soon as it
 *   is finished; the decision is made once per run, from its id.
 * - **The row** is pruned together with its usage rows by the usage age
 *   limit (90 days by default), counting from `finished_at`, and never while
 *   its trajectory is still kept.
 *
 * A protected run is never pruned: one that is `running`, `waiting-approval`
 * or a durable `stopped`, one in an experiment, and one with `retain` set.
 * Protection is inherited, and a child is never pruned before its parent: a
 * child's trajectory goes only once its parent's is gone, and its row only
 * once its parent's row is. A run with a call still reserved keeps its
 * events, so a late settlement still finds its reservation.
 *
 * The checkpoint of a `done` or `cancelled` run goes with its trajectory;
 * the checkpoint of a `failed` run stays as long as its row, so the run can
 * still be retried. `payload_ref` points at content the host owns: pruning
 * deletes the events, never what they point at. Evaluations are never
 * swept.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type AiRunTxOptions,
  aiRunQuery,
  forUpdate,
  getRows,
  num,
  withAiRunTransaction,
} from './ai-run-model.js';

/** Defaults of AI run retention (page section 8). */
export const AI_RUN_RETENTION_DEFAULTS = Object.freeze({
  /** A finished run's trajectory is kept this long. */
  trajectoryMaxAgeDays: 30,
  /** Runs examined per page. */
  batch: 500,
});

/** Options of {@link pruneAiRunTrajectories}. */
export interface AiRunTrajectoryRetention {
  /** Keep a finished run's trajectory this long after `finished_at`. */
  maxAgeMs: number;
  /**
   * Sampling: the share of runs (0 to 1) whose trajectory is kept for the
   * period. A run outside the sample loses it as soon as it is finished.
   * Default 1 (every run). Decided once per run, from its id.
   */
  sampleRate?: number;
  /** One tenant (`null`: global runs); omit for every tenant. */
  tenantId?: string | null;
  dryRun?: boolean;
  now?: Date;
  batch?: number;
}

/** Options of {@link pruneAiRuns}. */
export interface AiRunsRetention {
  /** The usage age limit: rows of runs finished longer ago than this go. */
  maxAgeMs: number;
  /** One tenant (`null`: global runs); omit for every tenant. */
  tenantId?: string | null;
  dryRun?: boolean;
  now?: Date;
  batch?: number;
}

/**
 * Whether a run is in the trajectory sample: a stable function of its id,
 * so the decision is the same at every sweep.
 */
export function isAiRunTrajectorySampled(
  runId: string,
  sampleRate: number,
): boolean {
  if (!(sampleRate < 1)) return true;
  if (!(sampleRate > 0)) return false;
  // FNV-1a over the id, as a fraction of 2^32.
  let hash = 0x811c9dc5;
  for (let i = 0; i < runId.length; i++) {
    hash ^= runId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash / 0x1_0000_0000 < sampleRate;
}

/** SQL: the run `r` is unprotected and final (page section 8). */
const UNPROTECTED = `r.finished_at IS NOT NULL
  AND r.experiment_id IS NULL
  AND r.retain = 0
  AND (r.status IN ('done', 'failed', 'cancelled')
       OR (r.status = 'stopped'
           AND NOT EXISTS (SELECT 1 FROM _smrt_ai_run_checkpoints c
                            WHERE c.run_id = r.id)))`;

function tenantCondition(
  scope: { tenantId?: string | null },
  params: unknown[],
): string {
  if (scope.tenantId === undefined) return '';
  if (scope.tenantId === null) return ' AND r.tenant_id IS NULL';
  params.push(scope.tenantId);
  return ` AND r.tenant_id = $${params.length}`;
}

function checkAge(fn: string, maxAgeMs: number): void {
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
    throw new Error(`${fn} maxAgeMs must be >= 0, got ${maxAgeMs}`);
  }
}

/**
 * Delete the trajectories of finished, unprotected runs past the period (or
 * outside the sample), top down: a run whose parent still keeps its
 * trajectory waits for it. Each run is one transaction that saves its check
 * and approval counts on its row, sets `trajectory_pruned`, deletes its
 * events and (unless it `failed`) its checkpoint. Returns the runs pruned
 * (or, under `dryRun`, that would be).
 */
export async function pruneAiRunTrajectories(
  db: DatabaseInterface,
  retention: AiRunTrajectoryRetention,
  options: AiRunTxOptions = {},
): Promise<{ pruned: number }> {
  checkAge('pruneAiRunTrajectories', retention.maxAgeMs);
  const now = retention.now ?? new Date();
  const sampleRate = retention.sampleRate ?? 1;
  if (!(sampleRate >= 0 && sampleRate <= 1)) {
    throw new Error(
      `pruneAiRunTrajectories sampleRate must be within 0..1, got ${sampleRate}`,
    );
  }
  const cutoff = new Date(now.getTime() - retention.maxAgeMs).toISOString();
  const batch = retention.batch ?? AI_RUN_RETENTION_DEFAULTS.batch;
  const sampling = sampleRate < 1;
  const done = new Set<string>();
  const skipped = new Set<string>();
  // Top down: each round frees the children of the runs the last one pruned.
  for (let round = 0; round < 64; round++) {
    let progressed = false;
    let lastId: string | null = null;
    for (;;) {
      const params: unknown[] = [sampling ? now.toISOString() : cutoff];
      let where = `r.trajectory_pruned = 0 AND ${UNPROTECTED}
        AND r.finished_at < $1
        AND NOT EXISTS (SELECT 1 FROM _smrt_ai_run_events e
                         WHERE e.run_id = r.id AND e.type = 'call'
                           AND e.reservation = 'reserved')`;
      where += tenantCondition(retention, params);
      if (lastId !== null) {
        params.push(lastId);
        where += ` AND r.id > $${params.length}`;
      }
      params.push(batch);
      const page = getRows(
        await aiRunQuery(
          db,
          `SELECT r.id, r.parent_run_id, r.finished_at, p.id AS parent_id,
                  p.trajectory_pruned AS parent_pruned
             FROM _smrt_ai_runs r
             LEFT JOIN _smrt_ai_runs p ON p.id = r.parent_run_id
                  AND (p.tenant_id = r.tenant_id
                       OR (p.tenant_id IS NULL AND r.tenant_id IS NULL))
            WHERE ${where}
            ORDER BY r.id LIMIT $${params.length}`,
          ...params,
        ),
      );
      if (page.length === 0) break;
      lastId = String(page[page.length - 1]?.id);
      for (const row of page) {
        const id = String(row.id);
        if (done.has(id) || skipped.has(id)) continue;
        const parent =
          row.parent_run_id === null ? null : String(row.parent_run_id);
        const parentGone =
          parent === null ||
          row.parent_id === null ||
          row.parent_id === undefined ||
          num(row.parent_pruned) !== 0 ||
          row.parent_pruned === true ||
          done.has(parent);
        if (!parentGone) continue;
        const finished = new Date(String(row.finished_at)).getTime();
        const expired = finished < new Date(cutoff).getTime();
        if (!expired && isAiRunTrajectorySampled(id, sampleRate)) continue;
        if (retention.dryRun) {
          done.add(id);
          progressed = true;
          continue;
        }
        const pruned = await pruneOneTrajectory(db, id, options);
        if (pruned) {
          done.add(id);
          progressed = true;
        } else {
          skipped.add(id);
        }
      }
      if (page.length < batch) break;
    }
    if (!progressed) break;
  }
  return { pruned: done.size };
}

async function pruneOneTrajectory(
  db: DatabaseInterface,
  runId: string,
  options: AiRunTxOptions,
): Promise<boolean> {
  return withAiRunTransaction(
    db,
    async (tx) => {
      const rows = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT r.id, r.status FROM _smrt_ai_runs r
            WHERE r.id = $1 AND r.trajectory_pruned = 0 AND ${UNPROTECTED}${forUpdate(tx)}`,
          runId,
        ),
      );
      const run = rows[0];
      if (!run) return false;
      const reserved = getRows(
        await aiRunQuery(
          tx.db,
          `SELECT 1 AS x FROM _smrt_ai_run_events
            WHERE run_id = $1 AND type = 'call' AND reservation = 'reserved'
            LIMIT 1`,
          runId,
        ),
      );
      if (reserved.length > 0) return false;
      const counts = { passed: 0, failed: 0, approved: 0, refused: 0 };
      for (const row of getRows(
        await aiRunQuery(
          tx.db,
          `SELECT type, status, COUNT(*) AS n FROM _smrt_ai_run_events
            WHERE run_id = $1 AND type IN ('check', 'approval')
            GROUP BY type, status`,
          runId,
        ),
      )) {
        const n = num(row.n);
        const key = `${String(row.type)}:${String(row.status)}`;
        if (key === 'check:passed') counts.passed += n;
        else if (key === 'check:failed') counts.failed += n;
        // A decision counts in the run that recorded it; a request never.
        else if (key === 'approval:approved') counts.approved += n;
        else if (key === 'approval:refused') counts.refused += n;
      }
      // The counts are saved before the events go, in this transaction.
      await aiRunQuery(
        tx.db,
        `UPDATE _smrt_ai_runs
            SET checks_passed = $2, checks_failed = $3, approvals_given = $4,
                approvals_refused = $5, trajectory_pruned = 1
          WHERE id = $1`,
        runId,
        counts.passed,
        counts.failed,
        counts.approved,
        counts.refused,
      );
      await aiRunQuery(
        tx.db,
        'DELETE FROM _smrt_ai_run_events WHERE run_id = $1',
        runId,
      );
      if (String(run.status) !== 'failed') {
        await aiRunQuery(
          tx.db,
          'DELETE FROM _smrt_ai_run_checkpoints WHERE run_id = $1',
          runId,
        );
      }
      return true;
    },
    options,
  );
}

/**
 * Prune the rows of finished, unprotected runs whose trajectory is already
 * pruned, once `finished_at` is older than `maxAgeMs` (the usage age limit),
 * together with their usage rows, their checkpoint (a failed run's) and any
 * events left. Top down: a child's row waits for its parent's. Age only,
 * never row count. Returns the runs pruned (or, under `dryRun`, that would
 * be); usage rows deleted with them are not counted.
 */
export async function pruneAiRuns(
  db: DatabaseInterface,
  retention: AiRunsRetention,
  options: AiRunTxOptions = {},
): Promise<{ pruned: number }> {
  checkAge('pruneAiRuns', retention.maxAgeMs);
  const now = retention.now ?? new Date();
  const cutoff = new Date(now.getTime() - retention.maxAgeMs).toISOString();
  const batch = retention.batch ?? AI_RUN_RETENTION_DEFAULTS.batch;
  const done = new Set<string>();
  const skipped = new Set<string>();
  for (let round = 0; round < 64; round++) {
    let progressed = false;
    let lastId: string | null = null;
    for (;;) {
      const params: unknown[] = [cutoff];
      let where = `r.trajectory_pruned <> 0 AND ${UNPROTECTED}
        AND r.finished_at < $1`;
      where += tenantCondition(retention, params);
      if (lastId !== null) {
        params.push(lastId);
        where += ` AND r.id > $${params.length}`;
      }
      params.push(batch);
      const page = getRows(
        await aiRunQuery(
          db,
          `SELECT r.id, r.parent_run_id, p.id AS parent_id
             FROM _smrt_ai_runs r
             LEFT JOIN _smrt_ai_runs p ON p.id = r.parent_run_id
                  AND (p.tenant_id = r.tenant_id
                       OR (p.tenant_id IS NULL AND r.tenant_id IS NULL))
            WHERE ${where}
            ORDER BY r.id LIMIT $${params.length}`,
          ...params,
        ),
      );
      if (page.length === 0) break;
      lastId = String(page[page.length - 1]?.id);
      for (const row of page) {
        const id = String(row.id);
        if (done.has(id) || skipped.has(id)) continue;
        const parent =
          row.parent_run_id === null ? null : String(row.parent_run_id);
        const parentGone =
          parent === null ||
          row.parent_id === null ||
          row.parent_id === undefined ||
          done.has(parent);
        if (!parentGone) continue;
        if (retention.dryRun) {
          done.add(id);
          progressed = true;
          continue;
        }
        const pruned = await withAiRunTransaction(
          db,
          async (tx) => {
            const locked = getRows(
              await aiRunQuery(
                tx.db,
                `SELECT r.id, r.tenant_id FROM _smrt_ai_runs r
                  WHERE r.id = $1 AND r.trajectory_pruned <> 0
                    AND ${UNPROTECTED}${forUpdate(tx)}`,
                id,
              ),
            );
            if (!locked[0]) return false;
            const tenantId =
              locked[0].tenant_id === null || locked[0].tenant_id === undefined
                ? null
                : String(locked[0].tenant_id);
            for (const table of [
              '_smrt_ai_run_events',
              '_smrt_ai_run_checkpoints',
            ]) {
              await aiRunQuery(
                tx.db,
                `DELETE FROM ${table} WHERE run_id = $1`,
                id,
              );
            }
            // Only the run's own tenant's usage rows go with it: `run_id`
            // is not a foreign key, and a row of another tenant naming
            // this id is never this run's to delete.
            await aiRunQuery(
              tx.db,
              tenantId === null
                ? 'DELETE FROM _smrt_ai_usage WHERE run_id = $1 AND tenant_id IS NULL'
                : 'DELETE FROM _smrt_ai_usage WHERE run_id = $1 AND tenant_id = $2',
              id,
              ...(tenantId === null ? [] : [tenantId]),
            );
            await aiRunQuery(
              tx.db,
              'DELETE FROM _smrt_ai_runs WHERE id = $1',
              id,
            );
            return true;
          },
          options,
        );
        if (pruned) {
          done.add(id);
          progressed = true;
        } else {
          skipped.add(id);
        }
      }
      if (page.length < batch) break;
    }
    if (!progressed) break;
  }
  return { pruned: done.size };
}
