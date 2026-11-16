/**
 * Entry runs (#5005; docs/content/ai-runs.md sections 3 and 6.3): the run of
 * a fusion, opened at its start. Shares are reserved together; the judge's
 * share is checked `running` before it is sent and released when its chain
 * stopped; shares never taken are released at the end; and a stop reaches
 * the parent as a stop. Real SQLite and DuckDB (PGlite in its lane).
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import {
  AiRunStoppedError,
  AiRunTrackingDisabledError,
  beginAiRunCall,
  getAiRun,
  openAiEntryRun,
  openAiRun,
  stopAiRun,
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

const fallbackUsage = {
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'message',
};

describe.each(aiRunTestEngines)('AI entry runs on %s (#5005)', (engine) => {
  const store = (db: DatabaseInterface) => ({ db, usageTracking: true });

  it('refuses to open without usage tracking', async () => {
    const db = await newAiRunTestDatabase(engine);
    await expect(
      openAiEntryRun({ db, usageTracking: false }, { type: 'fusion' }),
    ).rejects.toBeInstanceOf(AiRunTrackingDisabledError);
  });

  it('uses each share once, releases the ones never taken, and closes done', async () => {
    const db = await newAiRunTestDatabase(engine);
    const entry = await openAiEntryRun(store(db), {
      type: 'fusion',
      definitionKey: 'review',
      mode: 'pair',
    });
    await entry.reserve([
      { name: 'a', inputTokens: 10, outputLimit: 10 },
      { name: 'b', inputTokens: 10, outputLimit: 10 },
      { name: 'judge', inputTokens: 30, outputLimit: 10, later: true },
    ]);
    expect(await getAiRun(db, entry.runId)).toMatchObject({
      reservedCalls: 3,
      reservedTokens: 80,
    });
    const a = await beginAiRunCall(entry.contextFor('a'), { fallbackUsage });
    expect(a.reservation.reservedTokens).toBe(20);
    expect(a.invocation.outputLimit).toBe(10);
    a.invocation.capture(usageEvent(12));
    await a.succeed();
    // A second call of seat a (a fallback) reserves on its own.
    const again = await beginAiRunCall(entry.contextFor('a'), {
      fallbackUsage,
      inputTokens: 1,
      outputLimit: 1,
    });
    expect(again.reservation.reservedTokens).toBe(2);
    await again.fail(new Error('down'));
    await entry.close({ status: 'done', seats: 1, degradedSeats: 0 });
    expect(await getAiRun(db, entry.runId)).toMatchObject({
      status: 'done',
      calls: 1,
      tokens: 12,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    const states = rowsOf(
      await db.query(
        `SELECT name, reservation FROM _smrt_ai_run_events
          WHERE run_id = $1 ORDER BY seq`,
        entry.runId,
      ),
    ).map((row) => [row.name, row.reservation]);
    expect(states).toEqual([
      ['a', 'settled'],
      ['b', 'released'],
      ['judge', 'released'],
      [null, 'released'],
    ]);
  });

  it('checks the judge chain before sending it and reaches the parent as a stop', async () => {
    const db = await newAiRunTestDatabase(engine);
    const parent = await openAiRun(store(db), {
      type: 'workflow',
      durable: true,
    });
    const entry = await openAiEntryRun(store(db), {
      type: 'fusion',
      parent: { runId: parent.id, db },
      entryCallId: 'entry-1',
    });
    await entry.reserve([
      { name: 'a', inputTokens: 1, outputLimit: 1 },
      { name: 'judge', inputTokens: 1, outputLimit: 1, later: true },
    ]);
    const handoff = rowsOf(
      await db.query(
        `SELECT id, status, child_run_id, call_id FROM _smrt_ai_run_events
          WHERE run_id = $1`,
        parent.id,
      ),
    );
    expect(handoff[0]).toMatchObject({
      status: 'running',
      child_run_id: entry.runId,
      call_id: 'entry-1',
    });
    // The host interrupts the parent between the panel and the judge.
    await stopAiRun(db, parent.id);
    const refused = await beginAiRunCall(entry.contextFor('judge'), {
      fallbackUsage,
    }).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(AiRunStoppedError);
    const thrown = await entry.stop(refused);
    expect(thrown).toMatchObject({ runId: parent.id, status: 'stopped' });
    expect(await getAiRun(db, entry.runId)).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
      stoppedByRunId: parent.id,
      reservedCalls: 0,
    });
    expect(
      rowsOf(
        await db.query(
          'SELECT status FROM _smrt_ai_run_events WHERE id = $1',
          handoff[0]?.id,
        ),
      )[0]?.status,
    ).toBe('stopped');
  });
});
