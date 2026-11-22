/**
 * The trajectory pass rechecks each candidate under its destructive lock
 * with the same age bound that selected it, sample membership included
 * (docs/content/ai-runs.md section 8): a run in the sample is pruned only
 * while it still finished before the cutoff; a run outside the sample loses
 * its trajectory as soon as it is finished. Real SQLite and DuckDB (PGlite
 * in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appendAiRunEvent,
  finishAiRun,
  getAiRun,
  isAiRunTrajectorySampled,
  openAiRun,
  pruneAiRunTrajectories,
} from '../system/browser';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
} from './fixtures/ai-run-test-db';

const DAY = 86_400_000;
const NOW = new Date('2026-11-14T12:00:00Z');
const WINDOW = 30 * DAY;

afterEach(async () => {
  await closeAiRunTestDatabases();
});

/** An id inside (or outside) the sample at this rate. */
function sampledId(rate: number, inSample: boolean): string {
  for (let i = 0; ; i++) {
    const id = `ret-${inSample ? 'in' : 'out'}-${i}`;
    if (isAiRunTrajectorySampled(id, rate) === inSample) return id;
  }
}

async function finishedRun(
  db: DatabaseInterface,
  id: string,
  finishedAt: Date,
) {
  await openAiRun(
    { db, usageTracking: true, tenantId: 't1' },
    { id, type: 'turn' },
  );
  await appendAiRunEvent(db, id, { type: 'observation', payload: { n: 1 } });
  await finishAiRun(db, id, { status: 'done' });
  await db.query(
    'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
    finishedAt.toISOString(),
    id,
  );
}

/** Move `finished_at` just before the candidate's destructive lock. */
function refreshBeforeLock(db: DatabaseInterface, id: string, to: Date | null) {
  return beforeStatement(
    db,
    (sql, params) =>
      sql.includes('r.trajectory_pruned = 0') &&
      sql.includes('FROM _smrt_ai_runs r WHERE r.id = $1') &&
      params[0] === id,
    (exec) =>
      to === null
        ? exec(
            "UPDATE _smrt_ai_runs SET finished_at = NULL, status = 'running' WHERE id = $1",
            id,
          )
        : exec(
            'UPDATE _smrt_ai_runs SET finished_at = $1 WHERE id = $2',
            to.toISOString(),
            id,
          ),
  );
}

const pruned = async (db: DatabaseInterface, id: string) =>
  (await getAiRun(db, id))?.trajectoryPruned;

describe.each(aiRunTestEngines)('sampled retention recheck on %s', (engine) => {
  it('keeps the trajectory of a sampled run refreshed inside the window', async () => {
    const db = await newAiRunTestDatabase(engine);
    const id = sampledId(0.5, true);
    await finishedRun(db, id, new Date(NOW.getTime() - 200 * DAY));
    const restore = refreshBeforeLock(
      db,
      id,
      new Date(NOW.getTime() - WINDOW / 2),
    );
    await pruneAiRunTrajectories(db, {
      maxAgeMs: WINDOW,
      sampleRate: 0.5,
      now: NOW,
    });
    restore();
    expect(await pruned(db, id)).toBe(false);
  });

  it('still prunes an unsampled run refreshed the same way (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const id = sampledId(0.5, false);
    await finishedRun(db, id, new Date(NOW.getTime() - 200 * DAY));
    const restore = refreshBeforeLock(
      db,
      id,
      new Date(NOW.getTime() - WINDOW / 2),
    );
    await pruneAiRunTrajectories(db, {
      maxAgeMs: WINDOW,
      sampleRate: 0.5,
      now: NOW,
    });
    restore();
    expect(await pruned(db, id)).toBe(true);
  });

  it('at rate 1 keeps a run refreshed strictly inside the window (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const id = 'ret-rate-one';
    await finishedRun(db, id, new Date(NOW.getTime() - 200 * DAY));
    const restore = refreshBeforeLock(
      db,
      id,
      new Date(NOW.getTime() - WINDOW / 3),
    );
    await pruneAiRunTrajectories(db, { maxAgeMs: WINDOW, now: NOW });
    restore();
    expect(await pruned(db, id)).toBe(false);
  });

  it('keeps a run finished exactly at the cutoff (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const id = sampledId(0.5, true);
    await finishedRun(db, id, new Date(NOW.getTime() - WINDOW));
    await pruneAiRunTrajectories(db, {
      maxAgeMs: WINDOW,
      sampleRate: 0.5,
      now: NOW,
    });
    expect(await pruned(db, id)).toBe(false);
  });

  it('keeps a run resumed between selection and lock (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const id = sampledId(0.5, false);
    await finishedRun(db, id, new Date(NOW.getTime() - 200 * DAY));
    const restore = refreshBeforeLock(db, id, null);
    await pruneAiRunTrajectories(db, {
      maxAgeMs: WINDOW,
      sampleRate: 0.5,
      now: NOW,
    });
    restore();
    expect(await pruned(db, id)).toBe(false);
  });
});
