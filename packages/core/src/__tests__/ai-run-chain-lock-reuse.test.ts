/**
 * A chain lock and a descendant cancel lock carry the tenant established
 * while the chain was walked (docs/content/ai-runs.md section 8): a run id
 * pruned and reused by another tenant between discovery and the lock is
 * not charged or cancelled. The change is interleaved at the statement that
 * locks the run, on the operation's own transaction. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cancelAiRun,
  getAiRun,
  openAiRun,
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

describe.each(aiRunTestEngines)('chain and cancel locks on %s', (engine) => {
  it.each([
    'reserve',
    'settle',
  ] as const)('does not charge an ancestor that changed tenant before the %s chain lock', async (step) => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const child = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
      parentRunId: parent.id,
    });
    const callId = crypto.randomUUID();
    let restore = () => {};
    let before = await getAiRun(db, parent.id);
    if (step === 'reserve') {
      restore = beforeStatement(db, readsRunRow(parent.id), reuse(parent.id));
    }
    await reserveAiCall(db, child.id, { callId, inputTokens: 10 });
    if (step === 'settle') {
      before = await getAiRun(db, parent.id);
      restore = beforeStatement(db, readsRunRow(parent.id), reuse(parent.id));
    }
    await settleAiCall(db, {
      runId: child.id,
      callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    restore();
    // The child is charged; the run that changed hands is not.
    expect(await getAiRun(db, child.id)).toMatchObject({
      calls: 1,
      tokens: 12,
    });
    const pick = (row: Awaited<ReturnType<typeof getAiRun>>) => ({
      tenantId: row?.tenantId,
      inclusiveCalls: row?.inclusiveCalls,
      inclusiveTokens: row?.inclusiveTokens,
      reservedCalls: row?.reservedCalls,
      reservedTokens: row?.reservedTokens,
    });
    expect(pick(await getAiRun(db, parent.id))).toEqual({
      ...pick(before),
      tenantId: 'tenant-two',
    });
  });

  it('charges the whole chain when nothing changed hands (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const child = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
      parentRunId: parent.id,
    });
    const callId = crypto.randomUUID();
    await reserveAiCall(db, child.id, { callId, inputTokens: 10 });
    await settleAiCall(db, {
      runId: child.id,
      callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    });
    expect(await getAiRun(db, parent.id)).toMatchObject({
      inclusiveCalls: 1,
      inclusiveTokens: 12,
    });
  });

  it('does not cancel a descendant that changed tenant before its cancel lock', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const child = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
      parentRunId: root.id,
    });
    const restore = beforeStatement(db, readsRunRow(child.id), reuse(child.id));
    await cancelAiRun(db, root.id);
    restore();
    expect((await getAiRun(db, root.id))?.status).toBe('cancelled');
    expect(await getAiRun(db, child.id)).toMatchObject({
      status: 'running',
      tenantId: 'tenant-two',
    });
  });

  it('cancels a descendant that kept its tenant (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const root = await openAiRun(store(db, 'tenant-one'), { type: 'turn' });
    const child = await openAiRun(store(db, 'tenant-one'), {
      type: 'turn',
      parentRunId: root.id,
    });
    await cancelAiRun(db, root.id);
    expect((await getAiRun(db, child.id))?.status).toBe('cancelled');
  });
});
