/**
 * Late usage of tracked calls reaches only its own call
 * (packages/core/agents/ai-usage.md "The tracked client"; docs/content/
 * ai-runs.md section 6.4): the route core keeps for a call it minted an id
 * for checks the event's database, run and tenant, applies a measured event
 * once (after the settlement committed, retried when the correction fails),
 * never lets a metadata-only event erase counts, never overwrites a row of
 * another run or tenant, and lets every event it does not apply reach the
 * usage handlers as it would without the route. When the route is gone, a
 * released call is still settled from its persisted reservation.
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AiUsagePersistenceHandler,
  insertAiUsageRow,
} from '../adapters/ai-usage';
import {
  createAiUsageRecorder,
  dispatchAiUsageEvent,
  resolveAiUsageConfig,
} from '../adapters/ai-usage-recorder';
import * as browserEntry from '../browser';
import { SmrtClass } from '../class';
import type { DecisionClient } from '../decisions';
import * as nodeEntry from '../index';
import {
  type AiRunContext,
  beginAiRunCall,
  flushAiRunSettlements,
  getAiRun,
  openAiRun,
} from '../system/browser';
import {
  closeAiRunTestDatabases,
  newAiRunTestDatabase,
  rowsOf,
} from './fixtures/ai-run-test-db';

afterEach(async () => {
  vi.useRealTimers();
  await closeAiRunTestDatabases();
});

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A usage pipeline writing to `db`, counting what its handlers receive. */
function pipeline(db: DatabaseInterface) {
  const received: SmrtAiUsageEvent[] = [];
  const handlers = [
    new AiUsagePersistenceHandler(db),
    { handle: async (event: SmrtAiUsageEvent) => void received.push(event) },
  ];
  const usageConfig = resolveAiUsageConfig({}, {});
  return {
    received,
    dispatch: (event: SmrtAiUsageEvent) =>
      dispatchAiUsageEvent(event, handlers, usageConfig),
  };
}

function measured(
  context: { runId: string; tenantId?: string | null },
  callId: string,
  tokens: number,
): SmrtAiUsageEvent {
  return {
    provider: 'openai',
    model: 'gpt-4o',
    operation: 'message',
    usage: {
      promptTokens: tokens - 2,
      completionTokens: 2,
      totalTokens: tokens,
    },
    duration: 3,
    timestamp: new Date(),
    tenantId: context.tenantId ?? null,
    tags: { aiCallId: callId, runId: context.runId },
  };
}

async function runOn(db: DatabaseInterface, tenantId: string | null) {
  const run = await openAiRun(
    { db, usageTracking: true, tenantId },
    { type: 'turn' },
  );
  const context: AiRunContext = { runId: run.id, db, tenantId };
  return { run, context };
}

async function ledger(db: DatabaseInterface) {
  return rowsOf(
    await db.query(
      'SELECT id, tenant_id, run_id, total_tokens FROM _smrt_ai_usage ORDER BY id',
    ),
  );
}

/** A call that answered without reporting usage (settled from its fallback). */
async function answered(
  context: AiRunContext,
  flow: ReturnType<typeof pipeline>,
  callId?: string,
) {
  const handle = await beginAiRunCall(context, {
    ...(callId ? { callId } : {}),
    inputTokens: 10,
    fallbackUsage: {
      provider: 'openai',
      model: 'gpt-4o',
      operation: 'message',
    },
    afterSettle: (event) => flow.dispatch(event),
  });
  await handle.succeed();
  return handle.invocation.callId;
}

