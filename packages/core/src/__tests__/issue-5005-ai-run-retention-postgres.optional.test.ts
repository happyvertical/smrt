/**
 * PostgreSQL lane for the #5005 cancel cascade and run retention: a cancel
 * racing the reservations of its descendants (each reservation commits
 * before the cancel and settles, or after it and is refused; the subtree
 * lock follows depth-then-id order, so nothing deadlocks), and trajectory
 * and row pruning racing a late settlement of the same run.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database (the test deletes AI run rows).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AiRunStoppedError,
  cancelAiRun,
  getAiRun,
  openAiRun,
  pruneAiRuns,
  pruneAiRunTrajectories,
  reserveAiCall,
  settleAiCall,
} from '../system/browser';
import { getTestDatabase } from '../testing/database';
import { usageEvent } from './fixtures/ai-run-test-db';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)(
  'AI run cancel and retention on PostgreSQL (#5005)',
  () => {
    let db: DatabaseInterface;

    beforeAll(async () => {
      db = (await getDatabase({
        type: 'postgres',
        url: pgUrl,
        dbid: 'smrt-test-5005-retention',
      } as Parameters<typeof getDatabase>[0])) as DatabaseInterface;
      await getTestDatabase({ db, classes: [] });
    });

    afterAll(async () => {
      if (!db) return;
      await db.query('DELETE FROM _smrt_ai_run_events');
      await db.query('DELETE FROM _smrt_ai_run_checkpoints');
      await db.query('DELETE FROM _smrt_ai_runs');
      await db.query('DELETE FROM _smrt_ai_usage');
    });

    const store = () => ({ db, usageTracking: true });

    it('cancels a subtree while its descendants reserve, charging each sent call once', async () => {
      const root = await openAiRun(store(), {
        type: 'workflow',
        durable: true,
      });
      const children = await Promise.all(
        [0, 1, 2].map(() =>
          openAiRun(store(), { type: 'turn', parentRunId: root.id }),
        ),
      );
      const grandchildren = await Promise.all(
        children.map((child) =>
          openAiRun(store(), { type: 'fusion', parentRunId: child.id }),
        ),
      );
      const reservations = [...children, ...grandchildren].flatMap((run) =>
        [0, 1].map(() =>
          reserveAiCall(db, run.id, { inputTokens: 1, outputLimit: 1 }).then(
            (held) => ({ run: run.id, held }),
            (error: unknown) => {
              expect(error).toBeInstanceOf(AiRunStoppedError);
              return null;
            },
          ),
        ),
      );
      const [cancelled, ...outcomes] = await Promise.all([
        cancelAiRun(db, root.id),
        ...reservations,
      ]);
      expect(cancelled?.status).toBe('cancelled');
      for (const run of [...children, ...grandchildren]) {
        expect((await getAiRun(db, run.id))?.status).toBe('cancelled');
      }
      let sent = 0;
      for (const outcome of outcomes) {
        if (!outcome) continue;
        sent++;
        await settleAiCall(db, {
          runId: outcome.run,
          callId: outcome.held.callId,
          usage: usageEvent(2),
        });
      }
      expect(await getAiRun(db, root.id)).toMatchObject({
        inclusiveCalls: sent,
        reservedCalls: 0,
      });
    });

    it('keeps a trajectory while a call is reserved, and prunes it once settled', async () => {
      const run = await openAiRun(store(), { type: 'turn' });
      const held = await reserveAiCall(db, run.id, { inputTokens: 1 });
      await cancelAiRun(db, run.id);
      const later = new Date(Date.now() + 60_000);
      const [pruned] = await Promise.all([
        pruneAiRunTrajectories(db, { maxAgeMs: 0, now: later }),
        settleAiCall(db, {
          runId: run.id,
          callId: held.callId,
          usage: usageEvent(3),
        }),
      ]);
      // Either the prune saw the reservation and waited, or it ran after
      // the settlement; the call is charged exactly once either way.
      if (pruned.pruned === 0) {
        await pruneAiRunTrajectories(db, { maxAgeMs: 0, now: later });
      }
      expect(await getAiRun(db, run.id)).toMatchObject({
        trajectoryPruned: true,
        calls: 1,
        tokens: 3,
      });
      expect(
        (await pruneAiRuns(db, { maxAgeMs: 0, now: later })).pruned,
      ).toBeGreaterThanOrEqual(1);
      expect(await getAiRun(db, run.id)).toBeNull();
    });
  },
);
