/**
 * AI run budget accounting (#5005; docs/content/ai-runs.md section 6):
 * reservation sizing, reserve / settle / release and their state machine,
 * the named failure scenarios (late usage, abandon versus a live process,
 * handler failure after settle, chain double-charge, parallel seats, zero
 * room, stop propagation, overshoot, uncosted calls, input too large,
 * recovery after a crash), the sweep, the pending list, the totals check and
 * repair, the call-id dedupe, and run tracking on a client. Real SQLite and
 * DuckDB (PGlite in its lane); two SQLite connections for the cross-process
 * locking case.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiUsagePersistenceHandler,
  insertAiUsageRow,
} from '../adapters/ai-usage';
import { withAiRunTracking } from '../ai-run-client';
import {
  AI_RUN_DEFAULT_OUTPUT_TOKENS,
  AI_RUN_PENDING_WARN_INTERVAL_MS,
  AiCallLimitError,
  AiRunStoppedError,
  AiRunTotalsUnverifiableError,
  assertAiRunStillRunning,
  cancelAiRun,
  checkAiRunTotals,
  deferAiRunSettlement,
  finishAiRun,
  flushAiRunSettlements,
  getAiRun,
  getRunTrajectory,
  openAiRun,
  pendingAiRunSettlements,
  reconcileAiCall,
  reconcileAiRunOnClaim,
  releaseAiCall,
  repairAiRunTotals,
  reserveAiCall,
  reserveAiCalls,
  resumeAiRun,
  runAiRunCall,
  settleAiCall,
  sizeAiCallReservation,
  stopAiRun,
  sweepAiRuns,
  withAiRunTransaction,
} from '../system/browser';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
  usageEvent,
} from './fixtures/ai-run-test-db';

const dirs: string[] = [];
afterEach(async () => {
  await closeAiRunTestDatabases();
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const RATE = { input: 0.001, output: 0.002 };

describe('sizing a reservation (page section 6.3)', () => {
  it('reserves E + the output limit, shrinking it to fit maxCallTokens', () => {
    expect(
      sizeAiCallReservation({ inputTokens: 100, outputLimit: 500 }, 400),
    ).toMatchObject({
      inputTokens: 100,
      outputLimit: 300,
      reservedTokens: 400,
    });
    expect(sizeAiCallReservation({ inputTokens: 100 }, 400)).toMatchObject({
      outputLimit: 300,
      reservedTokens: 400,
    });
    expect(
      sizeAiCallReservation({ inputTokens: 100, outputLimit: 50 }, 400),
    ).toMatchObject({ outputLimit: 50, reservedTokens: 150 });
  });

  it('reserves E + O when only the request sets a limit', () => {
    expect(
      sizeAiCallReservation({ inputChars: 400, outputLimit: 200 }),
    ).toMatchObject({
      inputTokens: 100,
      outputLimit: 200,
      reservedTokens: 300,
    });
  });

  it('reserves E + D otherwise, D never sent and capped at the model maximum', () => {
    expect(sizeAiCallReservation({ inputTokens: 10 })).toMatchObject({
      outputLimit: null,
      reservedTokens: 10 + AI_RUN_DEFAULT_OUTPUT_TOKENS,
    });
    expect(
      sizeAiCallReservation({ inputTokens: 10, expectedOutputTokens: 800 }),
    ).toMatchObject({ reservedTokens: 810 });
    expect(
      sizeAiCallReservation({ inputTokens: 10, modelMaxOutput: 1000 }),
    ).toMatchObject({ reservedTokens: 1010 });
  });

  it('prices E at the input rate and the allowance at the output rate; no price is uncosted', () => {
    const size = sizeAiCallReservation({
      inputTokens: 1000,
      outputLimit: 500,
      rate: RATE,
    });
    expect(size?.reservedCost).toBeCloseTo(1 * 0.001 + 0.5 * 0.002, 12);
    expect(size?.uncosted).toBe(false);
    expect(sizeAiCallReservation({ inputTokens: 1 })).toMatchObject({
      reservedCost: 0,
      uncosted: true,
    });
  });

  it('refuses a request whose input alone does not fit maxCallTokens', () => {
    expect(sizeAiCallReservation({ inputTokens: 400 }, 400)).toBeNull();
  });
});

describe.each(aiRunTestEngines)('AI run accounting on %s (#5005)', (engine) => {
  async function db(): Promise<DatabaseInterface> {
    return newAiRunTestDatabase(engine);
  }
  const store = (database: DatabaseInterface) => ({
    db: database,
    usageTracking: true,
  });
  async function usageRows(database: DatabaseInterface, id: string) {
    return rowsOf(
      await database.query('SELECT * FROM _smrt_ai_usage WHERE id = $1', id),
    );
  }
  async function reservation(database: DatabaseInterface, callId: string) {
    return rowsOf(
      await database.query(
        "SELECT reservation, status FROM _smrt_ai_run_events WHERE call_id = $1 AND type = 'call'",
        callId,
      ),
    )[0];
  }

  it('reserves, then settles once: own and inclusive totals, usage row id = call_id', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { maxTokens: 10_000 },
    });
    const held = await reserveAiCall(database, run.id, {
      inputTokens: 100,
      outputLimit: 100,
      rate: RATE,
    });
    expect(await getAiRun(database, run.id)).toMatchObject({
      reservedCalls: 1,
      reservedTokens: 200,
    });
    expect((await getAiRun(database, run.id))?.reservedCost).toBeCloseTo(
      (0.3 / 1000) * 1,
      12,
    );
    const usage = usageEvent(150, 0.0002);
    expect(
      await settleAiCall(database, {
        runId: run.id,
        callId: held.callId,
        usage,
      }),
    ).toBe('settled');
    // A retried settlement, and the persistence handler after it.
    expect(
      await settleAiCall(database, {
        runId: run.id,
        callId: held.callId,
        usage,
      }),
    ).toBe('already_settled');
    await new AiUsagePersistenceHandler(database).handle({
      ...usage,
      tags: { aiCallId: held.callId, runId: run.id },
    });
    const after = await getAiRun(database, run.id);
    expect(after).toMatchObject({
      calls: 1,
      tokens: 150,
      inclusiveCalls: 1,
      inclusiveTokens: 150,
      reservedCalls: 0,
      reservedTokens: 0,
      reservedCost: 0,
    });
    expect(after?.costUsed).toBeCloseTo(0.0002, 9);
    const rows = await usageRows(database, held.callId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      call_id: held.callId,
      entry_call_id: held.callId,
      run_id: run.id,
    });
    expect((await reservation(database, held.callId))?.reservation).toBe(
      'settled',
    );
  });

  it('charges a call once along a parent, child and grandchild chain', async () => {
    const database = await db();
    const root = await openAiRun(store(database), { type: 'workflow' });
    const child = await openAiRun(store(database), {
      type: 'turn',
      parentRunId: root.id,
    });
    const grandchild = await openAiRun(store(database), {
      type: 'fusion',
      parentRunId: child.id,
    });
    const held = await reserveAiCall(database, grandchild.id, {
      inputTokens: 10,
      outputLimit: 10,
      rate: RATE,
    });
    for (const run of [root, child, grandchild]) {
      expect((await getAiRun(database, run.id))?.reservedTokens).toBe(20);
    }
    await settleAiCall(database, {
      runId: grandchild.id,
      callId: held.callId,
      usage: usageEvent(40, 0.5),
    });
    await settleAiCall(database, {
      runId: grandchild.id,
      callId: held.callId,
      usage: usageEvent(40, 0.5),
    });
    for (const run of [root, child]) {
      expect(await getAiRun(database, run.id)).toMatchObject({
        calls: 0,
        tokens: 0,
        costUsed: 0,
        inclusiveCalls: 1,
        inclusiveTokens: 40,
        inclusiveCost: 0.5,
        reservedTokens: 0,
      });
    }
    expect(await getAiRun(database, grandchild.id)).toMatchObject({
      calls: 1,
      tokens: 40,
      costUsed: 0.5,
      inclusiveTokens: 40,
    });
  });

  it('charges late usage after a release once, without returning room twice', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const held = await reserveAiCall(database, run.id, {
      inputTokens: 10,
      outputLimit: 90,
    });
    expect(
      await releaseAiCall(database, {
        runId: run.id,
        callId: held.callId,
        status: 'timed_out',
      }),
    ).toBe(true);
    expect(
      await releaseAiCall(database, {
        runId: run.id,
        callId: held.callId,
        status: 'timed_out',
      }),
    ).toBe(false);
    expect(await getAiRun(database, run.id)).toMatchObject({
      reservedCalls: 0,
      reservedTokens: 0,
      calls: 0,
    });
    // The provider reports usage after all.
    expect(
      await settleAiCall(database, {
        runId: run.id,
        callId: held.callId,
        usage: usageEvent(70),
      }),
    ).toBe('settled_late');
    expect(
      await settleAiCall(database, {
        runId: run.id,
        callId: held.callId,
        usage: usageEvent(70),
      }),
    ).toBe('already_settled');
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      tokens: 70,
      uncostedCalls: 1,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    expect((await reservation(database, held.callId))?.reservation).toBe(
      'settled_late',
    );
  });

  it('abandons a reservation of a process that looks dead, and charges it once when the live process settles', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const held = await reserveAiCall(database, run.id, { inputTokens: 50 });
    expect(await reconcileAiCall(database, run.id, held.callId)).toBe(
      'abandoned',
    );
    expect(await reconcileAiCall(database, run.id, held.callId)).toBe('moved');
    expect((await getAiRun(database, run.id))?.reservedTokens).toBe(0);
    // It was alive after all.
    expect(
      await settleAiCall(database, {
        runId: run.id,
        callId: held.callId,
        usage: usageEvent(60, 0.01),
      }),
    ).toBe('settled_late');
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      tokens: 60,
      reservedTokens: 0,
      reservedCalls: 0,
    });
  });

  it('reconciles a reservation whose usage row reached the table by settling it', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const held = await reserveAiCall(database, run.id, { inputTokens: 50 });
    await insertAiUsageRow(database, usageEvent(33, 0.2), {
      id: held.callId,
      runId: run.id,
    });
    expect(await reconcileAiCall(database, run.id, held.callId)).toBe(
      'settled',
    );
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      tokens: 33,
      reservedCalls: 0,
    });
    expect((await checkAiRunTotals(database, run.id)).matches).toBe(true);
  });

  it('charges unreserved usage once, on its insert', async () => {
    const database = await db();
    const root = await openAiRun(store(database), { type: 'workflow' });
    const run = await openAiRun(store(database), {
      type: 'turn',
      parentRunId: root.id,
    });
    for (let i = 0; i < 2; i++) {
      expect(
        await settleAiCall(database, {
          runId: run.id,
          callId: 'zero-token-failure',
          usage: usageEvent(0),
        }),
      ).toBe(i === 0 ? 'unreserved' : 'already_settled');
    }
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      tokens: 0,
    });
    expect((await getAiRun(database, root.id))?.inclusiveCalls).toBe(1);
    expect(
      (await reservation(database, 'zero-token-failure'))?.reservation,
    ).toBe('unreserved');
  });

  it('runs the usage handlers only after the settle committed; a handler failure changes no totals', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const seen: number[] = [];
    const answer = await runAiRunCall(
      { runId: run.id, db: database },
      {
        inputTokens: 5,
        outputLimit: 5,
        fallbackUsage: {
          provider: 'openai',
          model: 'gpt-4o',
          operation: 'message',
        },
        afterSettle: async (event) => {
          // The settle has committed: its row and charge are visible.
          seen.push(
            (await usageRows(database, event.tags?.aiCallId ?? '')).length,
          );
          seen.push((await getAiRun(database, run.id))?.calls ?? -1);
          throw new Error('handler down');
        },
      },
      async (invocation) => {
        expect(invocation.outputLimit).toBe(5);
        invocation.capture(usageEvent(9, 0.001));
        return 'ok';
      },
    );
    expect(answer).toBe('ok');
    expect(seen).toEqual([1, 1]);
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      tokens: 9,
      reservedCalls: 0,
    });
  });

  it('releases a failed call and refuses calls once the run left running', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    await expect(
      runAiRunCall(
        { runId: run.id, db: database },
        {
          inputTokens: 5,
          fallbackUsage: { provider: 'p', model: 'm', operation: 'message' },
        },
        async () => {
          throw new Error('provider 500');
        },
      ),
    ).rejects.toThrow('provider 500');
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 0,
      reservedCalls: 0,
    });
    await stopAiRun(database, run.id);
    await expect(
      reserveAiCall(database, run.id, { inputTokens: 5 }),
    ).rejects.toMatchObject({ status: 'stopped', stopReason: 'interrupted' });
  });

  it('lets three parallel fusion seats share the room, all or none', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'fusion',
      budget: { maxTokens: 600 },
    });
    const seats = [0, 1, 2].map((i) => ({
      inputTokens: 100,
      outputLimit: 100,
      name: `seat-${i}`,
    }));
    const held = await reserveAiCalls(database, run.id, seats);
    expect(held).toHaveLength(3);
    expect((await getAiRun(database, run.id))?.reservedTokens).toBe(600);
    for (const seat of held) {
      await releaseAiCall(database, {
        runId: run.id,
        callId: seat.callId,
        status: 'failed',
      });
    }
    // A panel and judge that do not fit together: nothing is reserved.
    const tooBig = [
      ...seats,
      { inputTokens: 300, outputLimit: 100, name: 'judge' },
    ];
    await expect(
      reserveAiCalls(database, run.id, tooBig),
    ).rejects.toMatchObject({
      stopReason: 'max_tokens',
    });
    const stopped = await getAiRun(database, run.id);
    expect(stopped).toMatchObject({
      status: 'stopped',
      reservedCalls: 0,
      stopDetail: {
        limit: 'maxTokens',
        limitValue: 600,
        used: 0,
        reserved: 0,
        requested: 1000,
        room: 600,
      },
    });
  });

  it('shares the room between concurrent single reservations', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { maxTokens: 400 },
    });
    const results = await Promise.allSettled(
      [0, 1, 2].map(() =>
        reserveAiCall(database, run.id, { inputTokens: 100, outputLimit: 100 }),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(2);
    const refused = results.find((r) => r.status === 'rejected');
    expect((refused as PromiseRejectedResult).reason).toBeInstanceOf(
      AiRunStoppedError,
    );
    expect((await getAiRun(database, run.id))?.reservedTokens).toBe(400);
  });

  it('refuses a call when there is no room at all, with the stop detail', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { maxCalls: 0 },
    });
    await expect(
      reserveAiCall(database, run.id, { inputTokens: 1 }),
    ).rejects.toBeInstanceOf(AiRunStoppedError);
    expect(await getAiRun(database, run.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'max_calls',
      stoppedByRunId: run.id,
      stopDetail: {
        limit: 'maxCalls',
        runId: run.id,
        limitValue: 0,
        used: 0,
        reserved: 0,
        requested: 1,
        room: 0,
      },
    });
  });

  it('stops a child at its ancestor limit, and the child stop reaches the parent as a stop', async () => {
    const database = await db();
    const root = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      budget: { maxTokens: 100 },
    });
    const fusion = await openAiRun(store(database), {
      type: 'fusion',
      parentRunId: root.id,
    });
    // The step's entry call is answered by the fusion, which stops at the
    // root's maxTokens.
    const stop = runAiRunCall(
      { runId: root.id, db: database },
      {
        inputTokens: 1,
        outputLimit: 1,
        fallbackUsage: { provider: 'p', model: 'm', operation: 'message' },
      },
      async () => {
        await reserveAiCall(database, fusion.id, {
          inputTokens: 100,
          outputLimit: 100,
        });
        return 'never';
      },
    );
    await expect(stop).rejects.toMatchObject({
      runId: root.id,
      status: 'stopped',
      stopReason: 'max_tokens',
      stoppedByRunId: root.id,
    });
    expect(await getAiRun(database, fusion.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      stoppedByRunId: root.id,
    });
    const workflow = await getAiRun(database, root.id);
    expect(workflow).toMatchObject({
      status: 'stopped',
      stopReason: 'max_tokens',
      stoppedByRunId: root.id,
      reservedCalls: 0,
      calls: 0,
    });
    expect(workflow?.stopDetail).toMatchObject({ limit: 'maxTokens' });
    // Resumable once the root's limit is raised.
    const resumed = await resumeAiRun(database, root.id, {
      budget: { maxTokens: 1000 },
    });
    expect(resumed.status).toBe('running');
  });

  it('stops a parent with interrupted when its child was cancelled on its own', async () => {
    const database = await db();
    const root = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
    });
    const fusion = await openAiRun(store(database), {
      type: 'fusion',
      parentRunId: root.id,
    });
    await cancelAiRun(database, fusion.id);
    await expect(
      runAiRunCall(
        { runId: root.id, db: database },
        {
          inputTokens: 1,
          fallbackUsage: { provider: 'p', model: 'm', operation: 'message' },
        },
        async () => reserveAiCall(database, fusion.id, { inputTokens: 1 }),
      ),
    ).rejects.toMatchObject({ runId: root.id, status: 'stopped' });
    expect(await getAiRun(database, root.id)).toMatchObject({
      status: 'stopped',
      stopReason: 'interrupted',
      stoppedByRunId: fusion.id,
    });
  });

  it('reaches every descendant with a cancel; their next reservation is refused', async () => {
    const database = await db();
    const root = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
    });
    const child = await openAiRun(store(database), {
      type: 'turn',
      parentRunId: root.id,
    });
    const grandchild = await openAiRun(store(database), {
      type: 'fusion',
      parentRunId: child.id,
    });
    const inFlight = await reserveAiCall(database, grandchild.id, {
      inputTokens: 10,
      outputLimit: 10,
    });
    await cancelAiRun(database, root.id);
    for (const id of [child.id, grandchild.id]) {
      expect(await getAiRun(database, id)).toMatchObject({
        status: 'cancelled',
        stopReason: 'cancelled',
        stoppedByRunId: root.id,
      });
    }
    await expect(
      reserveAiCall(database, grandchild.id, { inputTokens: 1 }),
    ).rejects.toMatchObject({ status: 'cancelled', stopReason: 'cancelled' });
    // A call already in flight still settles: settlement ignores status.
    await settleAiCall(database, {
      runId: grandchild.id,
      callId: inFlight.callId,
      usage: usageEvent(15),
    });
    expect(await getAiRun(database, root.id)).toMatchObject({
      inclusiveTokens: 15,
      reservedTokens: 0,
    });
  });

  it('charges overshoot in full, so the next reservation is refused', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { maxTokens: 5000 },
    });
    const held = await reserveAiCall(database, run.id, {
      inputTokens: 100,
      expectedOutputTokens: 100,
    });
    expect(held).toMatchObject({ reservedTokens: 200, outputLimit: null });
    await settleAiCall(database, {
      runId: run.id,
      callId: held.callId,
      usage: usageEvent(4900),
    });
    expect((await getAiRun(database, run.id))?.inclusiveTokens).toBe(4900);
    await expect(
      reserveAiCall(database, run.id, { inputTokens: 50, outputLimit: 51 }),
    ).rejects.toMatchObject({ stopReason: 'max_tokens' });
  });

  it('allows uncosted calls under maxCost and counts them', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { maxCost: 0 },
    });
    const held = await reserveAiCall(database, run.id, {
      inputTokens: 10,
      rate: null,
    });
    expect(held).toMatchObject({ uncosted: true, reservedCost: 0 });
    await settleAiCall(database, {
      runId: run.id,
      callId: held.callId,
      usage: usageEvent(20),
    });
    expect(await getAiRun(database, run.id)).toMatchObject({
      status: 'running',
      uncostedCalls: 1,
      inclusiveUncostedCalls: 1,
      costUsed: 0,
    });
    // A priced call is bounded by the cost limit.
    await expect(
      reserveAiCall(database, run.id, { inputTokens: 10, rate: RATE }),
    ).rejects.toMatchObject({ stopReason: 'max_cost' });
  });

  it('charges an answered call that reported no tokens its reserved R', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    await runAiRunCall(
      { runId: run.id, db: database },
      {
        inputTokens: 10,
        outputLimit: 20,
        fallbackUsage: {
          provider: 'cli',
          model: 'local',
          operation: 'message',
        },
      },
      async () => 'answer',
    );
    const after = await getAiRun(database, run.id);
    expect(after).toMatchObject({ calls: 1, tokens: 30, uncostedCalls: 1 });
    const rows = rowsOf(
      await database.query(
        'SELECT total_tokens, model FROM _smrt_ai_usage WHERE run_id = $1',
        run.id,
      ),
    );
    expect(rows).toEqual([{ total_tokens: null, model: 'local' }]);
  });

  it('fails a call whose input alone exceeds maxCallTokens before it is sent; the run goes on', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { maxCallTokens: 10 },
    });
    let sent = false;
    await expect(
      runAiRunCall(
        { runId: run.id, db: database },
        {
          inputChars: 400,
          fallbackUsage: { provider: 'p', model: 'm', operation: 'message' },
        },
        async () => {
          sent = true;
          return 'x';
        },
      ),
    ).rejects.toBeInstanceOf(AiCallLimitError);
    expect(sent).toBe(false);
    expect(await getAiRun(database, run.id)).toMatchObject({
      status: 'running',
      reservedCalls: 0,
    });
  });

  it('times a call out at callTimeoutMs: released, the call fails, the run goes on', async () => {
    const database = await db();
    const run = await openAiRun(store(database), {
      type: 'turn',
      budget: { callTimeoutMs: 20 },
    });
    await expect(
      runAiRunCall(
        { runId: run.id, db: database },
        {
          inputTokens: 1,
          fallbackUsage: { provider: 'p', model: 'm', operation: 'message' },
        },
        (invocation) =>
          new Promise((_, reject) => {
            invocation.signal?.addEventListener('abort', () =>
              reject(
                Object.assign(new Error('aborted'), { name: 'AbortError' }),
              ),
            );
          }),
      ),
    ).rejects.toMatchObject({ limit: 'callTimeoutMs' });
    expect(await getAiRun(database, run.id)).toMatchObject({
      status: 'running',
      reservedCalls: 0,
    });
  });

  it('after a crash, the claiming worker abandons dead reservations of the run and its non-durable descendants, leaving durable descendants alone', async () => {
    const database = await db();
    const root = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      budget: { maxTokens: 300 },
    });
    const fusion = await openAiRun(store(database), {
      type: 'fusion',
      parentRunId: root.id,
    });
    const durableChild = await openAiRun(store(database), {
      type: 'workflow',
      durable: true,
      parentRunId: root.id,
    });
    const deadRoot = await reserveAiCall(database, root.id, {
      inputTokens: 50,
      outputLimit: 50,
    });
    const deadSeat = await reserveAiCall(database, fusion.id, {
      inputTokens: 50,
      outputLimit: 50,
    });
    const liveChild = await reserveAiCall(database, durableChild.id, {
      inputTokens: 50,
      outputLimit: 50,
    });
    // The dead worker's reservations hold all the room.
    expect((await getAiRun(database, root.id))?.reservedTokens).toBe(300);

    const outcome = await reconcileAiRunOnClaim(database, root.id);
    expect(outcome).toMatchObject({
      abandoned: 2,
      settled: 0,
      abandonedRuns: [fusion.id],
    });
    expect((await reservation(database, deadRoot.callId))?.reservation).toBe(
      'abandoned',
    );
    expect((await reservation(database, deadSeat.callId))?.reservation).toBe(
      'abandoned',
    );
    expect((await reservation(database, liveChild.callId))?.reservation).toBe(
      'reserved',
    );
    expect(await getAiRun(database, fusion.id)).toMatchObject({
      status: 'failed',
      stopReason: 'abandoned',
    });
    expect(await getAiRun(database, durableChild.id)).toMatchObject({
      status: 'running',
      reservedTokens: 100,
    });
    expect((await getAiRun(database, root.id))?.reservedTokens).toBe(100);
    // The run (still `running`: its worker died) has its room back.
    await expect(
      reserveAiCall(database, root.id, { inputTokens: 10, outputLimit: 10 }),
    ).resolves.toMatchObject({ reservedTokens: 20 });
  });

  it('sweeps stale reservations by their threshold and closes quiet non-durable runs', async () => {
    const database = await db();
    let now = new Date('2026-11-14T10:00:00.000Z');
    const clock = { now: () => now };
    const timed = await openAiRun(
      store(database),
      { type: 'turn', budget: { callTimeoutMs: 60_000 } },
      clock,
    );
    const untimed = await openAiRun(store(database), { type: 'turn' }, clock);
    const durable = await openAiRun(
      store(database),
      { type: 'workflow', durable: true },
      clock,
    );
    const a = await reserveAiCall(
      database,
      timed.id,
      { inputTokens: 5 },
      clock,
    );
    const b = await reserveAiCall(
      database,
      untimed.id,
      { inputTokens: 5 },
      clock,
    );
    // 3 minutes: past 60 s + 1 min for `timed`, not past 1 h for `untimed`.
    now = new Date(now.getTime() + 3 * 60_000);
    expect(await sweepAiRuns(database, clock)).toMatchObject({
      abandoned: 1,
      closedRuns: [],
    });
    expect((await reservation(database, a.callId))?.reservation).toBe(
      'abandoned',
    );
    expect((await reservation(database, b.callId))?.reservation).toBe(
      'reserved',
    );
    now = new Date(now.getTime() + 60 * 60_000);
    expect((await sweepAiRuns(database, clock)).abandoned).toBe(1);
    // A day later: both turns are quiet and hold nothing; the durable run is
    // never closed this way.
    now = new Date(now.getTime() + 25 * 60 * 60_000);
    const swept = await sweepAiRuns(database, clock);
    expect(swept.closedRuns.sort()).toEqual([timed.id, untimed.id].sort());
    expect(await getAiRun(database, timed.id)).toMatchObject({
      status: 'failed',
      stopReason: 'abandoned',
    });
    expect((await getAiRun(database, durable.id))?.status).toBe('running');
    // The slow process finishing late cannot write done over it.

    expect(
      await finishAiRun(database, timed.id, { status: 'done' }),
    ).toBeNull();
    // And a run with fresh activity is not closed.
    const busy = await openAiRun(store(database), { type: 'turn' }, clock);
    expect((await sweepAiRuns(database, clock)).closedRuns).not.toContain(
      busy.id,
    );
  });

  it('checks totals against usage rows, repairs drift up the chain, and refuses an unverifiable run', async () => {
    const database = await db();
    const root = await openAiRun(store(database), { type: 'workflow' });
    const run = await openAiRun(store(database), {
      type: 'turn',
      parentRunId: root.id,
    });
    const held = await reserveAiCall(database, run.id, { inputTokens: 5 });
    await settleAiCall(database, {
      runId: run.id,
      callId: held.callId,
      usage: usageEvent(50, 0.25),
    });
    expect(await checkAiRunTotals(database, run.id)).toMatchObject({
      verifiable: true,
      matches: true,
    });
    // A hand edit.
    await database.query(
      'UPDATE _smrt_ai_runs SET tokens = 10, inclusive_tokens = 10 WHERE id = $1',
      run.id,
    );
    expect((await checkAiRunTotals(database, run.id)).matches).toBe(false);
    const diff = await repairAiRunTotals(database, run.id);
    expect(diff).toMatchObject({ tokens: 40, calls: 0 });
    expect(await getAiRun(database, run.id)).toMatchObject({
      tokens: 50,
      inclusiveTokens: 50,
    });
    expect((await getAiRun(database, root.id))?.inclusiveTokens).toBe(90);
    // Usage pruned: unverifiable, never wrong.
    await database.query(
      'DELETE FROM _smrt_ai_usage WHERE id = $1',
      held.callId,
    );
    expect(await checkAiRunTotals(database, run.id)).toMatchObject({
      verifiable: false,
      missingUsageRows: 1,
      matches: null,
    });
    await expect(repairAiRunTotals(database, run.id)).rejects.toBeInstanceOf(
      AiRunTotalsUnverifiableError,
    );
  });

  /** The same database, refusing every statement while `failing.on`. */
  function failingHandle(database: DatabaseInterface) {
    const failing = { on: false };
    const handle = new Proxy(database, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (
          failing.on &&
          (prop === 'query' || prop === 'execute' || prop === 'transaction')
        ) {
          return () => Promise.reject(new Error('database unavailable'));
        }
        return value.bind(target);
      },
    });
    return { handle, failing };
  }

  it('keeps failed settlements pending, oldest first, and holds the run until they are written', async () => {
    const database = await db();
    const { handle, failing } = failingHandle(database);
    const run = await openAiRun(store(database), { type: 'turn' });
    const other = await openAiRun(store(database), { type: 'turn' });
    const first = await reserveAiCall(database, run.id, { inputTokens: 5 });
    const second = await reserveAiCall(database, other.id, { inputTokens: 5 });
    const order: string[] = [];
    deferAiRunSettlement(
      handle,
      { runId: run.id, callId: first.callId, usage: usageEvent(10) },
      async () => {
        order.push('first');
      },
    );
    deferAiRunSettlement(
      handle,
      { runId: other.id, callId: second.callId, usage: usageEvent(10) },
      async () => {
        order.push('second');
      },
    );
    expect(pendingAiRunSettlements(handle)).toBe(2);
    // Nothing can be written: both stay, and the run's next reservation
    // waits.
    failing.on = true;
    await expect(
      flushAiRunSettlements(handle, { runId: run.id, attempts: 1 }),
    ).rejects.toThrow(/could not be written yet/);
    expect(order).toEqual([]);
    expect(pendingAiRunSettlements(handle)).toBe(2);
    // However many writes of the list fail, nothing leaves it.
    for (let i = 0; i < 12; i++) {
      await flushAiRunSettlements(handle, { attempts: 1 });
    }
    expect(pendingAiRunSettlements(handle)).toBe(2);
    // Once it can be written, the list drains in order.
    failing.on = false;
    await flushAiRunSettlements(handle);
    expect(order).toEqual(['first', 'second']);
    expect(pendingAiRunSettlements(handle)).toBe(0);
    expect((await getAiRun(database, run.id))?.calls).toBe(1);
    expect((await getAiRun(database, other.id))?.calls).toBe(1);
  });

  it('takes a settlement whose run is gone off the list, keeping its usage row without a run; the rest go on', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const first = await reserveAiCall(database, run.id, { inputTokens: 5 });
    const order: string[] = [];
    deferAiRunSettlement(
      database,
      {
        runId: 'gone',
        callId: 'x',
        usage: usageEvent(1, undefined, { runId: 'gone' }),
      },
      async () => {
        order.push('gone');
      },
    );
    deferAiRunSettlement(
      database,
      { runId: run.id, callId: first.callId, usage: usageEvent(10) },
      async () => {
        order.push('first');
      },
    );
    // The run's next reservation is not held by a settlement nothing can take.
    // Another run's entry is written in the background, the run's own in
    // line.
    await reserveAiCall(database, run.id, { inputTokens: 1 });
    expect(order).toContain('first');
    await vi.waitFor(() => expect(pendingAiRunSettlements(database)).toBe(0));
    // The spend stays in the ledger, and its handlers see it.
    expect(order.sort()).toEqual(['first', 'gone']);
    expect((await getAiRun(database, run.id))?.calls).toBe(1);
    const [row] = rowsOf(
      await database.query(
        'SELECT run_id, total_tokens FROM _smrt_ai_usage WHERE id = $1',
        'x',
      ),
    );
    expect(row?.run_id ?? null).toBeNull();
    expect(Number(row?.total_tokens)).toBe(1);
  });

  it('keeps a settlement whose run is gone pending until its usage row is written', async () => {
    const database = await db();
    const failing = { on: true };
    // Only the usage insert fails while `failing.on`.
    const handle = new Proxy(database, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop === 'query') {
          return (sql: string, ...params: unknown[]) =>
            failing.on && /INSERT INTO _smrt_ai_usage/.test(sql)
              ? Promise.reject(new Error('usage table unavailable'))
              : target.query(sql, ...params);
        }
        return value.bind(target);
      },
    });
    const order: string[] = [];
    deferAiRunSettlement(
      handle,
      {
        runId: 'gone',
        callId: 'kept',
        usage: usageEvent(4, undefined, { runId: 'gone' }),
      },
      async () => {
        order.push('kept');
      },
    );
    await flushAiRunSettlements(handle, { attempts: 1 });
    await flushAiRunSettlements(handle, { attempts: 1 });
    // Not dropped on a failed write, and no handler saw it.
    expect(pendingAiRunSettlements(handle)).toBe(1);
    expect(order).toEqual([]);
    failing.on = false;
    await flushAiRunSettlements(handle);
    expect(pendingAiRunSettlements(handle)).toBe(0);
    expect(order).toEqual(['kept']);
    const [row] = rowsOf(
      await database.query(
        'SELECT run_id, total_tokens FROM _smrt_ai_usage WHERE id = $1',
        'kept',
      ),
    );
    expect(row?.run_id ?? null).toBeNull();
    expect(Number(row?.total_tokens)).toBe(4);
  });

  it('keeps a settlement that keeps failing pending, holding only its own run, and writes it once it can', async () => {
    const database = await db();
    const stuck = await openAiRun(store(database), { type: 'turn' });
    const other = await openAiRun(store(database), { type: 'turn' });
    const held = await reserveAiCall(database, stuck.id, { inputTokens: 5 });
    const fine = await reserveAiCall(database, other.id, { inputTokens: 5 });
    // A parent cycle: reading the chain throws a TypeError, never retried
    // within a write, and never a reason to drop the settlement.
    await database.query(
      'UPDATE _smrt_ai_runs SET parent_run_id = $1 WHERE id = $1',
      stuck.id,
    );
    const order: string[] = [];
    deferAiRunSettlement(
      database,
      { runId: stuck.id, callId: held.callId, usage: usageEvent(10) },
      async () => {
        order.push('stuck');
      },
    );
    deferAiRunSettlement(
      database,
      { runId: other.id, callId: fine.callId, usage: usageEvent(10) },
      async () => {
        order.push('other');
      },
    );
    // The other run's settlement is written past the stuck one, and the
    // other run reserves; the stuck run's next reservation waits, however
    // many times it is tried.
    await reserveAiCall(database, other.id, { inputTokens: 1 });
    expect(order).toEqual(['other']);
    expect((await getAiRun(database, other.id))?.calls).toBe(1);
    for (let i = 0; i < 12; i++) {
      await expect(
        reserveAiCall(database, stuck.id, { inputTokens: 1 }),
      ).rejects.toThrow(/could not be written yet/);
    }
    expect(pendingAiRunSettlements(database)).toBe(1);
    // No usage row was written on its own: the spend waits for its run.
    expect(
      rowsOf(
        await database.query(
          'SELECT id FROM _smrt_ai_usage WHERE id = $1',
          held.callId,
        ),
      ),
    ).toHaveLength(0);
    // Once the bug is fixed, the settlement is written and charged.
    await database.query(
      'UPDATE _smrt_ai_runs SET parent_run_id = NULL WHERE id = $1',
      stuck.id,
    );
    await reserveAiCall(database, stuck.id, { inputTokens: 1 });
    expect(order).toEqual(['other', 'stuck']);
    expect(pendingAiRunSettlements(database)).toBe(0);
    expect((await reservation(database, held.callId))?.reservation).toBe(
      'settled',
    );
    expect((await getAiRun(database, stuck.id))?.calls).toBe(1);
  });

  it("never makes a run's reservation wait for another run's stuck settlement", async () => {
    const database = await db();
    const stuck = await openAiRun(store(database), { type: 'turn' });
    const other = await openAiRun(store(database), { type: 'turn' });
    const call = await reserveAiCall(database, stuck.id, { inputTokens: 5 });
    // Only the stuck call's settle transaction fails (retryably, as a lock
    // timeout would), after it ran; every other transaction goes through.
    const failing = { on: true };
    let attempts = 0;
    const handle = new Proxy(database, {
      get(target, prop) {
        const value = Reflect.get(target, prop, target);
        if (typeof value !== 'function') return value;
        if (prop !== 'transaction') return value.bind(target);
        const transaction = value.bind(target) as NonNullable<
          DatabaseInterface['transaction']
        >;
        return (operation: (tx: DatabaseInterface) => Promise<unknown>) =>
          transaction(async (tx: DatabaseInterface) => {
            const result = await operation(tx);
            const settled = rowsOf(
              await tx.query(
                'SELECT id FROM _smrt_ai_usage WHERE id = $1',
                call.callId,
              ),
            );
            if (settled.length > 0 && failing.on) {
              attempts++;
              throw new Error('lock timeout');
            }
            return result;
          });
      },
    });
    let handled = 0;
    deferAiRunSettlement(
      handle,
      { runId: stuck.id, callId: call.callId, usage: usageEvent(10) },
      async () => {
        handled++;
      },
    );
    // (a) The stuck run's own flush is writing it, with eight tries and
    // their backoff: the other run's reservation does not wait for that.
    let ownDone = false;
    const own = flushAiRunSettlements(handle, { runId: stuck.id, attempts: 8 })
      .then(
        () => 'written',
        (error: Error) => error.message,
      )
      .finally(() => {
        ownDone = true;
      });
    await reserveAiCall(handle, other.id, { inputTokens: 1 });
    expect(ownDone).toBe(false);
    expect(attempts).toBeLessThan(8);
    expect(await own).toMatch(/could not be written yet/);
    // Its eight tries, and none added by the other run.
    expect(attempts).toBe(8);
    // (b) With no write in flight, each reservation of the other run tries
    // it at most once, in the background, and never waits for it.
    for (let i = 1; i <= 3; i++) {
      await reserveAiCall(handle, other.id, { inputTokens: 1 });
      await vi.waitFor(() => expect(attempts).toBe(8 + i));
      // Let the background write finish before the next reservation.
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(pendingAiRunSettlements(handle)).toBe(1);
    expect(handled).toBe(0);
    expect((await getAiRun(database, other.id))?.reservedCalls).toBe(4);
    // (c) Once it can be written, the stuck run's own reservation writes it
    // in line: charged once, its handler called once.
    failing.on = false;
    await reserveAiCall(handle, stuck.id, { inputTokens: 1 });
    expect(pendingAiRunSettlements(handle)).toBe(0);
    expect(handled).toBe(1);
    await flushAiRunSettlements(handle);
    await reserveAiCall(handle, other.id, { inputTokens: 1 });
    expect(handled).toBe(1);
    expect(await usageRows(database, call.callId)).toHaveLength(1);
    expect(await getAiRun(database, stuck.id)).toMatchObject({
      calls: 1,
      tokens: 10,
    });
    expect((await reservation(database, call.callId))?.reservation).toBe(
      'settled',
    );
  });

  it('charges a pending settlement once when the sweep abandoned its reservation meanwhile (settled_late)', async () => {
    const database = await db();
    const { handle, failing } = failingHandle(database);
    let now = new Date('2026-01-01T00:00:00.000Z');
    const clock = { now: () => now };
    const run = await openAiRun(store(database), { type: 'turn' }, clock);
    const call = await reserveAiCall(
      database,
      run.id,
      { inputTokens: 5 },
      clock,
    );
    let handled = 0;
    deferAiRunSettlement(
      handle,
      { runId: run.id, callId: call.callId, usage: usageEvent(40) },
      async () => {
        handled++;
      },
    );
    failing.on = true;
    await flushAiRunSettlements(handle, { attempts: 1, ...clock });
    expect(pendingAiRunSettlements(handle)).toBe(1);
    // The backstop: past the stale threshold the sweep abandons the
    // reservation and returns its room; the run is not charged yet, and
    // its totals check shows nothing wrong (the call has no usage row).
    now = new Date(now.getTime() + 2 * 60 * 60_000);
    expect((await sweepAiRuns(database, clock)).abandoned).toBe(1);
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 0,
      tokens: 0,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    expect((await checkAiRunTotals(database, run.id)).matches).toBe(true);
    // The flush then writes it: charged once, late.
    failing.on = false;
    await flushAiRunSettlements(handle, clock);
    expect(pendingAiRunSettlements(handle)).toBe(0);
    expect(handled).toBe(1);
    expect((await reservation(database, call.callId))?.reservation).toBe(
      'settled_late',
    );
    const charged = await getAiRun(database, run.id);
    expect(charged).toMatchObject({
      calls: 1,
      tokens: 40,
      reservedCalls: 0,
      reservedTokens: 0,
    });
    // Nothing more to write or charge.
    await flushAiRunSettlements(handle, clock);
    await sweepAiRuns(database, clock);
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      tokens: 40,
    });
    expect(handled).toBe(1);
    expect(await checkAiRunTotals(database, run.id)).toMatchObject({
      verifiable: true,
      matches: true,
    });
  });

  it('warns about a settlement still pending at most once per interval', async () => {
    const database = await db();
    const { handle, failing } = failingHandle(database);
    const run = await openAiRun(store(database), { type: 'turn' });
    const call = await reserveAiCall(database, run.id, { inputTokens: 5 });
    deferAiRunSettlement(handle, {
      runId: run.id,
      callId: call.callId,
      usage: usageEvent(10),
    });
    let now = new Date('2026-01-01T00:00:00.000Z');
    const clock = { now: () => now };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const pendingWarnings = () =>
      warn.mock.calls.filter((args) =>
        args.some((arg) => /is still pending/.test(String(arg))),
      ).length;
    try {
      failing.on = true;
      for (let i = 0; i < 5; i++) {
        await flushAiRunSettlements(handle, { attempts: 1, ...clock });
      }
      expect(pendingWarnings()).toBe(1);
      now = new Date(now.getTime() + AI_RUN_PENDING_WARN_INTERVAL_MS);
      await flushAiRunSettlements(handle, { attempts: 1, ...clock });
      expect(pendingWarnings()).toBe(2);
    } finally {
      warn.mockRestore();
      failing.on = false;
    }
    await flushAiRunSettlements(handle);
    expect(pendingAiRunSettlements(handle)).toBe(0);
  });

  it('writes each pending settlement once across concurrent flushes, handlers once each', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const calls = [
      await reserveAiCall(database, run.id, { inputTokens: 5 }),
      await reserveAiCall(database, run.id, { inputTokens: 5 }),
      await reserveAiCall(database, run.id, { inputTokens: 5 }),
    ];
    const order: string[] = [];
    for (const [i, call] of calls.entries()) {
      deferAiRunSettlement(
        database,
        { runId: run.id, callId: call.callId, usage: usageEvent(10) },
        async () => {
          order.push(`call-${i}`);
        },
      );
    }
    await Promise.all([
      flushAiRunSettlements(database),
      flushAiRunSettlements(database),
      flushAiRunSettlements(database, { runId: run.id }),
    ]);
    expect(order.sort()).toEqual(['call-0', 'call-1', 'call-2']);
    expect(pendingAiRunSettlements(database)).toBe(0);
    for (const call of calls) {
      expect((await reservation(database, call.callId))?.reservation).toBe(
        'settled',
      );
    }
    expect((await getAiRun(database, run.id))?.calls).toBe(3);
  });

  it('lets a usage handler make a tracked call while the list drains', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const first = await reserveAiCall(database, run.id, { inputTokens: 5 });
    const second = await reserveAiCall(database, run.id, { inputTokens: 5 });
    let nested: string | undefined;
    deferAiRunSettlement(
      database,
      { runId: run.id, callId: first.callId, usage: usageEvent(10) },
      async () => {
        // Reserving flushes this same list from inside its handler.
        nested = (await reserveAiCall(database, run.id, { inputTokens: 1 }))
          .callId;
      },
    );
    deferAiRunSettlement(database, {
      runId: run.id,
      callId: second.callId,
      usage: usageEvent(10),
    });
    await flushAiRunSettlements(database);
    expect(nested).toBeDefined();
    expect(pendingAiRunSettlements(database)).toBe(0);
    expect((await getAiRun(database, run.id))?.calls).toBe(2);
  });

  it('refuses a caller-supplied call id that is already reserved', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const held = await reserveAiCall(database, run.id, {
      callId: 'dup-call',
      inputTokens: 5,
    });
    await expect(
      reserveAiCall(database, run.id, { callId: 'dup-call', inputTokens: 5 }),
    ).rejects.toThrow(TypeError);
    await expect(
      reserveAiCalls(database, run.id, [
        { callId: 'twice', inputTokens: 5 },
        { callId: 'twice', inputTokens: 5 },
      ]),
    ).rejects.toThrow(TypeError);
    // Nothing more was reserved, and the held call settles its one event.
    expect((await getAiRun(database, run.id))?.reservedCalls).toBe(1);
    await settleAiCall(database, {
      runId: run.id,
      callId: held.callId,
      usage: usageEvent(10),
    });
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 1,
      reservedCalls: 0,
      reservedTokens: 0,
    });
  });

  it('pages the sweep past reservations not yet stale', async () => {
    const database = await db();
    let now = new Date('2026-11-14T10:00:00.000Z');
    const clock = { now: () => now };
    const untimed = await openAiRun(store(database), { type: 'turn' }, clock);
    const timed = await openAiRun(
      store(database),
      { type: 'turn', budget: { callTimeoutMs: 60_000 } },
      clock,
    );
    // The oldest reservations have the 1 h default; the newer ones 60 s.
    for (let i = 0; i < 2; i++) {
      await reserveAiCall(database, untimed.id, { inputTokens: 5 }, clock);
    }
    now = new Date(now.getTime() + 1_000);
    for (let i = 0; i < 2; i++) {
      await reserveAiCall(database, timed.id, { inputTokens: 5 }, clock);
    }
    now = new Date(now.getTime() + 3 * 60_000);
    expect(await sweepAiRuns(database, { ...clock, batch: 2 })).toMatchObject({
      abandoned: 2,
    });
    expect((await getAiRun(database, untimed.id))?.reservedCalls).toBe(2);
    expect((await getAiRun(database, timed.id))?.reservedCalls).toBe(0);
  });

  it('retries a conflicting accounting transaction, never a typed answer', async () => {
    const database = await db();
    let attempts = 0;
    const value = await withAiRunTransaction(database, async () => {
      attempts++;
      if (attempts < 3) throw new Error('TransactionContext Error: Conflict');
      return 'ok';
    });
    expect(value).toBe('ok');
    expect(attempts).toBe(3);
    let typed = 0;
    await expect(
      withAiRunTransaction(database, async () => {
        typed++;
        throw new AiCallLimitError('no', 'maxCallTokens', 'r');
      }),
    ).rejects.toBeInstanceOf(AiCallLimitError);
    expect(typed).toBe(1);
    let always = 0;
    await expect(
      withAiRunTransaction(database, async () => {
        always++;
        throw new Error('conflict');
      }),
    ).rejects.toThrow('conflict');
    expect(always).toBe(5);
  });

  it('checks the judge chain before sending it, releasing its reservation when stopped', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'fusion' });
    const [, judge] = await reserveAiCalls(database, run.id, [
      { inputTokens: 1, name: 'seat' },
      { inputTokens: 1, name: 'judge' },
    ]);
    await assertAiRunStillRunning(database, run.id);
    await stopAiRun(database, run.id);
    await expect(
      assertAiRunStillRunning(database, run.id, {
        releaseCallId: judge?.callId as string,
      }),
    ).rejects.toBeInstanceOf(AiRunStoppedError);
    expect(
      (await reservation(database, judge?.callId as string))?.reservation,
    ).toBe('released');
  });

  it('tracks calls on a client that carry a run context; others pass untouched', async () => {
    const database = await db();
    const run = await openAiRun(store(database), { type: 'turn' });
    const captures = new Map<string, (event: SmrtAiUsageEvent) => void>();
    const handled: string[] = [];
    const sent: Record<string, unknown>[] = [];
    const raw = {
      async message(_text: string, options: Record<string, unknown> = {}) {
        sent.push(options);
        const tags = (options.usageTags ?? {}) as Record<string, string>;
        const capture = tags.aiCallId ? captures.get(tags.aiCallId) : undefined;
        capture?.({ ...usageEvent(12, 0.001), tags });
        return 'answer';
      },
    };
    const client = withAiRunTracking(raw, {
      target: () => ({ provider: 'openai', model: 'gpt-4o' }),
      rateFor: () => RATE,
      registerCapture: (callId, capture) => {
        captures.set(callId, capture);
        return () => captures.delete(callId);
      },
      afterSettle: async (event) => {
        handled.push(event.tags?.aiCallId ?? '');
      },
    });
    expect(await client.message('plain', { temperature: 0 })).toBe('answer');
    expect(sent[0]).toEqual({ temperature: 0 });

    const context = { runId: run.id, db: database, stepIndex: 1, attempt: 2 };
    await client.message('one', {
      runContext: context,
      usageTags: { callId: 'entry-1', promptKey: 'p' },
    } as never);
    await client.message('two', {
      runContext: context,
      usageTags: { callId: 'entry-1', promptKey: 'p' },
    } as never);
    const [, one, two] = sent;
    expect(one).not.toHaveProperty('runContext');
    expect(one?.maxTokens).toBeUndefined();
    const oneTags = one?.usageTags as Record<string, string>;
    const twoTags = two?.usageTags as Record<string, string>;
    expect(oneTags).toMatchObject({
      callId: 'entry-1',
      runId: run.id,
      stepIndex: '1',
      attempt: '2',
      promptKey: 'p',
    });
    expect(oneTags.aiCallId).not.toBe(twoTags.aiCallId);
    expect(handled).toEqual([oneTags.aiCallId, twoTags.aiCallId]);
    const rows = rowsOf(
      await database.query(
        'SELECT id, call_id, entry_call_id, step_index, attempt, prompt_key FROM _smrt_ai_usage WHERE run_id = $1 ORDER BY id',
        run.id,
      ),
    );
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.call_id).toBe(row.id);
      expect(row).toMatchObject({ entry_call_id: 'entry-1', prompt_key: 'p' });
      expect(Number(row.step_index)).toBe(1);
      expect(Number(row.attempt)).toBe(2);
    }
    expect(await getAiRun(database, run.id)).toMatchObject({
      calls: 2,
      tokens: 24,
    });
    const trajectory = await getRunTrajectory(database, run.id, {
      allowCrossTenant: true,
    });
    expect(
      trajectory?.entries.map((entry) => entry.usage?.totalTokens),
    ).toEqual([12, 12]);
  });

  it('writes one row for a retried save of the same event, never under a call id it did not mint', async () => {
    const database = await db();
    const handler = new AiUsagePersistenceHandler(database);
    const event = usageEvent(3, undefined, {
      aiCallId: 'same',
      callId: 'entry',
    });
    await handler.handle(event);
    await handler.handle(event);
    expect(await usageRows(database, 'same')).toHaveLength(0);
    const rows = rowsOf(
      await database.query(
        "SELECT id, call_id, entry_call_id, tags FROM _smrt_ai_usage WHERE entry_call_id = 'entry'",
      ),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.call_id).toBe(rows[0]?.id);
    expect(JSON.parse(String(rows[0]?.tags))).not.toHaveProperty('aiCallId');
  });
});

