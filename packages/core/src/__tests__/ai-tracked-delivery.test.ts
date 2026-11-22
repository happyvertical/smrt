/**
 * Deliveries of a tracked call's usage (#5516, plan sections 3.2 and 3.4;
 * test contract T4, T5, T9, T28 and the relay rows in their first-version
 * form). In the process that made the call, a late part reaches the call
 * through its secret-keyed locator and is applied by the ledger; a delivery
 * from anywhere else is refused as `relay_unsupported` (relay intake is
 * #5526), writes no row and leaves the charge alone.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config';
import { finishAiRun, getAiRun } from '../system/browser';
import {
  flushHeld,
  ledgerFixture,
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
  recordStatements,
} from './fixtures/ai-run-test-db';

const counted = (total: number) => ({
  promptTokens: Math.floor(total / 2),
  completionTokens: total - Math.floor(total / 2),
  totalTokens: total,
});

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

/** A recorder from a fresh module graph: another process, as far as the call knows. */
async function otherProcessRecorder(db: unknown, tenantId = 'tenant-a') {
  vi.resetModules();
  const fresh = await import('../adapters/ai-usage-recorder');
  return fresh.createAiUsageRecorder({ db: db as never, tenantId });
}

describe.each(aiRunTestEngines)('tracked deliveries on %s', (engine) => {
  // T4
  it('a repeated late part changes nothing after it was applied', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(4) });
      call.hold({ index: 1, last: true, usage: counted(4) });
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(14);
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  it('a copy that differs only in serialization is the same part', async () => {
    const f = await ledgerFixture(engine);
    let copy: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      const event = call.build({ index: 0, last: true, usage: counted(10) });
      copy = JSON.parse(JSON.stringify(event));
      await call.emit({ index: 0, last: true, usage: counted(10) });
      return 'answer';
    };
    await f.client.message('hello');
    await stub.onUsage?.(copy);
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(10);
  });

  it('a late part whose write meets a conflict is applied once by the retry', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(4) });
      return 'answer';
    };
    await f.client.message('hello');
    const restore = beforeStatement(
      f.db,
      (sql) => sql.startsWith('UPDATE _smrt_ai_runs'),
      () => {
        throw new Error('could not serialize access (injected)');
      },
    );
    await flushHeld();
    restore();
    expect(await runTotals(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 14,
    });
  });

  it('a retried call is a new call with its own reservation, proof and row', async () => {
    const f = await ledgerFixture(engine);
    let attempt = 0;
    stub.script.onCall = async (call) => {
      attempt++;
      if (attempt === 1) throw new Error('first attempt failed');
      await call.emit({ index: 0, last: true, usage: counted(6) });
      return 'answer';
    };
    await expect(f.client.message('hello')).rejects.toThrow('first attempt');
    await f.client.message('hello');
    const calls = await readCalls(f.db, f.run.id);
    expect(calls.map((c) => c.callState)).toEqual(['released', 'settled']);
    expect(calls[0]?.callProof).not.toBe(calls[1]?.callProof);
    expect(calls[0]?.callProof).toMatch(/^[0-9a-f]{64}$/);
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  // T5
  it('a late part is applied after the run finished and never changes its status', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    await finishAiRun(f.db, f.run.id, { status: 'done' });
    const finished = await getAiRun(f.db, f.run.id);
    const statements: string[] = [];
    const restore = recordStatements(f.db, (sql) => statements.push(sql));
    await flushHeld();
    restore();
    const after = await getAiRun(f.db, f.run.id);
    expect(after).toMatchObject({ status: 'done', tokens: 15 });
    expect(after?.finishedAt?.getTime()).toBe(finished?.finishedAt?.getTime());
    const first = (pattern: RegExp) =>
      statements.findIndex((sql) => pattern.test(sql));
    const runs = first(/FROM _smrt_ai_runs/);
    const event = first(/FROM _smrt_ai_run_events/);
    const usage = first(/_smrt_ai_usage/);
    expect(runs).toBeGreaterThanOrEqual(0);
    expect(runs).toBeLessThan(event);
    expect(event).toBeLessThan(usage);
  });

  it('a late part of a run whose claim moved is still applied, without a status write', async () => {
    const f = await ledgerFixture(engine);
    let lost = false;
    const fenced = { ...f.context, fence: async () => !lost };
    const client = (await f.tracked.client(
      { promptKey: 'fixture.prompt' },
      { runContext: fenced },
    )) as unknown as { message(input: unknown): Promise<unknown> };
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await client.message('hello');
    lost = true;
    await flushHeld();
    expect(await getAiRun(f.db, f.run.id)).toMatchObject({
      status: 'running',
      tokens: 15,
    });
  });

  // T9 through the entries
  it.each([
    ['part not an object', { part: 'p' }],
    ['negative index', { part: { call: 'x', index: -1 } }],
    ['negative counts', { usage: { totalTokens: -5 } }],
    ['unsafe counts', { usage: { totalTokens: 2 ** 60 } }],
    ['no timestamp', { timestamp: undefined }],
    ['no model', { model: undefined }],
  ] as const)('a malformed late part (%s) is refused and the call stays correctable', async (_name, damage) => {
    const f = await ledgerFixture(engine);
    let bad: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      const event = call.build({ index: 1, last: true, usage: counted(5) });
      const sdkCall = (event.part as { call: string }).call;
      const patched = { ...event, ...damage } as Record<string, unknown>;
      if ('part' in damage && typeof damage.part === 'object') {
        patched.part = { ...damage.part, call: sdkCall };
      }
      for (const [key, value] of Object.entries(damage)) {
        if (value === undefined) delete patched[key];
      }
      bad = patched;
      call.hold({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    await stub.onUsage?.(bad);
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(10);
    expect(await usageRows(f.db)).toHaveLength(1);
    await flushHeld();
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(15);
  });

  it('a recorder refuses an ill-formed proof without writing a row', async () => {
    const f = await ledgerFixture(engine);
    await f.client.message('hello');
    const call = await readOnlyCall(f.db, f.run.id);
    const { createAiUsageRecorder } = await import(
      '../adapters/ai-usage-recorder'
    );
    const recorder = createAiUsageRecorder({ db: f.db, tenantId: 'tenant-a' });
    await recorder({
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'message',
      usage: counted(50),
      duration: 1,
      timestamp: new Date(),
      tags: { aiCallId: call.callId, aiCallProof: 'too-short' },
    });
    expect(await usageRows(f.db)).toHaveLength(1);
    expect((await runTotals(f.db, f.run.id)).tokens).toBe(10);
  });

  // T28
  it('single mode: a late event with or without a part is refused as no_part', async () => {
    resetStub({ parts: false });
    const f = await ledgerFixture(engine);
    let withPart: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ usage: counted(10) });
      call.hold({ usage: counted(4) });
      withPart = {
        ...call.build({ usage: counted(4) }),
        part: { call: 'sdk-x', index: 1 },
      };
      return 'answer';
    };
    await f.client.message('hello');
    await flushHeld();
    await stub.onUsage?.(withPart);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.chargedTokens).toBe(10);
    expect((call.callUsage?.refused as Record<string, number>)?.no_part).toBe(
      2,
    );
    expect(await usageRows(f.db)).toHaveLength(1);
  });

  // [relay] T1, T6, T12, T13: a delivery from another process is refused.
  it('a delivery from another process is refused as relay_unsupported, no row, charge unchanged', async () => {
    const f = await ledgerFixture(engine);
    let late: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      late = call.build({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    const before = await runTotals(f.db, f.run.id);
    const recorder = await otherProcessRecorder(f.db);
    await recorder(late);
    await recorder(JSON.parse(JSON.stringify(late)));
    expect(await runTotals(f.db, f.run.id)).toEqual(before);
    expect(await usageRows(f.db)).toHaveLength(1);
    const call = await readOnlyCall(f.db, f.run.id);
    expect(call.chargedTokens).toBe(10);
    expect(
      (call.callUsage?.refused as Record<string, number>)?.relay_unsupported,
    ).toBe(2);
  });
});
