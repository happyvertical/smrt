/**
 * PostgreSQL lane for AI run accounting concurrency (#5005): reservations
 * from many pooled connections against one shared ancestor (root-first row
 * locks, `FOR UPDATE` one statement per row), concurrent event appenders
 * (`seq` allocated under the run row lock, `UNIQUE (run_id, seq)`), and
 * settlements racing a reconciliation of the same call.
 *
 * Runs only when `SMRT_TEST_POSTGRES_URL` is set; point it at a DISPOSABLE
 * database (the test deletes AI run rows).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendAiRunEvent,
  getAiRun,
  openAiRun,
  reconcileAiCall,
  reserveAiCall,
  settleAiCall,
} from '../system/browser';
import { getTestDatabase } from '../testing/database';
import { usageEvent } from './fixtures/ai-run-test-db';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('AI run accounting on PostgreSQL (#5005)', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-5005-accounting',
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

  it('never overspends a shared root under concurrent reservations of its children', async () => {
    const root = await openAiRun(store(), {
      type: 'workflow',
      budget: { maxCalls: 12 },
    });
    const children = await Promise.all(
      [0, 1, 2, 3].map(() =>
        openAiRun(store(), { type: 'turn', parentRunId: root.id }),
      ),
    );
    const grandchildren = await Promise.all(
      children.map((child) =>
        openAiRun(store(), { type: 'fusion', parentRunId: child.id }),
      ),
    );
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, (_, i) =>
        reserveAiCall(
          db,
          (i % 2 ? children : grandchildren)[i % 4]?.id as string,
          { inputTokens: 1 },
        ),
      ),
    );
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    expect(ok).toBeLessThanOrEqual(12);
    expect((await getAiRun(db, root.id))?.reservedCalls).toBe(ok);
  });

  it('allocates a unique seq for concurrent appenders of one run', async () => {
    const run = await openAiRun(store(), { type: 'turn' });
    const appended = await Promise.all(
      Array.from({ length: 50 }, () =>
        appendAiRunEvent(db, run.id, { type: 'action' }),
      ),
    );
    expect(new Set(appended.map((event) => event.seq)).size).toBe(50);
    expect(Math.max(...appended.map((event) => event.seq))).toBe(50);
  });

  it('charges a call once when its settlement races a reconciliation', async () => {
    const run = await openAiRun(store(), { type: 'turn' });
    const held = await reserveAiCall(db, run.id, { inputTokens: 10 });
    await Promise.allSettled([
      settleAiCall(db, {
        runId: run.id,
        callId: held.callId,
        usage: usageEvent(25),
      }),
      reconcileAiCall(db, run.id, held.callId),
      settleAiCall(db, {
        runId: run.id,
        callId: held.callId,
        usage: usageEvent(25),
      }),
    ]);
    const after = await getAiRun(db, run.id);
    expect(after).toMatchObject({ calls: 1, tokens: 25, reservedCalls: 0 });
  });
});
