/**
 * Retention keeps what a tracked call's charge can still need (#5516, plan
 * section 3.5; test contract T6, T7, T8, T16 and T27's retention orders).
 * A call's window is one hour from its first end: inside it the reservation
 * and the usage row both exist, so a permitted change always has what it
 * needs, and a row removed by an older pruner is written again; after it,
 * nothing reads them to change a charge.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import {
  cancelAiRun,
  finishAiRun,
  openAiRun,
  pruneAiRunTrajectories,
  pruneAiUsage,
  releaseAiCall,
  reserveAiCall,
  reserveAiCalls,
  sweepAiRuns,
} from '../system/browser';
import {
  ageCallEnd,
  flushHeld,
  ledgerFixture,
  MINUTE,
  readCalls,
  readOnlyCall,
  resetStub,
  runTotals,
  stub,
  stubGetAI,
  usageRows,
} from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  closeAiRunTestDatabases,
  rowsOf,
} from './fixtures/ai-run-test-db';

const counted = (total: number) => ({
  promptTokens: Math.floor(total / 2),
  completionTokens: total - Math.floor(total / 2),
  totalTokens: total,
});
const at = (minutes: number) => new Date(Date.now() + minutes * MINUTE);

beforeEach(() => {
  config.reset();
  resetStub();
  getAIMock.mockReset();
  getAIMock.mockImplementation(stubGetAI);
});
afterEach(async () => {
  config.reset();
  vi.resetModules();
  await closeAiRunTestDatabases();
});

async function finishLongAgo(
  db: import('@happyvertical/sql').DatabaseInterface,
  runId: string,
) {
  await finishAiRun(db, runId, { status: 'done' }).catch(() => undefined);
  await db.query(
    "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
    runId,
  );
}

describe.each(aiRunTestEngines)('call ledger retention on %s', (engine) => {
  // T8
  it('a cancelled call abandoned by the sweep keeps its events and settles late', async () => {
    const f = await ledgerFixture(engine);
    let answer: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let started: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    stub.script.onCall = async (call) => {
      started?.();
      await answered;
      await call.emit({ index: 0, last: true, usage: counted(11) });
      return 'answer';
    };
    const pending = f.client.message('hello');
    await inFlight;
    await cancelAiRun(f.db, f.run.id);
    expect((await sweepAiRuns(f.db, { now: () => at(90) })).abandoned).toBe(1);
    await pruneAiRunTrajectories(f.db, {
      maxAgeMs: 0,
      sampleRate: 0,
      now: at(90),
    });
    expect(await readCalls(f.db, f.run.id)).toHaveLength(1);
    answer?.();
    await pending;
    expect(await readOnlyCall(f.db, f.run.id)).toMatchObject({
      callState: 'settled_late',
      chargedTokens: 11,
    });
  });

  it('a part at minute 59 after a release is applied; ended_at is unchanged', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(12) });
      throw new Error('provider failed');
    };
    await expect(f.client.message('hello')).rejects.toThrow();
    const released = await readOnlyCall(f.db, f.run.id);
    expect(released.callState).toBe('released');
    await ageCallEnd(f.db, released.callId, 59 * MINUTE);
    const endedAt = (await readOnlyCall(f.db, f.run.id)).endedAt;
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({
      callState: 'settled_late',
      chargedTokens: 12,
    });
    expect(call.endedAt).toBe(endedAt);
  });

  it('a part at minute 61 is refused as expired and the prune removes the events (T6)', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(12) });
      throw new Error('provider failed');
    };
    await expect(f.client.message('hello')).rejects.toThrow();
    const released = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, released.callId, 61 * MINUTE);
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.callState).toBe('released');
    expect((call.callUsage?.refused as Record<string, number>)?.expired).toBe(
      1,
    );
    expect(await usageRows(f.db)).toHaveLength(0);
    await finishLongAgo(f.db, f.run.id);
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    expect(await readCalls(f.db, f.run.id)).toHaveLength(0);
  });

  it('a call ended inside the window keeps its run events through the prune', async () => {
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    await finishLongAgo(f.db, f.run.id);
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    expect(await readCalls(f.db, f.run.id)).toHaveLength(1);
    const call = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, call.callId, 61 * MINUTE);
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    expect(await readCalls(f.db, f.run.id)).toHaveLength(0);
  });

  it('a share not yet admitted and a direct reservation keep their run events; the later release returns the room', async () => {
    const f = await ledgerFixture(engine);
    const shares = await reserveAiCalls(f.db, f.run.id, [
      { name: 'seat-a', inputChars: 40 },
      { name: 'seat-b', inputChars: 40 },
    ]);
    const direct = await reserveAiCall(f.db, f.run.id, { inputChars: 40 });
    await cancelAiRun(f.db, f.run.id);
    await f.db.query(
      "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
      f.run.id,
    );
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    expect(await readCalls(f.db, f.run.id)).toHaveLength(3);
    for (const reservation of [...shares, direct]) {
      expect(
        await releaseAiCall(f.db, {
          runId: f.run.id,
          callId: reservation.callId,
          status: 'cancelled',
        }),
      ).toBe(true);
    }
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      reservedCalls: 0,
      reservedTokens: 0,
    });
  });

  // T16
  it.each([
    ['by age', { maxAgeMs: 0 }],
    ['by row count', { maxRows: 0 }],
  ] as const)('pruneAiUsage %s keeps a correctable row inside the window', async (_name, bound) => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(14) });
      return 'answer';
    };
    await f.client.message('hello');
    expect(await pruneAiUsage(f.db, { ...bound, now: at(1) })).toEqual({
      pruned: 0,
    });
    await flushHeld();
    expect((await usageRows(f.db))[0]?.total_tokens).toBe(14);
    const call = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, call.callId, 61 * MINUTE);
    expect((await pruneAiUsage(f.db, { ...bound, now: at(1) })).pruned).toBe(1);
  });

  it("a row deleted inside the window by an older pruner is written again by the next merge, identical to the sender's", async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(6) });
      return 'answer';
    };
    await f.client.message('hello');
    const original = (await usageRows(f.db))[0];
    // 1.20.0 pruneAiUsage: a plain DELETE by age, no scope for the ledger.
    await f.db.query(
      'DELETE FROM _smrt_ai_usage WHERE created_at < $1',
      at(1).toISOString(),
    );
    expect(await usageRows(f.db)).toHaveLength(0);
    await flushHeld();
    const rebuilt = await usageRows(f.db);
    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]).toMatchObject({
      id: original?.id,
      run_id: original?.run_id,
      tenant_id: original?.tenant_id,
      total_tokens: 16,
      tags: original?.tags,
    });
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(16);
  });

  it("a row of another run under the call's id is never overwritten by a merge", async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(6) });
      return 'answer';
    };
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    await f.db.query(
      "UPDATE _smrt_ai_usage SET run_id = 'someone-else', total_tokens = 99 WHERE id = $1",
      call.callId,
    );
    await flushHeld();
    const rows = await usageRows(f.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ run_id: 'someone-else', total_tokens: 99 });
  });

  // [relay] T6, T7
  it('after the reservation was pruned, copies from other workers are refused and write nothing', async () => {
    const f = await ledgerFixture(engine);
    let late: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      late = call.build({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, call.callId, 2 * 60 * MINUTE);
    await finishLongAgo(f.db, f.run.id);
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    const before = await runTotals(f.db, f.run.id);
    for (let i = 0; i < 2; i++) {
      vi.resetModules();
      const fresh = await import('../adapters/ai-usage-recorder');
      await fresh.createAiUsageRecorder({ db: f.db, tenantId: 'tenant-a' })(
        JSON.parse(JSON.stringify(late)),
      );
    }
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  it("a call id reused by another tenant's call is not the old delivery's call", async () => {
    const f = await ledgerFixture(engine);
    let late: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      late = call.build({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    const old = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, old.callId, 2 * 60 * MINUTE);
    await finishLongAgo(f.db, f.run.id);
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    const other = await openAiRun(
      { db: f.db, usageTracking: true, tenantId: 'tenant-b' },
      { type: 'turn' },
    );
    await reserveAiCall(f.db, other.id, { callId: old.callId, inputChars: 4 });
    const before = rowsOf(
      await f.db.query(
        'SELECT call_state, call_usage FROM _smrt_ai_run_events WHERE run_id = $1',
        other.id,
      ),
    );
    for (const tenantId of ['tenant-a', 'tenant-b']) {
      vi.resetModules();
      const fresh = await import('../adapters/ai-usage-recorder');
      await fresh.createAiUsageRecorder({ db: f.db, tenantId })(late);
    }
    expect(
      rowsOf(
        await f.db.query(
          'SELECT call_state, call_usage FROM _smrt_ai_run_events WHERE run_id = $1',
          other.id,
        ),
      ),
    ).toEqual(before);
    expect(await usageRows(f.db)).toHaveLength(1);
  });
});
