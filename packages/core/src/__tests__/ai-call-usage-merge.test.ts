/**
 * One merge for every write of a tracked call's charge (#5516, plan sections
 * 3.3, 3.4 and 3.6; test contract T2, T3, T19, T20, T21, T22, T23, T27).
 * Usage arriving after the closer began is parked on the reservation and
 * charged once by whichever closer commits; a later part corrects the charge
 * by its difference, priced from the rate the reservation recorded; one hour
 * after the call first ended nothing changes it; handlers get one record.
 * Real SQLite and DuckDB (PGlite in its lane), a stub provider client.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import {
  beginAiRunCall,
  checkAiRunTotals,
  finishAiRun,
  flushAiRunSettlements,
  pruneAiRunTrajectories,
  pruneAiUsage,
  releaseAiCall,
  repairAiRunTotals,
  reserveAiCall,
  sweepAiRuns,
} from '../system/browser';
import {
  ageCallEnd,
  closingWrite,
  FIXTURE_RATE,
  flushHeld,
  ledgerFixture,
  MINUTE,
  readOnlyCall,
  resetStub,
  runTotals,
  stub,
  stubGetAI,
  tenantSpend,
  usageRows,
} from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  rowsOf,
} from './fixtures/ai-run-test-db';

const counted = (total: number, prompt = Math.floor(total / 2)) => ({
  promptTokens: prompt,
  completionTokens: total - prompt,
  totalTokens: total,
});
const priced = (total: number, prompt = Math.floor(total / 2)) =>
  (prompt * FIXTURE_RATE.input + (total - prompt) * FIXTURE_RATE.output) / 1000;
/** A clock `hours` ahead, for the sweep's `now`. */
const later = (hours: number) => () =>
  new Date(Date.now() + hours * 60 * MINUTE);

beforeEach(() => {
  config.reset();
  resetStub();
  getAIMock.mockReset();
  getAIMock.mockImplementation(stubGetAI);
});
afterEach(async () => {
  config.reset();
  await closeAiRunTestDatabases();
});

