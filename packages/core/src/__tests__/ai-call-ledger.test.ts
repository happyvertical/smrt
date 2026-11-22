/**
 * The call ledger written at reservation and admission, owned transactions,
 * and totals of a pruned run (#5516, plan sections 3.1, 3.7 and 3.8; test
 * contract T10, T24 and T25).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import { withCallerOwnedDatabaseTransaction } from '../embedded-write-queue';
import {
  AiRunClaimLostError,
  type AiRunContext,
  AiRunStoppedError,
  AiRunTotalsUnverifiableError,
  AiRunTransitionError,
  beginAiRunCall,
  cancelAiRun,
  checkAiRunTotals,
  finishAiRun,
  getAiRun,
  openAiRun,
  pruneAiRunTrajectories,
  pruneAiUsage,
  releaseAiCall,
  repairAiRunTotals,
  reserveAiCalls,
  withAiRunTransaction,
} from '../system/browser';
import {
  ageCallEnd,
  FIXTURE_RATE,
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
  beforeStatement,
  closeAiRunTestDatabases,
} from './fixtures/ai-run-test-db';

const counted = (total: number, prompt = Math.floor(total / 2)) => ({
  promptTokens: prompt,
  completionTokens: total - prompt,
  totalTokens: total,
});
const fallback = {
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'message',
} as const;

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

describe.each(aiRunTestEngines)('call ledger on %s', (engine) => {
  // ---------------------------------------------------------------------------
  // T25
  // ---------------------------------------------------------------------------
  it('an ordinary call has its rate, proof, billed row and mode before it is sent', async () => {
    const f = await ledgerFixture(engine);
    let during: Awaited<ReturnType<typeof readOnlyCall>> | undefined;
    stub.script.onCall = async (call) => {
      during = await readOnlyCall(f.db, f.run.id);
      await call.emit({ index: 0, last: true });
      return 'answer';
    };
    await f.client.message('hello');
    expect(during).toMatchObject({
      callState: 'reserved',
      callRate: FIXTURE_RATE,
      callUsage: { mode: 'parts' },
    });
    expect(during?.callProof).toMatch(/^[0-9a-f]{64}$/);
    expect(during?.callRow).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'message',
      tags: expect.objectContaining({ promptKey: 'fixture.prompt' }),
    });
  });

  it('a held share gets its rate at the joint reservation and its proof at admission', async () => {
    const f = await ledgerFixture(engine);
    const [share] = await reserveAiCalls(f.db, f.run.id, [
      { name: 'seat-a', inputChars: 40, rate: FIXTURE_RATE },
    ]);
    if (!share) throw new Error('no share');
    let before = await readOnlyCall(f.db, f.run.id);
    expect(before).toMatchObject({ callRate: FIXTURE_RATE, callProof: null });
    let taken = false;
    const context: AiRunContext = {
      ...f.context,
      reservations: {
        take: () => {
          if (taken) return undefined;
          taken = true;
          return { reservation: share };
        },
      },
    };
    // The rate card changed since the joint reservation.
    const handle = await beginAiRunCall(context, {
      rate: { input: 50, output: 50 },
      fallbackUsage: fallback,
    });
    before = await readOnlyCall(f.db, f.run.id);
    expect(before.callProof).toMatch(/^[0-9a-f]{64}$/);
    expect(before.callUsage).toEqual({ mode: 'single' });
    await handle.succeed({ usage: counted(1000, 400) });
    expect((await readOnlyCall(f.db, f.run.id)).chargedCost).toBeCloseTo(
      1.6,
      12,
    );
  });

  it.each([
    'admitted twice',
    'after release',
    'claim lost',
    'stopped ancestor',
    'another tenant',
  ] as const)('a held share %s is refused with nothing sent', async (variant) => {
    const base = await ledgerFixture(engine);
    // The claim fence guards a durable run's job: that variant's run is one.
    const run =
      variant === 'claim lost'
        ? await openAiRun(
            { db: base.db, usageTracking: true, tenantId: 'tenant-a' },
            { type: 'workflow', durable: true },
          )
        : base.run;
    const f = {
      ...base,
      run,
      context: { ...base.context, runId: run.id },
    };
    const [share] = await reserveAiCalls(f.db, f.run.id, [
      { name: 'seat-a', inputChars: 40, rate: FIXTURE_RATE },
    ]);
    if (!share) throw new Error('no share');
    const held = (checkRunning = false) => ({
      take: () => ({ reservation: share, checkRunning }),
    });
    let context: AiRunContext = { ...f.context, reservations: held() };
    let expected: unknown = AiRunTransitionError;
    if (variant === 'admitted twice') {
      await beginAiRunCall(context, { fallbackUsage: fallback });
    } else if (variant === 'after release') {
      await releaseAiCall(f.db, {
        runId: f.run.id,
        callId: share.callId,
        status: 'cancelled',
      });
    } else if (variant === 'claim lost') {
      context = { ...context, fence: async () => false };
      expected = AiRunClaimLostError;
    } else if (variant === 'stopped ancestor') {
      await cancelAiRun(f.db, f.run.id);
      context = { ...context, reservations: held(true) };
      expected = AiRunStoppedError;
    } else {
      context = { ...context, tenantId: 'tenant-b' };
      expected = Error;
    }
    const proofBefore = (await readCalls(f.db, f.run.id))[0]?.callProof ?? null;
    await expect(
      beginAiRunCall(context, { fallbackUsage: fallback }),
    ).rejects.toBeInstanceOf(expected as never);
    expect(stub.requests).toBe(0);
    const proofAfter = (await readCalls(f.db, f.run.id))[0]?.callProof ?? null;
    expect(proofAfter).toBe(proofBefore);
    if (variant !== 'admitted twice') expect(proofAfter).toBeNull();
  });

  it('a refused reservation leaves nothing', async () => {
    const f = await ledgerFixture(engine, { budget: { maxTokens: 5 } });
    await expect(f.client.message('a long enough request')).rejects.toThrow();
    expect(await readCalls(f.db, f.run.id)).toHaveLength(0);
    expect(stub.requests).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // T10
  // ---------------------------------------------------------------------------
  it('a failure between the usage-row write and the totals write commits nothing; a repeat applies once', async () => {
    const f = await ledgerFixture(engine);
    let late: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      late = call.build({ index: 1, last: true, usage: counted(6) });
      return 'answer';
    };
    await f.client.message('hello');
    const before = {
      call: await readOnlyCall(f.db, f.run.id),
      rows: await usageRows(f.db),
      totals: await runTotals(f.db, f.run.id),
    };
    const restore = beforeStatement(
      f.db,
      (sql) => sql.startsWith('UPDATE _smrt_ai_runs'),
      () => {
        throw new TypeError('injected failure after the row write');
      },
    );
    await stub.onUsage?.(late);
    restore();
    expect(await readOnlyCall(f.db, f.run.id)).toEqual(before.call);
    expect(await usageRows(f.db)).toEqual(before.rows);
    expect(await runTotals(f.db, f.run.id)).toEqual(before.totals);
    await stub.onUsage?.(late);
    await stub.onUsage?.(late);
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(16);
  });

  it.each([
    'framework transaction',
    'caller-declared transaction',
    'adapter transaction handle',
  ] as const)('beginAiRunCall refuses a %s as its database', async (kind) => {
    const f = await ledgerFixture(engine);
    const attempt = async (db: AiRunContext['db']) =>
      beginAiRunCall({ ...f.context, db }, { fallbackUsage: fallback });
    let outcome: unknown;
    if (kind === 'framework transaction') {
      outcome = await withAiRunTransaction(f.db, (tx) =>
        attempt(tx.db).catch((error) => error),
      );
    } else if (kind === 'caller-declared transaction') {
      outcome = await withCallerOwnedDatabaseTransaction(f.db, () =>
        attempt(f.db).catch((error) => error),
      );
    } else {
      const handle = Object.assign(Object.create(f.db), {
        commit: async () => undefined,
        rollback: async () => undefined,
      });
      outcome = await attempt(handle).catch((error) => error);
    }
    expect(outcome).toBeInstanceOf(TypeError);
    expect(await readCalls(f.db, f.run.id)).toHaveLength(0);
    expect(stub.requests).toBe(0);
  });

  it('a stored usage_source of unknown value is left alone by a correction', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    await f.db.query(
      "UPDATE _smrt_ai_run_events SET usage_source = 'imported' WHERE run_id = $1",
      f.run.id,
    );
    await flushHeld();
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.usageSource).toBe('imported');
    expect(call.chargedTokens).toBe(15);
  });

  // ---------------------------------------------------------------------------
  // T24
  // ---------------------------------------------------------------------------
  it.each([
    'every usage row kept',
    'usage rows pruned',
  ] as const)('a run whose trajectory was pruned is unverifiable and not repaired (%s)', async (variant) => {
    // Only public calls and columns every version has: red on 1.20.0.
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    await finishAiRun(f.db, f.run.id, { status: 'done' });
    await f.db.query(
      "UPDATE _smrt_ai_runs SET finished_at = '2000-01-01T00:00:00.000Z' WHERE id = $1",
      f.run.id,
    );
    // Retention two hours from now: the call's window has passed.
    const now = new Date(Date.now() + 2 * 60 * MINUTE);
    await pruneAiRunTrajectories(f.db, { maxAgeMs: 0, now });
    if (variant === 'usage rows pruned') {
      await pruneAiUsage(f.db, { maxRows: 0, now });
    }
    const stored = await getAiRun(f.db, f.run.id);
    const check = await checkAiRunTotals(f.db, f.run.id);
    expect(check).toMatchObject({ verifiable: false, matches: null });
    await expect(repairAiRunTotals(f.db, f.run.id)).rejects.toBeInstanceOf(
      AiRunTotalsUnverifiableError,
    );
    expect(await getAiRun(f.db, f.run.id)).toMatchObject({
      tokens: stored?.tokens,
      costUsed: stored?.costUsed,
      calls: stored?.calls,
    });
  });

  it('check and repair of a kept trajectory use the amounts charged', async () => {
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    // The usage row disagrees with the ledger: the ledger is the authority.
    await f.db.query('UPDATE _smrt_ai_usage SET total_tokens = 999');
    const check = await checkAiRunTotals(f.db, f.run.id);
    expect(check).toMatchObject({ verifiable: true, matches: true });
    expect((await repairAiRunTotals(f.db, f.run.id)).tokens).toBe(0);
  });

  it('a run opened by another store keeps working through the same calls', async () => {
    const f = await ledgerFixture(engine);
    const other = await openAiRun(
      { db: f.db, usageTracking: true, tenantId: 'tenant-a' },
      { type: 'turn' },
    );
    expect((await checkAiRunTotals(f.db, other.id)).matches).toBe(true);
  });
});
