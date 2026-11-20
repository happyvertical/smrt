/**
 * Both retention passes recheck the candidate's tenant and age under the
 * destructive lock (docs/content/ai-runs.md section 8): a run id pruned and
 * reused by another tenant, or refreshed, between selection and the delete
 * is not touched. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAiRunEvent,
  finishAiRun,
  getAiRun,
  openAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
} from '../system/browser';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T12:00:00Z');

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (db: DatabaseInterface, tenantId: string) => ({
  db,
  usageTracking: true,
  tenantId,
});

type Exec = (sql: string, ...params: unknown[]) => Promise<unknown>;

/** Another tenant now holds this run id. */
const reuse = (runId: string) => (exec: Exec) =>
  exec(
    "UPDATE _smrt_ai_runs SET tenant_id = 'tenant-two' WHERE id = $1",
    runId,
  );

async function eventCount(db: DatabaseInterface, runId: string) {
  return rowsOf(
    await db.query(
      'SELECT id FROM _smrt_ai_run_events WHERE run_id = $1',
      runId,
    ),
  ).length;
}

/** A finished run of tenant-one, old enough for both retention passes. */
async function expiredRun(db: DatabaseInterface) {
  const run = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
  await appendAiRunEvent(db, run.id, {
    type: 'observation',
    payload: { note: 'kept' },
  });
  await finishAiRun(db, run.id, { status: 'done' });
  await db.query(
    'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
    new Date(NOW.getTime() - 200 * DAY).toISOString(),
    run.id,
  );
  return run;
}

describe.each(aiRunTestEngines)('retention rechecks on %s', (engine) => {
  describe.each([
    ['tenant', reuse],
    [
      'age',
      (runId: string) => (exec: Exec) =>
        exec(
          'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
          NOW.toISOString(),
          runId,
        ),
    ],
  ] as const)('a candidate whose %s changed before the destructive lock', (_, change) => {
    it('keeps the trajectory of a run that changed hands or was refreshed', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await expiredRun(db);
      const restore = beforeStatement(
        db,
        (sql, params) =>
          sql.includes('r.trajectory_pruned = 0') && params[0] === run.id,
        change(run.id),
      );
      expect(
        await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
      ).toEqual({ pruned: 0 });
      restore();
      expect((await getAiRun(db, run.id))?.trajectoryPruned).toBe(false);
      expect(await eventCount(db, run.id)).toBe(1);
    });

    it('keeps the run row of a run that changed hands or was refreshed', async () => {
      const db = await newAiRunTestDatabase(engine);
      const run = await expiredRun(db);
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW });
      expect((await getAiRun(db, run.id))?.trajectoryPruned).toBe(true);
      const restore = beforeStatement(
        db,
        (sql, params) =>
          sql.includes('r.trajectory_pruned <> 0') && params[0] === run.id,
        change(run.id),
      );
      expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
        pruned: 0,
      });
      restore();
      expect(await getAiRun(db, run.id)).not.toBeNull();
    });
  });

  it('prunes an expired run both passes when nothing changed (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await expiredRun(db);
    expect(
      await pruneAiRunTrajectories(db, { maxAgeMs: 30 * DAY, now: NOW }),
    ).toEqual({ pruned: 1 });
    expect(await pruneAiRuns(db, { maxAgeMs: 90 * DAY, now: NOW })).toEqual({
      pruned: 1,
    });
    expect(await getAiRun(db, run.id)).toBeNull();
  });
});
