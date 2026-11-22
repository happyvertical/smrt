/**
 * Holders of a run id fail closed once the run is gone, because its id is
 * never reopened (docs/content/ai-runs.md section 8, "Run identity"): a held
 * reservation is refused before send, and a late usage event charges no
 * run. The refusal is the final `AiRunIdUsedError`. Real SQLite and DuckDB
 * (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { isAiRunRetryable } from '../system/ai-run-model';
import {
  type AiRunContext,
  AiRunIdUsedError,
  AiRunNotFoundError,
  appendAiRunEvent,
  openAiRun,
  releaseAiCall,
  reserveAiCall,
  runAiRunCall,
  settleAiCall,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  pruneRunNow,
  rowsOf,
  usageEvent,
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

describe('the typed refusal', () => {
  it('is final for the accounting retry loop', () => {
    const error = new AiRunIdUsedError('some-id');
    expect(isAiRunRetryable(error)).toBe(false);
    expect(error).toMatchObject({ code: 'AI_RUN_ID_USED', runId: 'some-id' });
  });
});

describe.each(aiRunTestEngines)('run id holders on %s', (engine) => {
  it.each([
    true,
    false,
  ])('refuses a held reservation of a pruned run before send (checkRunning %s)', async (checkRunning) => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'fusion' });
    const held = await reserveAiCall(db, run.id, { inputTokens: 5 });
    // An unrelated run with a call still reserved.
    const other = await openAiRun(store(db), { type: 'fusion' });
    const otherHeld = await reserveAiCall(db, other.id, { inputTokens: 5 });
    // The held event is released, the run ends and is pruned.
    await releaseAiCall(db, {
      runId: run.id,
      callId: held.callId,
      status: 'cancelled',
    });
    await pruneRunNow(db, run.id);
    await expect(
      openAiRun(store(db, 'tenant-two'), { id: run.id, type: 'fusion' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    const send = vi.fn(async () => 'sent');
    const context: AiRunContext = {
      runId: run.id,
      db,
      tenantId: 'tenant-one',
      reservations: { take: () => ({ reservation: held, checkRunning }) },
    };
    await expect(
      runAiRunCall(context, { fallbackUsage }, send),
    ).rejects.toBeInstanceOf(AiRunNotFoundError);
    expect(send).not.toHaveBeenCalled();
    const otherEvents = rowsOf(
      await db.query(
        'SELECT call_state AS reservation FROM _smrt_ai_run_events WHERE call_id = $1',
        otherHeld.callId,
      ),
    );
    expect(otherEvents).toEqual([{ reservation: 'reserved' }]);
  });

  it('a late usage event for a pruned run charges no run', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    const call = await reserveAiCall(db, run.id, { inputTokens: 5 });
    await releaseAiCall(db, {
      runId: run.id,
      callId: call.callId,
      status: 'timed_out',
    });
    await pruneRunNow(db, run.id);
    await expect(
      openAiRun(store(db, 'tenant-two'), { id: run.id, type: 'turn' }),
    ).rejects.toBeInstanceOf(AiRunIdUsedError);
    await settleAiCall(db, {
      runId: run.id,
      callId: call.callId,
      usage: { ...usageEvent(12, 0.01), tenantId: 'tenant-one' },
    }).catch(() => undefined);
    expect(
      rowsOf(
        await db.query('SELECT id FROM _smrt_ai_runs WHERE id = $1', run.id),
      ),
    ).toEqual([]);
  });

  it('appends an observation to its own run (control for event holders)', async () => {
    const db = await newAiRunTestDatabase(engine);
    const run = await openAiRun(store(db), { type: 'turn' });
    await appendAiRunEvent(db, run.id, { type: 'observation' });
    expect(
      rowsOf(
        await db.query(
          'SELECT type FROM _smrt_ai_run_events WHERE run_id = $1',
          run.id,
        ),
      ),
    ).toEqual([{ type: 'observation' }]);
  });
});
