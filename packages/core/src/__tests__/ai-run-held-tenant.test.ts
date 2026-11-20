/**
 * A call under a run context stays in the context's chain and tenant
 * (docs/content/ai-runs.md sections 6.3 and 6.4): a held reservation is
 * admitted before send in both modes only while its call event is still
 * reserved, the claim fence is asked only about the context's own chain,
 * and a child's stop reaches only the context's run. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AiRunContext,
  AiRunNotFoundError,
  AiRunStoppedError,
  beginAiRunCall,
  getAiRun,
  openAiRun,
  releaseAiCall,
  reserveAiCall,
  runAiRunCall,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  await closeAiRunTestDatabases();
});

const store = (
  db: DatabaseInterface,
  tenantId: string | null = 'tenant-one',
) => ({ db, usageTracking: true, tenantId });

const fallbackUsage = {
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'message',
} as const;

describe.each(aiRunTestEngines)('held calls and fences on %s', (engine) => {
  it.each([
    true,
    false,
  ])('refuses a held reservation that is no longer reserved before send (checkRunning %s)', async (checkRunning) => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'fusion' });
    const held = await reserveAiCall(db, run.id, { inputTokens: 5 });
    await releaseAiCall(db, {
      runId: run.id,
      callId: held.callId,
      status: 'cancelled',
    });
    const send = vi.fn(async () => 'sent');
    const context: AiRunContext = {
      runId: run.id,
      db,
      tenantId: 'tenant-one',
      reservations: { take: () => ({ reservation: held, checkRunning }) },
    };
    await expect(
      runAiRunCall(context, { fallbackUsage }, send),
    ).rejects.toThrow(/no longer reserved/);
    expect(send).not.toHaveBeenCalled();
    expect(await getAiRun(db, run.id)).toMatchObject({
      status: 'running',
      calls: 0,
      reservedCalls: 0,
    });
  });

  it('sends a held reservation that is still reserved (control)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'fusion' });
    const held = await reserveAiCall(db, run.id, { inputTokens: 5 });
    for (const checkRunning of [false]) {
      const send = vi.fn(async () => 'sent');
      const context: AiRunContext = {
        runId: run.id,
        db,
        tenantId: 'tenant-one',
        reservations: { take: () => ({ reservation: held, checkRunning }) },
      };
      expect(await runAiRunCall(context, { fallbackUsage }, send)).toBe('sent');
      expect(send).toHaveBeenCalledTimes(1);
    }
  });

  it('never passes a fence an id outside the context chain', async () => {
    const db = await newAiRunTestDatabase(engine);
    const foreignDurable = await openAiRun(store(db, 'tenant-two'), {
      type: 'workflow',
      durable: true,
    });
    const child = await openAiRun(store(db), { type: 'turn' });
    const fence = vi.fn(async (_tx: unknown, _durableRunId: string) => true);
    // The id changed hands (a link written by an older core): it is now
    // another tenant's run under that tenant's durable parent.
    await db.query(
      "UPDATE _smrt_ai_runs SET tenant_id = 'tenant-two', parent_run_id = $1 WHERE id = $2",
      foreignDurable.id,
      child.id,
    );
    const context: AiRunContext = {
      runId: child.id,
      db,
      tenantId: 'tenant-one',
      fence,
    };
    const send = vi.fn(async () => 'sent');
    await expect(
      runAiRunCall(context, { fallbackUsage }, send),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    for (const call of fence.mock.calls) {
      expect(call[1]).not.toBe(foreignDurable.id);
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a child stop in the context chain', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    const handle = await beginAiRunCall(
      { runId: run.id, db, tenantId: 'tenant-one' },
      { fallbackUsage },
    );
    // The id changed hands while the call was out.
    await db.query(
      "UPDATE _smrt_ai_runs SET tenant_id = 'tenant-two' WHERE id = $1",
      run.id,
    );
    const childStop = new AiRunStoppedError({
      runId: 'a-child',
      status: 'cancelled',
      stopReason: 'cancelled',
      stoppedByRunId: 'a-child',
    });
    await handle.fail(childStop).catch(() => undefined);
    expect(await getAiRun(db, run.id)).toMatchObject({
      tenantId: 'tenant-two',
      status: 'running',
    });
  });
});