describe('late usage routing', () => {
  it('keeps the correction off the package entry points', () => {
    for (const entry of [nodeEntry, browserEntry]) {
      expect(entry).not.toHaveProperty('correctAiCallUsage');
      expect(entry).not.toHaveProperty('openAiRunCallRoute');
      expect(entry).not.toHaveProperty('routeAiRunCallUsage');
      expect(entry).not.toHaveProperty('setAiRunLateUsageHooks');
    }
  });

  it('applies a call id only on its own database, run and tenant', async () => {
    const one = await newAiRunTestDatabase('sqlite');
    const two = await newAiRunTestDatabase('sqlite');
    const flowOne = pipeline(one);
    const flowTwo = pipeline(two);
    const a = await runOn(one, 'tenant-one');
    const callId = await answered(a.context, flowOne);
    const before = await getAiRun(one, a.run.id);

    // The same call id and run, delivered on another database: that
    // database records it as its own row, the first is untouched.
    await flowTwo.dispatch(measured(a.context, callId, 50));
    // A forged tag on the right database but another tenant.
    await flowOne.dispatch(
      measured({ runId: a.run.id, tenantId: 'tenant-two' }, callId, 70),
    );
    // A forged tag naming another run.
    await flowOne.dispatch(
      measured({ runId: 'some-other-run', tenantId: 'tenant-one' }, callId, 90),
    );
    await delay(50);
    expect(await getAiRun(one, a.run.id)).toMatchObject({
      calls: before?.calls,
      tokens: before?.tokens,
    });
    // The forged events are rows of their own: a fresh id, in no run. The
    // call's own row is untouched.
    const rowsOne = await ledger(one);
    expect(rowsOne.filter((row) => row.id === callId)).toEqual([
      expect.objectContaining({ total_tokens: null, run_id: a.run.id }),
    ]);
    const forged = rowsOne.filter((row) => row.id !== callId);
    expect(forged.map((row) => row.total_tokens).sort()).toEqual([70, 90]);
    expect(forged.every((row) => row.run_id === null)).toBe(true);
    // There the call id is no tracked call of its, so it is a row of its own.
    expect(await ledger(two)).toEqual([
      expect.objectContaining({ total_tokens: 50 }),
    ]);
    expect((await ledger(two))[0]?.id).not.toBe(callId);
    // Every event the route did not take reached the handlers.
    expect(flowTwo.received).toHaveLength(1);
    expect(flowOne.received).toHaveLength(1 + 2);

    // The call's own measurement still applies, once.
    await flowOne.dispatch(measured(a.context, callId, 12));
    await flowOne.dispatch(measured(a.context, callId, 99));
    await delay(50);
    expect(await getAiRun(one, a.run.id)).toMatchObject({
      calls: 1,
      tokens: 12,
    });
  });

  it("does not let a forged call id take a live call's row or run before it settles", async () => {
    const db = await newAiRunTestDatabase('sqlite');
    const flow = pipeline(db);
    const { run, context } = await runOn(db, 'tenant-one');
    const handle = await beginAiRunCall(context, {
      inputTokens: 10,
      fallbackUsage: {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'message',
      },
      afterSettle: (event) => flow.dispatch(event),
    });
    const callId = handle.invocation.callId;
    // In flight: another tenant, another run, and no run name the call id.
    await flow.dispatch(
      measured({ runId: run.id, tenantId: 'tenant-two' }, callId, 70),
    );
    await flow.dispatch(
      measured({ runId: 'other-run', tenantId: 'tenant-one' }, callId, 80),
    );
    const bare = measured(context, callId, 90);
    delete bare.tags?.runId;
    await flow.dispatch(bare);
    await handle.succeed();
    await delay(50);
    const rows = await ledger(db);
    const own = rows.filter((row) => row.id === callId);
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ tenant_id: 'tenant-one', run_id: run.id });
    const forged = rows.filter((row) => row.id !== callId);
    expect(forged).toHaveLength(3);
    expect(forged.every((row) => row.run_id === null)).toBe(true);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1 });
  });

  it('never lets an event without token counts erase counts or use up the correction', async () => {
    const db = await newAiRunTestDatabase('sqlite');
    const flow = pipeline(db);
    const { run, context } = await runOn(db, 'tenant-one');
    const handle = await beginAiRunCall(context, {
      inputTokens: 10,
      fallbackUsage: {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'message',
      },
      afterSettle: (event) => flow.dispatch(event),
    });
    await handle.succeed({
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    });
    const callId = handle.invocation.callId;
    const metadataOnly = measured(context, callId, 1);
    delete metadataOnly.usage;
    await flow.dispatch(metadataOnly);
    await delay(50);
    expect(await getAiRun(db, run.id)).toMatchObject({ tokens: 5 });
    expect(flow.received).toHaveLength(2);
    await flow.dispatch(measured(context, callId, 12));
    await delay(50);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
    expect((await ledger(db))[0]?.total_tokens).toBe(12);
  });

  it('applies the measurement after a queued settlement commits', async () => {
    const db = await newAiRunTestDatabase('sqlite');
    let busy = true;
    const flaky = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction' && busy) {
          return async () => {
            throw new Error('database is busy');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flow = pipeline(flaky);
    const { run } = await runOn(db, 'tenant-one');
    const context: AiRunContext = {
      runId: run.id,
      db: flaky,
      tenantId: 'tenant-one',
    };
    busy = false;
    const handle = await beginAiRunCall(context, {
      inputTokens: 10,
      fallbackUsage: {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'message',
      },
      afterSettle: (event) => flow.dispatch(event),
    });
    busy = true;
    await handle.succeed(); // every attempt fails: the settlement is queued
    await flow.dispatch(measured(context, handle.invocation.callId, 37));
    // Long enough for any attempt to apply it while the database is busy
    // to have given up.
    await delay(2_000);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 0 });
    busy = false;
    await flushAiRunSettlements(flaky);
    await delay(100);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 37 });
    expect((await ledger(db))[0]?.total_tokens).toBe(37);
  });

  it('keeps a correction whose transaction failed, and applies it on redelivery', async () => {
    const db = await newAiRunTestDatabase('sqlite');
    let busy = false;
    const flaky = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'transaction' && busy) {
          return async () => {
            throw new Error('database is busy');
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const flow = pipeline(flaky);
    const { run } = await runOn(db, 'tenant-one');
    const context: AiRunContext = {
      runId: run.id,
      db: flaky,
      tenantId: 'tenant-one',
    };
    const callId = await answered(context, flow);
    busy = true;
    await flow.dispatch(measured(context, callId, 12));
    await delay(2_000); // the correction's transaction gave up
    busy = false;
    expect(await getAiRun(db, run.id)).not.toMatchObject({ tokens: 12 });
    await flow.dispatch(measured(context, callId, 12));
    await delay(100);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
  });

  it('never corrects another tenant row that holds the call id and run, nor goes below zero', async () => {
    const db = await newAiRunTestDatabase('sqlite');
    const flow = pipeline(db);
    const { run, context } = await runOn(db, 'tenant-one');
    // A row of another tenant already carrying this call id and this run.
    await insertAiUsageRow(
      db,
      {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'message',
        usage: { promptTokens: 400, completionTokens: 100, totalTokens: 500 },
        duration: 1,
        timestamp: new Date(),
        tenantId: 'tenant-two',
      },
      { id: 'held-call-id', runId: run.id },
    );
    await answered(context, flow, 'held-call-id');
    const settled = await getAiRun(db, run.id);
    await flow.dispatch(measured(context, 'held-call-id', 12));
    await delay(50);
    expect(await ledger(db)).toEqual([
      expect.objectContaining({
        id: 'held-call-id',
        tenant_id: 'tenant-two',
        total_tokens: 500,
      }),
    ]);
    const after = await getAiRun(db, run.id);
    expect(after?.tokens).toBe(settled?.tokens);
    expect(after?.tokens).toBeGreaterThanOrEqual(0);
    expect(after?.inclusiveTokens).toBeGreaterThanOrEqual(0);
  });

  it('settles a released call from its reservation once its route is gone', async () => {
    const db = await newAiRunTestDatabase('sqlite');
    const { run, context } = await runOn(db, 'tenant-one');
    const handle = await beginAiRunCall(context, {
      inputTokens: 10,
      fallbackUsage: {
        provider: 'openai',
        model: 'gpt-4o',
        operation: 'message',
      },
    });
    await handle.fail(new Error('provider failed'));
    // The route expires (an hour later, or another worker gets the event).
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 2 * 3_600_000 });
    const received: SmrtAiUsageEvent[] = [];
    const record = createAiUsageRecorder({
      db,
      tenantId: 'tenant-one',
      usage: { handlers: [{ handle: async (e) => void received.push(e) }] },
    });
    const late = measured(context, handle.invocation.callId, 12);
    await record({ ...late, timestamp: new Date() });
    vi.useRealTimers();
    expect(await getAiRun(db, run.id)).toMatchObject({
      calls: 1,
      tokens: 12,
      reservedCalls: 0,
    });
    expect((await ledger(db)).map((row) => row.total_tokens)).toEqual([12]);
    expect(received).toHaveLength(1);
  });
});