describe.each(aiRunTestEngines)('call ledger merge on %s', (engine) => {
  // -------------------------------------------------------------------------
  // T20: the sum of distinct parts
  // -------------------------------------------------------------------------
  it('bills a two-part continuation the sum of its parts', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      await call.emit({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 15,
      reservedCalls: 0,
    });
    const rows = await usageRows(f.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.total_tokens).toBe(15);
  });

  it('bills a streamed two-part continuation the sum; without a last mark it stays parts', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(8) });
      await call.emit({ index: 1, usage: counted(4) });
    };
    const chunks: unknown[] = [];
    for await (const chunk of f.client.stream('hello')) chunks.push(chunk);
    expect(chunks).toEqual(['a', 'b']);
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(12);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.usageSource).toBe('parts');
  });

  it('parts arriving after the call returned still add up to the sum', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(10);
    await flushHeld();
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 15,
    });
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({ usageSource: 'complete', chargedTokens: 15 });
    expect((await usageRows(f.db))[0]?.total_tokens).toBe(15);
  });

  it('a complete response list is final: a further copy changes nothing', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(4) });
      await call.emit({ index: 1, last: true, usage: counted(6) });
      call.hold({ index: 1, last: true, usage: counted(6) });
      return {
        content: 'answer',
        usage: counted(10),
        usageParts: {
          call: call.sdkCall,
          complete: true,
          parts: [
            { index: 0, usage: counted(4) },
            { index: 1, last: true, usage: counted(6) },
          ],
        },
      };
    };
    await f.client.chat([{ role: 'user', content: 'x' }]);
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({ usageSource: 'complete', chargedTokens: 10 });
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(10);
  });

  it('seventy parts of one call are all billed', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      for (let index = 0; index < 70; index++) {
        await call.emit({
          index,
          ...(index === 69 ? { last: true as const } : {}),
          usage: counted(2),
        });
      }
      return 'answer';
    };
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.chargedTokens).toBe(140);
    expect(JSON.stringify(call.callUsage).length).toBeLessThan(600);
  });

  // -------------------------------------------------------------------------
  // T3: corrections priced from the reservation's rate
  // -------------------------------------------------------------------------
  it('a late first part replaces the fallback charge, priced from call_rate', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(30, 10) });
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 30,
      uncostedCalls: 0,
    });
    expect((await runTotals(f.db, f.run.id)).cost).toBeCloseTo(
      priced(30, 10),
      12,
    );
    const rows = await usageRows(f.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ total_tokens: 30, prompt_tokens: 10 });
  });

  it('an uncosted call measured at exactly its reserved tokens still records its counts', async () => {
    const f = await ledgerFixture(engine, { costed: false });
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(10) });
      return 'answer';
    };
    // 4 characters reserve 1 input token; maxTokens 9 makes 10 reserved.
    await f.client.message('abcd', { maxTokens: 9 });
    const before = await runTotals(f.db, f.run.id);
    expect(before).toMatchObject({ tokens: 10, uncostedCalls: 1 });
    expect((await readOnlyCall(f.db, f.run.id)).usageSource).toBe('fallback');
    await flushHeld();
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.usageSource).toBe('complete');
    expect((await usageRows(f.db))[0]?.total_tokens).toBe(10);
  });

  it('a counted zero-token last part completes the call and moves nothing else', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(0) });
      return 'answer';
    };
    await f.client.message('hello');
    const before = await runTotals(f.db, f.run.id);
    await flushHeld();
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    expect((await readOnlyCall(f.db, f.run.id)).usageSource).toBe('complete');
  });

  it('a part from a model with no rate is still priced from the reservation', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({
        index: 0,
        last: true,
        model: 'model-without-rate',
        usage: counted(20, 10),
      });
      return 'answer';
    };
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.chargedCost).toBeCloseTo(priced(20, 10), 12);
    expect(call.callRate).toEqual(FIXTURE_RATE);
    expect((await usageRows(f.db))[0]?.model).toBe('model-without-rate');
  });

  it('a call reserved without a rate stays uncosted after a correction', async () => {
    const f = await ledgerFixture(engine, { costed: false });
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.callRate).toBeNull();
    expect(call.chargedCost).toBeNull();
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      tokens: 15,
      uncostedCalls: 1,
      cost: 0,
    });
  });

  it("single mode: a cost stated to succeed() is the call's cost", async () => {
    const f = await ledgerFixture(engine);
    const handle = await beginAiRunCall(f.context, {
      inputChars: 40,
      rate: FIXTURE_RATE,
      fallbackUsage: { provider: 'host', model: 'engine', operation: 'chat' },
    });
    await handle.succeed({ usage: counted(10), estimatedCost: 0.75 });
    expect(await readOnlyCall(f.db, f.run.id)).toMatchObject({
      usageSource: 'response',
      chargedTokens: 10,
      chargedCost: 0.75,
    });
  });

  // -------------------------------------------------------------------------
  // T2: usage that arrives before the closer commits is parked
  // -------------------------------------------------------------------------
  it('a part arriving while the closing write is queued is parked and charged once by the queued settlement', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.message('hello');
    restore();
    await flushHeld();
    let call = await readOnlyCall(f.db, f.run.id);
    expect(call.callState).toBe('reserved');
    expect(call.callUsage?.counted).toEqual([[1, 1]]);
    await pruneAiUsage(f.db, { maxRows: 0 });
    await flushAiRunSettlements(f.db);
    call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({
      callState: 'settled',
      usageSource: 'complete',
      chargedTokens: 15,
    });
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 15,
      reservedCalls: 0,
    });
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  it('the sweep charges parts parked on a reservation whose sender is gone', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, usage: counted(12) });
      return 'answer';
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.message('hello');
    restore();
    await flushHeld();
    const swept = await sweepAiRuns(f.db, { now: later(2) });
    expect(swept.settled).toBe(1);
    expect(await readOnlyCall(f.db, f.run.id)).toMatchObject({
      callState: 'settled',
      usageSource: 'parts',
      chargedTokens: 12,
    });
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(12);
  });

  it('fail() after a count-less part settles the call provisionally', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: null });
      throw new Error('provider failed');
    };
    await expect(f.client.message('hello')).rejects.toThrow('provider failed');
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({
      callState: 'settled',
      status: 'failed',
      usageSource: 'provisional',
      chargedTokens: call.reservedTokens,
    });
  });

  it('releaseAiCall settles a reservation whose usage is parked and returns false', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(9) });
      return 'answer';
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.message('hello');
    restore();
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(
      await releaseAiCall(f.db, {
        runId: f.run.id,
        callId: call.callId,
        status: 'cancelled',
      }),
    ).toBe(false);
    expect(await readOnlyCall(f.db, f.run.id)).toMatchObject({
      callState: 'settled',
      chargedTokens: 9,
    });
  });

  // -------------------------------------------------------------------------
  // T23: the sender's late close merges inside the window, inert outside it
  // -------------------------------------------------------------------------
  it('single mode: counts stated by the response come before a captured event', async () => {
    resetStub({ parts: false });
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ usage: counted(7) });
      return { content: 'answer', usage: counted(12) };
    };
    await f.client.chat([{ role: 'user', content: 'x' }]);
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(12);
    expect((await usageRows(f.db))[0]?.total_tokens).toBe(12);
  });

  it('after the sweep charged parked parts, the live sender merges its difference and one record is sent', async () => {
    const records: SmrtAiUsageEvent[] = [];
    const f = await ledgerFixture(engine, {
      usage: {
        handlers: [{ handle: async (e: SmrtAiUsageEvent) => records.push(e) }],
      },
    });
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, usage: counted(4) });
      return {
        content: 'answer',
        usageParts: {
          call: call.sdkCall,
          complete: true,
          parts: [
            { index: 0, usage: counted(10) },
            { index: 1, usage: counted(4) },
            { index: 2, last: true, usage: counted(6) },
          ],
        },
      };
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.chat([{ role: 'user', content: 'x' }]);
    restore();
    await flushHeld();
    await sweepAiRuns(f.db, { now: later(2) });
    expect((await readOnlyCall(f.db, f.run.id)).chargedTokens).toBe(4);
    expect(records).toHaveLength(0);
    await flushAiRunSettlements(f.db);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({
      status: 'ok',
      usageSource: 'complete',
      chargedTokens: 20,
    });
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 20,
    });
    expect(records).toHaveLength(1);
    expect(records[0]?.usage?.totalTokens).toBe(20);
    expect(records[0]?.tags?.aiCallId).toBe(call.callId);
    expect(records[0]?.tags).not.toHaveProperty('aiCallProof');
  });

  it("the sender's late close after the window records its status and changes no amount", async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, usage: counted(10) });
      return {
        content: 'answer',
        usageParts: {
          call: call.sdkCall,
          complete: true,
          parts: [
            { index: 0, usage: counted(10) },
            { index: 1, last: true, usage: counted(15) },
          ],
        },
      };
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.chat([{ role: 'user', content: 'x' }]);
    restore();
    await flushHeld();
    await sweepAiRuns(f.db, { now: later(2) });
    const swept = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, swept.callId, 61 * MINUTE);
    const before = await runTotals(f.db, f.run.id);
    await flushAiRunSettlements(f.db);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.chargedTokens).toBe(10);
    expect(call.status).toBe('ok');
    expect(
      (call.callUsage?.refused as Record<string, number>)?.late_sender,
    ).toBe(1);
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    const check = await checkAiRunTotals(f.db, f.run.id);
    expect(check.refused).toEqual([
      expect.objectContaining({
        callId: call.callId,
        tenantId: 'tenant-a',
        reason: 'late_sender',
        tokens: 25,
        chargedTokens: 10,
      }),
    ]);
  });

  // -------------------------------------------------------------------------
  // T27: after the window nothing charges a call twice
  // -------------------------------------------------------------------------
  it('an abandoned uncharged reservation is charged once when its sender returns after the window', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, last: true, usage: counted(8) });
      return 'answer';
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.message('hello');
    restore();
    expect((await sweepAiRuns(f.db, { now: later(2) })).abandoned).toBe(1);
    const abandoned = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, abandoned.callId, 2 * 60 * MINUTE);
    await flushAiRunSettlements(f.db);
    expect(await readOnlyCall(f.db, f.run.id)).toMatchObject({
      callState: 'settled_late',
      chargedTokens: 8,
    });
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 8,
    });
  });

  it.each([
    'row pruned',
    'reservation pruned',
    'both pruned',
  ] as const)('a sender returning after the window and a sweep charge: %s, never a second charge', async (variant) => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, usage: counted(10) });
      return {
        content: 'answer',
        usageParts: {
          call: call.sdkCall,
          complete: true,
          parts: [{ index: 0, last: true, usage: counted(30) }],
        },
      };
    };
    const restore = beforeStatement(f.db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await f.client.chat([{ role: 'user', content: 'x' }]);
    restore();
    await flushHeld();
    await sweepAiRuns(f.db, { now: later(2) });
    const swept = await readOnlyCall(f.db, f.run.id);
    await ageCallEnd(f.db, swept.callId, 2 * 60 * MINUTE);
    if (variant !== 'reservation pruned') {
      await pruneAiUsage(f.db, { maxRows: 0 });
    }
    if (variant !== 'row pruned') {
      await finishAiRun(f.db, f.run.id, { status: 'done' });
      await f.db.query(
        "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
        f.run.id,
      );
      await pruneAiRunTrajectories(f.db, { maxAgeMs: 0 });
    }
    const before = await runTotals(f.db, f.run.id);
    const rowsBefore = await usageRows(f.db);
    await flushAiRunSettlements(f.db);
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    expect(await usageRows(f.db)).toEqual(rowsBefore);
    const events = rowsOf(
      await f.db.query(
        "SELECT call_state FROM _smrt_ai_run_events WHERE run_id = $1 AND type = 'call'",
        f.run.id,
      ),
    );
    if (variant === 'row pruned') {
      expect(events).toEqual([{ call_state: 'settled' }]);
    } else {
      expect(events).toEqual([]);
      const check = await checkAiRunTotals(f.db, f.run.id);
      expect(check.verifiable).toBe(false);
      expect(check.refused).toEqual([
        expect.objectContaining({
          callId: swept.callId,
          tenantId: 'tenant-a',
          reason: 'reservation_gone',
          tokens: 30,
        }),
      ]);
    }
  });

  // -------------------------------------------------------------------------
  // T21: a client without the capability is billed in single mode
  // -------------------------------------------------------------------------
  it('single mode: a streamed call is charged the counts its provider-level event reported', async () => {
    resetStub({ parts: false });
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ usage: counted(21), model: 'gpt-4o-2026' });
    };
    for await (const _ of f.client.stream('hello')) {
      // drain
    }
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({ usageSource: 'event', chargedTokens: 21 });
    expect(call.callUsage?.mode).toBe('single');
    expect((await usageRows(f.db))[0]?.model).toBe('gpt-4o-2026');
  });

  it('single mode without echoed tags settles from its estimate (limit L7)', async () => {
    resetStub({ parts: false, echo: false });
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.usageSource).toBe('fallback');
    // The provider-level event without tags is ordinary usage of the tenant:
    // recorded here as the limit it is.
    const spend = await tenantSpend(f.db, 'tenant-a');
    expect(spend.rows).toBe(2);
  });

  it('single mode: a later event for a closed call is refused and counted', async () => {
    resetStub({ parts: false });
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ usage: counted(10) });
      call.hold({ usage: counted(15) });
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.chargedTokens).toBe(10);
    expect((call.callUsage?.refused as Record<string, number>)?.no_part).toBe(
      1,
    );
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  it('the same provider label on a client that declares parts is parts mode', async () => {
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    expect((await readOnlyCall(f.db, f.run.id)).callUsage?.mode).toBe('parts');
  });

  // -------------------------------------------------------------------------
  // T19: every engine reaches the same ledger; repair keeps charged amounts
  // -------------------------------------------------------------------------
  it('one scripted sequence gives the expected ledger', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, usage: counted(10, 4) });
      call.hold({ index: 1, last: true, usage: counted(6, 2) });
      call.hold({ index: 1, last: true, usage: counted(6, 2) });
      return 'answer';
    };
    await f.client.message('hello world');
    expect((await readOnlyCall(f.db, f.run.id)).usageSource).toBe('fallback');
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({
      callState: 'settled',
      usageSource: 'complete',
      chargedTokens: 16,
    });
    expect(call.chargedCost).toBeCloseTo(priced(10, 4) + priced(6, 2), 12);
    expect(call.callUsage).toMatchObject({ counted: [[0, 1]], last: 1 });
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 16,
      inclusiveTokens: 16,
    });
    expect((await checkAiRunTotals(f.db, f.run.id)).matches).toBe(true);
  });

  it('repair of a run whose cost is not exact in 32 bits changes nothing', async () => {
    const f = await ledgerFixture(engine, {
      usage: {
        costRates: {
          'openai:gpt-4o': { input: 0.1234567891, output: 0.9876543211 },
        },
      },
    });
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(1234, 617) });
      call.hold({ index: 1, last: true, usage: counted(77, 7) });
      return 'answer';
    };
    await f.client.message('hello');
    const diff = await repairAiRunTotals(f.db, f.run.id);
    expect(diff.tokens).toBe(0);
    expect(Math.abs(diff.cost)).toBeLessThanOrEqual(1e-12);
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    const totals = await runTotals(f.db, f.run.id);
    expect(
      Math.abs(totals.cost - (call.chargedCost ?? 0)) /
        Math.max(1, call.chargedCost ?? 0),
    ).toBeLessThanOrEqual(1e-12);
    const again = await repairAiRunTotals(f.db, f.run.id);
    expect(Math.abs(again.cost)).toBeLessThanOrEqual(1e-12);
    expect((await checkAiRunTotals(f.db, f.run.id)).matches).toBe(true);
  });

  // -------------------------------------------------------------------------
  // T22: whichever way the parts arrived
  // -------------------------------------------------------------------------
  it.each([
    ['all through the call', [false, false, false]],
    ['first late', [true, false, false]],
    ['last two late', [false, true, true]],
    ['all late', [true, true, true]],
  ] as const)('three parts, %s: identical ledger', async (_name, late) => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      const parts = [
        { index: 0, usage: counted(3) },
        { index: 1, usage: counted(5) },
        { index: 2, last: true as const, usage: counted(7) },
      ];
      for (const [i, part] of parts.entries()) {
        if (late[i]) call.hold(part);
        else await call.emit(part);
      }
      // A part seen twice is one part.
      call.hold(parts[0] as never);
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call).toMatchObject({ usageSource: 'complete', chargedTokens: 15 });
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(15);
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Pre-1.21.0 accounting still works through the public calls
  // -------------------------------------------------------------------------
  it('a direct reservation settled through the public calls is charged once', async () => {
    const f = await ledgerFixture(engine);
    const reservation = await reserveAiCall(f.db, f.run.id, {
      inputChars: 40,
      rate: FIXTURE_RATE,
    });
    const { settleAiCall } = await import('../system/browser');
    await settleAiCall(f.db, {
      runId: f.run.id,
      callId: reservation.callId,
      usage: {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'message',
        usage: counted(10),
        duration: 1,
        timestamp: new Date(),
      },
    });
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 10,
    });
  });
});
