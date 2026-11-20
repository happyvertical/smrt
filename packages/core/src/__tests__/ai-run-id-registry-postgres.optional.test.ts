/**
 * PostgreSQL lane for run identity (docs/content/ai-runs.md section 8, "Run
 * identity"): opens of one id from pooled connections, an open racing a
 * prune, and a totals check racing a settle and a prune, each from
 * independent connections. Runs only when `SMRT_TEST_POSTGRES_URL` is set;
 * point it at a DISPOSABLE database (the test deletes AI run rows).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { aiRunIdDigest, getRows } from '../system/ai-run-model';
import {
  AiRunIdUsedError,
  AiRunNotFoundError,
  checkAiRunTotals,
  finishAiRun,
  openAiRun,
  pruneAiRuns,
  reserveAiCall,
  settleAiCall,
} from '../system/browser';
import { getTestDatabase } from '../testing/database';
import { usageEvent } from './fixtures/ai-run-test-db';

const pgUrl = process.env.SMRT_TEST_POSTGRES_URL;

describe.skipIf(!pgUrl)('run identity on PostgreSQL', () => {
  let db: DatabaseInterface;

  beforeAll(async () => {
    db = (await getDatabase({
      type: 'postgres',
      url: pgUrl,
      dbid: 'smrt-test-run-identity',
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

  const store = (tenantId: string | null = 't1') => ({
    db,
    usageTracking: true,
    tenantId,
  });

  it('concurrent opens of one id: one wins, the others are refused, no deadlock', async () => {
    for (let round = 0; round < 10; round++) {
      const id = `pg-contended-${round}-${crypto.randomUUID()}`;
      const results = await Promise.allSettled(
        ['t1', 't2', 't3', null].map((tenant) =>
          openAiRun(store(tenant), { id, type: 'turn' }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(AiRunIdUsedError);
        }
      }
    }
  });

  it('same-id opens under one parent do not deadlock, and one wins', async () => {
    const parent = await openAiRun(store(), { type: 'workflow' });
    for (let round = 0; round < 10; round++) {
      const id = `pg-sibling-${round}-${crypto.randomUUID()}`;
      const results = await Promise.allSettled(
        [0, 1, 2].map(() =>
          openAiRun(store(), { id, type: 'turn', parentRunId: parent.id }),
        ),
      );
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results) {
        if (r.status === 'rejected') {
          expect(r.reason).toBeInstanceOf(AiRunIdUsedError);
        }
      }
    }
  });

  it('an open racing a prune of a run without a registry row is refused, without deadlock', async () => {
    for (let round = 0; round < 10; round++) {
      const id = `pg-old-core-${round}-${crypto.randomUUID()}`;
      // An older core wrote this run without a registry row.
      await db.query(
        `INSERT INTO _smrt_ai_runs (id, type, tenant_id, status, budget,
           started_at, created_at, finished_at, trajectory_pruned)
         VALUES ($1, 'turn', 't1', 'done', '{}', $2, $2, $2, 1)`,
        id,
        '2000-01-01T00:00:00.000Z',
      );
      const [pruned, opened] = await Promise.allSettled([
        pruneAiRuns(db, { maxAgeMs: 0, tenantId: 't1' }),
        openAiRun(store('t2'), { id, type: 'turn' }),
      ]);
      // The prune itself succeeded and removed this row, keeping its digest:
      // the refusals below are the registry's, not a row the prune left.
      expect(pruned.status).toBe('fulfilled');
      expect(
        (pruned as PromiseFulfilledResult<{ pruned: number }>).value.pruned,
      ).toBeGreaterThanOrEqual(1);
      expect(
        getRows(
          await db.query('SELECT id FROM _smrt_ai_runs WHERE id = $1', id),
        ),
      ).toEqual([]);
      expect(
        getRows(
          await db.query(
            'SELECT id_digest FROM _smrt_ai_run_ids WHERE id_digest = $1',
            await aiRunIdDigest(id),
          ),
        ),
      ).toHaveLength(1);
      expect(opened.status).toBe('rejected');
      expect((opened as PromiseRejectedResult).reason).toBeInstanceOf(
        AiRunIdUsedError,
      );
      // After the prune, still refused.
      await expect(
        openAiRun(store('t3'), { id, type: 'turn' }),
      ).rejects.toBeInstanceOf(AiRunIdUsedError);
    }
  });

  it('checkAiRunTotals reads one snapshot against settles and a prune from other connections', async () => {
    const run = await openAiRun(store(), { type: 'turn' });
    const calls = await Promise.all(
      Array.from({ length: 8 }, () =>
        reserveAiCall(db, run.id, { inputTokens: 1 }),
      ),
    );
    const checks: Promise<unknown>[] = [];
    const settles = calls.map(async (call) => {
      checks.push(checkAiRunTotals(db, run.id));
      await settleAiCall(db, {
        runId: run.id,
        callId: call.callId,
        usage: { ...usageEvent(10, 0.01), tenantId: 't1' },
      });
      checks.push(checkAiRunTotals(db, run.id));
    });
    await Promise.all(settles);
    for (const check of await Promise.all(checks)) {
      expect(check).toMatchObject({ verifiable: true, matches: true });
    }
    await finishAiRun(db, run.id, { status: 'done' });
    // Marked as past its trajectory period with its events still in place,
    // so the row prune deletes events, usage rows and the run in one
    // transaction while the checks read.
    await db.query(
      "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z', trajectory_pruned = 1 WHERE id = $1",
      run.id,
    );
    const racing = Array.from({ length: 6 }, () =>
      checkAiRunTotals(db, run.id).catch((e: unknown) => e),
    );
    const [outcomes] = await Promise.all([
      Promise.all(racing),
      pruneAiRuns(db, { maxAgeMs: 0, tenantId: 't1' }),
    ]);
    for (const outcome of outcomes) {
      if (outcome instanceof AiRunNotFoundError) continue;
      expect(outcome).toMatchObject({ matches: true });
    }
  });
});