describe('late usage of a fusion gate decision', () => {
  class GateHost extends SmrtClass {
    async start() {
      await this.initialize();
    }
    decide(request: unknown, runContext: AiRunContext) {
      return (
        this as unknown as {
          decideForInference(
            request: unknown,
            options: { runContext: AiRunContext },
          ): Promise<unknown>;
        }
      ).decideForInference(request, { runContext });
    }
    record(event: unknown) {
      return this.recordAiUsageEvent(event, {});
    }
  }

  const request = {
    state: { content: 'enough so far?' },
    questions: { done: { type: 'predicate', instructions: 'is it done?' } },
  };

  async function gate(reportDuringDecision: boolean) {
    const received: SmrtAiUsageEvent[] = [];
    let tags: Record<string, string> = {};
    let host: GateHost | undefined;
    const decisions: DecisionClient = {
      getCapabilities: async () => ({ decisions: true }),
      decide: async (_request, options) => {
        tags = {
          ...((options as { usageTags?: Record<string, string> } | undefined)
            ?.usageTags ?? {}),
        };
        if (reportDuringDecision) {
          await host?.record({
            provider: 'openai',
            model: 'gpt-4o-mini',
            operation: 'decision',
            usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
            tags,
          });
        }
        return {
          model: 'gpt-4o-mini',
          provenance: { provider: 'openai', model: 'gpt-4o-mini' },
          answers: { done: { type: 'predicate' as const, probability: 0.9 } },
        };
      },
    };
    host = new GateHost({
      db: ':memory:',
      decisions,
      usage: { handlers: [{ handle: async (e) => void received.push(e) }] },
    } as never);
    await host.start();
    const db = (host as unknown as { db: DatabaseInterface }).db;
    const { run, context } = await runOn(db, null);
    await host.decide(request, context);
    return { host, db, run, tags, received };
  }

  it('applies a measurement that arrives after the decision recorded none', async () => {
    const { host, db, run, tags, received } = await gate(false);
    await host.record({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'decision',
      usage: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
      tags,
    });
    await delay(50);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
    expect((await ledger(db)).map((row) => row.total_tokens)).toEqual([12]);
    expect(received).toHaveLength(1);
  });

  it('keeps a measurement that arrived during the decision', async () => {
    const { db, run, received } = await gate(true);
    await delay(50);
    expect(await getAiRun(db, run.id)).toMatchObject({ calls: 1, tokens: 12 });
    expect((await ledger(db)).map((row) => row.total_tokens)).toEqual([12]);
    expect(received).toHaveLength(1);
  });
});