describe('concurrent reservations from two SQLite connections (#5005)', () => {
  it('locks root first and never overspends a shared ancestor', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'smrt-ai-runs-'));
    dirs.push(dir);
    const url = join(dir, 'runs.db');
    const one = await newAiRunTestDatabase('sqlite', url);
    const two = await newAiRunTestDatabase('sqlite', url);
    const root = await openAiRun(
      { db: one, usageTracking: true },
      { type: 'workflow', budget: { maxCalls: 6 } },
    );
    const left = await openAiRun(
      { db: one, usageTracking: true },
      { type: 'turn', parentRunId: root.id },
    );
    const right = await openAiRun(
      { db: two, usageTracking: true },
      { type: 'turn', parentRunId: root.id },
    );
    const attempts = Array.from({ length: 10 }, (_, i) =>
      reserveAiCall(i % 2 ? two : one, i % 2 ? right.id : left.id, {
        inputTokens: 1,
      }),
    );
    const results = await Promise.allSettled(attempts);
    const ok = results.filter((r) => r.status === 'fulfilled').length;
    // Each child is stopped at its first refusal; the root never exceeds 6.
    expect(ok).toBeLessThanOrEqual(6);
    expect(ok).toBeGreaterThan(0);
    const after = await getAiRun(one, root.id);
    expect(after?.reservedCalls).toBe(ok);
    const sum =
      ((await getAiRun(one, left.id))?.reservedCalls ?? 0) +
      ((await getAiRun(two, right.id))?.reservedCalls ?? 0);
    expect(sum).toBe(ok);
  });
});
