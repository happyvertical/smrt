/**
 * Claim reconciliation and the totals check keep to the run they started
 * from (docs/content/ai-runs.md sections 6.6 and 6.7): reconciliation reads
 * and locks descendants in the tenant it discovered them in, and
 * `checkAiRunTotals` reads the run and its usage in one statement, so a run
 * that disappears reads as not found, never as stored totals beside empty
 * figures. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiRunNotFoundError,
  checkAiRunTotals,
  getAiRun,
  openAiRun,
  reconcileAiRunOnClaim,
  reserveAiCall,
  settleAiCall,
} from '../system/browser';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  readsRunRow,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (
  db: DatabaseInterface,
  tenantId: string | null = 'tenant-one',
) => ({ db, usageTracking: true, tenantId });

type Exec = (sql: string, ...params: unknown[]) => Promise<unknown>;

describe.each(aiRunTestEngines)('reconciliation and totals on %s', (engine) => {
  it('claim reconciliation does not fail a run whose descendant id changed hands', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const child = await openAiRun(store(db), {
      type: 'turn',
      parentRunId: root.id,
    });
    const restore = beforeStatement(db, readsRunRow(child.id), (exec: Exec) =>
      exec(
        "UPDATE _smrt_ai_runs SET tenant_id = 'tenant-two' WHERE id = $1",
        child.id,
      ),
    );
    const result = await reconcileAiRunOnClaim(db, root.id);
    restore();
    expect(result.abandonedRuns).toEqual([]);
    expect(await getAiRun(db, child.id)).toMatchObject({
      tenantId: 'tenant-two',
      status: 'running',
    });
  });

  it('claim reconciliation fails a running descendant that kept its tenant (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const child = await openAiRun(store(db), {
      type: 'turn',
      parentRunId: root.id,
    });
    const result = await reconcileAiRunOnClaim(db, root.id);
    expect(result.abandonedRuns).toEqual([child.id]);
  });

  it('checkAiRunTotals reads the run and its usage in one statement', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    const call = await reserveAiCall(db, run.id, { inputTokens: 5 });
    await settleAiCall(db, {
      runId: run.id,
      callId: call.callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    // A prune that lands between two reads of the check reads as gone,
    // never as stored totals beside empty figures.
    const restore = beforeStatement(
      db,
      (sql) => sql.includes('_smrt_ai_run_events e'),
      async (exec: Exec) => {
        await exec('DELETE FROM _smrt_ai_usage WHERE run_id = $1', run.id);
        await exec('DELETE FROM _smrt_ai_run_events WHERE run_id = $1', run.id);
        await exec('DELETE FROM _smrt_ai_runs WHERE id = $1', run.id);
      },
    );
    const outcome = await checkAiRunTotals(db, run.id).catch((e: unknown) => e);
    restore();
    expect(outcome).toBeInstanceOf(AiRunNotFoundError);
  });

  it('checkAiRunTotals verifies a normal run (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    const call = await reserveAiCall(db, run.id, { inputTokens: 5 });
    await settleAiCall(db, {
      runId: run.id,
      callId: call.callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    expect(await checkAiRunTotals(db, run.id)).toMatchObject({
      verifiable: true,
      matches: true,
      computed: { calls: 1, tokens: 12 },
    });
  });
});
