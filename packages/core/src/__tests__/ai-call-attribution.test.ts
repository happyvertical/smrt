/**
 * Who a tracked call bills, and what claims a call (#5516, plan sections 3.1
 * and 3.2; test contract T11, T12 and T15). The billed row is fixed when the
 * call is admitted, from every tag source, and is the same whoever closes
 * the call. An event carrying a call's id or proof is never ordinary usage:
 * without its call's proof it is refused the same way whatever it names.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));
vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import {
  createAiUsageRecorder,
  setAiUsageTenantResolver,
  setAiUsageUserResolver,
} from '../adapters/ai-usage-recorder';
import { config } from '../config';
import {
  beginAiRunCall,
  getAiRun,
  openAiRun,
  releaseAiCall,
  reserveAiCall,
  sweepAiRuns,
} from '../system/browser';
import { createTrackedAiClient } from '../tracked-ai-client';
import {
  closingWrite,
  flushHeld,
  ledgerFixture,
  MINUTE,
  readOnlyCall,
  resetStub,
  stub,
  stubGetAI,
  tenantSpend,
  usageRows,
} from './fixtures/ai-call-ledger-harness';
import {
  aiRunTestEngines,
  beforeStatement,
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  recordStatements,
  rowsOf,
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
  setAiUsageUserResolver(undefined);
  setAiUsageTenantResolver(undefined);
  await closeAiRunTestDatabases();
});

const claimEvent = (tags: Record<string, unknown>) => ({
  provider: 'openai',
  model: 'gpt-4o',
  operation: 'message',
  usage: counted(40),
  duration: 1,
  timestamp: new Date(),
  tags,
});

describe.each(
  aiRunTestEngines,
)('call attribution and claims on %s', (engine) => {
  // ---------------------------------------------------------------------------
  // T11
  // ---------------------------------------------------------------------------
  it("core's tag names are removed from a call's options before the provider sees them", async () => {
    const f = await ledgerFixture(engine);
    const plain = (await f.tracked.client({
      promptKey: 'fixture.prompt',
    })) as unknown as {
      message(input: unknown, options?: unknown): Promise<unknown>;
    };
    await plain.message('hi', {
      usageTags: {
        aiCallId: 'forged-id',
        aiCallProof: 'x'.repeat(43),
        note: 'kept',
      },
    });
    const sentTags = stub.sent[0]?.usageTags as Record<string, string>;
    expect(sentTags).not.toHaveProperty('aiCallId');
    expect(sentTags).not.toHaveProperty('aiCallProof');
    expect(sentTags.note).toBe('kept');
    const rows = await usageRows(f.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).not.toBe('forged-id');
  });

  it("core's tag names are removed from provider-level tag defaults", async () => {
    const db = await newAiRunTestDatabase(engine);
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        usageTags: {
          aiCallId: 'forged',
          aiCallProof: 'y'.repeat(43),
          team: 'kept',
        },
      } as never,
    });
    await (
      (await tracked.client({ promptKey: 'p' })) as unknown as {
        message(input: unknown): Promise<unknown>;
      }
    ).message('hi');
    const built = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(built.usageTags).toEqual({ team: 'kept' });
  });

  it('a claim without a valid pair is refused the same way whatever it names', async () => {
    const handled: SmrtAiUsageEvent[] = [];
    const db = await newAiRunTestDatabase(engine);
    const store = (tenantId: string) => ({ db, usageTracking: true, tenantId });
    const ownRun = await openAiRun(store('tenant-a'), { type: 'turn' });
    const otherRun = await openAiRun(store('tenant-b'), { type: 'turn' });
    const own = await reserveAiCall(db, ownRun.id, { inputChars: 4 });
    const foreign = await reserveAiCall(db, otherRun.id, { inputChars: 4 });
    const recorder = createAiUsageRecorder({
      db,
      tenantId: 'tenant-a',
      usage: { handlers: [{ handle: async (e) => void handled.push(e) }] },
    });
    const statementsFor = async (event: unknown) => {
      const seen: string[] = [];
      const restore = recordStatements(db, (sql) => seen.push(sql));
      await recorder(event);
      restore();
      return seen;
    };
    const absent = await statementsFor(
      claimEvent({ aiCallId: 'no-such-call' }),
    );
    const other = await statementsFor(claimEvent({ aiCallId: foreign.callId }));
    expect(other).toEqual(absent);
    for (const sql of other) expect(sql).not.toMatch(/tenant-b/);
    await recorder(claimEvent({ aiCallId: own.callId }));
    await recorder(claimEvent({ aiCallProof: 'z'.repeat(43) }));
    await releaseAiCall(db, {
      runId: ownRun.id,
      callId: own.callId,
      status: 'failed',
    });
    await recorder(claimEvent({ aiCallId: own.callId }));
    // Two damaged copies at another tenant's recorder.
    const otherRecorder = createAiUsageRecorder({ db, tenantId: 'tenant-b' });
    await otherRecorder(claimEvent({ aiCallId: own.callId, aiCallProof: 7 }));
    await otherRecorder(claimEvent({ aiCallId: own.callId, aiCallProof: 7 }));
    expect(await usageRows(db)).toHaveLength(0);
    expect(handled).toHaveLength(0);
    expect(await tenantSpend(db, 'tenant-a')).toMatchObject({ rows: 0 });
    expect(await tenantSpend(db, 'tenant-b')).toMatchObject({ rows: 0 });
  });

  it("an event naming another call's id never takes that call's row", async () => {
    const f = await ledgerFixture(engine);
    let started: (() => void) | undefined;
    const inFlight = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release: (() => void) | undefined;
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    stub.script.onCall = async (call) => {
      started?.();
      await answered;
      await call.emit({ index: 0, last: true, usage: counted(10) });
      return 'answer';
    };
    const pending = f.client.message('hello');
    await inFlight;
    // Read through columns every version has: the test runs red on 1.20.0.
    const callId = String(
      rowsOf(
        await f.db.query(
          "SELECT call_id FROM _smrt_ai_run_events WHERE run_id = $1 AND type = 'call'",
          f.run.id,
        ),
      )[0]?.call_id,
    );
    await createAiUsageRecorder({ db: f.db, tenantId: 'tenant-a' })(
      claimEvent({ aiCallId: callId }),
    );
    release?.();
    await pending;
    const rows = await usageRows(f.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: callId, total_tokens: 10 });
    expect(await getAiRun(f.db, f.run.id)).toMatchObject({
      calls: 1,
      tokens: 10,
    });
  });

  // ---------------------------------------------------------------------------
  // T12 [relay]
  // ---------------------------------------------------------------------------
  it("a proven delivery at another tenant's recorder or database is refused and runs nothing there", async () => {
    const f = await ledgerFixture(engine);
    let late: Record<string, unknown> | undefined;
    stub.script.onCall = async (call) => {
      await call.emit({ index: 0, usage: counted(10) });
      late = call.build({ index: 1, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('hello');
    const handled: SmrtAiUsageEvent[] = [];
    vi.resetModules();
    const fresh = await import('../adapters/ai-usage-recorder');
    await fresh.createAiUsageRecorder({
      db: f.db,
      tenantId: 'tenant-b',
      usage: { handlers: [{ handle: async (e) => void handled.push(e) }] },
    })(late);
    const elsewhere = await newAiRunTestDatabase(engine);
    await fresh.createAiUsageRecorder({ db: elsewhere, tenantId: 'tenant-a' })(
      late,
    );
    expect(handled).toHaveLength(0);
    expect(await usageRows(elsewhere)).toHaveLength(0);
    expect(await tenantSpend(f.db, 'tenant-b')).toMatchObject({ rows: 0 });
    expect((await readOnlyCall(f.db, f.run.id)).chargedTokens).toBe(10);
  });

  // ---------------------------------------------------------------------------
  // T15
  // ---------------------------------------------------------------------------
  it("a sweep-settled call bills the row its sender was admitted with, not the delivering context's", async () => {
    let user = 'alice';
    setAiUsageUserResolver(() => user);
    const db = await newAiRunTestDatabase(engine);
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        usageTags: { source: 'hosted' },
      } as never,
    });
    const { run, context } = await tracked.openRun({ type: 'workflow' });
    const client = (await tracked.client(
      { promptKey: 'fixture.prompt', templateHash: 'tpl-1' },
      { runContext: { ...context, stepIndex: 2, stepName: 'draft' } },
    )) as unknown as { message(input: unknown): Promise<unknown> };
    stub.script.onCall = async (call) => {
      call.hold({ index: 0, last: true, usage: counted(18) });
      return 'answer';
    };
    const restore = beforeStatement(db, closingWrite, () => {
      throw new TypeError('injected closing failure');
    });
    await client.message('hello');
    restore();
    user = 'mallory';
    await flushHeld();
    await sweepAiRuns(db, {
      now: () => new Date(Date.now() + 2 * 60 * MINUTE),
    });
    const rows = await usageRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      tenant_id: 'tenant-a',
      run_id: run.id,
      total_tokens: 18,
    });
    expect(rows[0]?.tags).toMatchObject({
      source: 'hosted',
      userId: 'alice',
      promptKey: 'fixture.prompt',
      templateHash: 'tpl-1',
      stepIndex: '2',
      stepName: 'draft',
      runId: run.id,
    });
    expect(rows[0]?.tags).not.toHaveProperty('aiCallProof');
    // The per-user meter matches the exact tag fragment (smrt-subscriptions).
    const metered = await db.query(
      `SELECT COALESCE(SUM(total_tokens), 0) AS tokens FROM _smrt_ai_usage
        WHERE tenant_id = $1 AND tags LIKE $2`,
      'tenant-a',
      '%"userId":"alice"%',
    );
    const row = (
      Array.isArray(metered) ? metered : (metered as { rows: unknown[] }).rows
    )[0] as Record<string, unknown>;
    expect(Number(row.tokens)).toBe(18);
  });

  it('provider-level tags with a user and no ambient principal are recorded and metered', async () => {
    const db = await newAiRunTestDatabase(engine);
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: {
        provider: 'openai',
        model: 'gpt-4o',
        usageTags: { source: 'hosted', userId: 'bob' },
      } as never,
    });
    const { context } = await tracked.openRun({ type: 'workflow' });
    await (
      (await tracked.client(
        { promptKey: 'p' },
        { runContext: context },
      )) as unknown as {
        message(input: unknown): Promise<unknown>;
      }
    ).message('hi');
    expect((await usageRows(db))[0]?.tags).toMatchObject({
      source: 'hosted',
      userId: 'bob',
    });
  });

  it('the row is dated at admission whoever closes the call', async () => {
    const f = await ledgerFixture(engine);
    stub.script.onCall = async (call) => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      await call.emit({ index: 0, last: true, usage: counted(5) });
      return 'answer';
    };
    await f.client.message('one');
    const first = await readOnlyCall(f.db, f.run.id);
    const row = (await usageRows(f.db))[0];
    expect(new Date(String(row?.created_at)).getTime()).toBe(
      new Date(String(first.createdAt)).getTime(),
    );
  });

  it("a public caller's row carries the ambient resolver's user", async () => {
    setAiUsageUserResolver(() => 'carol');
    const f = await ledgerFixture(engine);
    const handle = await beginAiRunCall(f.context, {
      inputChars: 10,
      rate: null,
      fallbackUsage: {
        provider: 'claude-code',
        model: 'unknown',
        operation: 'chat',
        tags: { promptKey: 'chat.turn' },
      },
    });
    await handle.succeed({ usage: counted(3) });
    expect((await usageRows(f.db))[0]?.tags).toMatchObject({
      userId: 'carol',
      promptKey: 'chat.turn',
    });
  });

  it('a global tracked client under an ambient tenant writes a global row', async () => {
    setAiUsageTenantResolver(() => 'tenant-ambient');
    const f = await ledgerFixture(engine, { tenantId: null });
    await f.client.message('hi');
    expect((await usageRows(f.db))[0]?.tenant_id).toBeNull();
  });
});
