/**
 * A run is charged for a call only against the call's own usage row
 * (docs/content/ai-runs.md section 6.4): the row under the call id, of the
 * call's run, in the run's tenant. A row of another run or tenant that holds
 * the id is never taken as the call's billing row, by settlement or by the
 * stale-reservation reconciler. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { insertAiUsageRow } from '../adapters/ai-usage';
import {
  getAiRun,
  openAiRun,
  reconcileAiCall,
  reserveAiCall,
  settleAiCall,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
  usageEvent,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

/** A row of tenant-two that already holds `id`, naming `runId`. */
async function heldRow(db: DatabaseInterface, id: string, runId: string) {
  await insertAiUsageRow(
    db,
    { ...usageEvent(500, 5), tenantId: 'tenant-two' },
    { id, runId },
  );
}

async function calls(db: DatabaseInterface, runId: string) {
  return rowsOf(
    await db.query(
      "SELECT reservation FROM _smrt_ai_run_events WHERE run_id = $1 AND type = 'call'",
      runId,
    ),
  ).map((row) => row.reservation);
}

describe.each(aiRunTestEngines)('ledger ownership on %s', (engine) => {
  it('never charges a call whose id is held by another tenant row', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const callId = crypto.randomUUID();
    await heldRow(db, callId, run.id);
    await reserveAiCall(db, run.id, { callId, inputTokens: 10 });
    await settleAiCall(db, {
      runId: run.id,
      callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 0,
      tokens: 0,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    expect(
      rowsOf(
        await db.query('SELECT tenant_id, total_tokens FROM _smrt_ai_usage'),
      ),
    ).toEqual([{ tenant_id: 'tenant-two', total_tokens: 500 }]);
  });

  it('charges a call whose own row was written (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const callId = crypto.randomUUID();
    await reserveAiCall(db, run.id, { callId, inputTokens: 10 });
    await settleAiCall(db, {
      runId: run.id,
      callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
  });

  it('reconciles a stale reservation only from the call own row', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(
      { db, usageTracking: true, tenantId: 'tenant-one' },
      { type: 'turn' },
    );
    const callId = crypto.randomUUID();
    await reserveAiCall(db, run.id, { callId, inputTokens: 10 });
    // Another tenant's row under the id, naming another run.
    await heldRow(db, callId, 'tenant-two-run');
    expect(await reconcileAiCall(db, run.id, callId)).toBe('abandoned');
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 0,
      tokens: 0,
      reservedCalls: 0,
    });
    expect(await calls(db, run.id)).toEqual(['abandoned']);
  });
});
