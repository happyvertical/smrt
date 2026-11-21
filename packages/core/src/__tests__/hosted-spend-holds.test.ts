/**
 * Hosted spend holds (#5489): a hosted client asks the gate before every
 * send, with the call's estimate already held as spend, and releases the
 * hold when the call fails, is refused, or has written its usage row.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import { config } from '../config.js';
import {
  HOSTED_AI_HOLD_OPERATION,
  isHostedAiHoldRow,
} from '../hosted-inference-holds.js';
import {
  type InferenceResolver,
  type InferenceTargetSource,
  setInferenceResolver,
} from '../inference.js';
import { isInferenceUnavailableError } from '../inference-availability.js';
import {
  type InferenceGate,
  type InferenceGateDecision,
  setInferenceGate,
} from '../inference-gate.js';
import { reportAiUsage } from '../system/ai-usage-observability.js';
import { createTrackedAiClient } from '../tracked-ai-client.js';

const BASE_AI = { provider: 'openai', apiKey: 'sk-base', model: 'base-model' };
/** gpt-4o estimate of "hello" (2 input tokens) with maxTokens 100. */
const ESTIMATE = (2 * 0.0025 + 100 * 0.01) / 1000;
const BLOCK: InferenceGateDecision = {
  action: 'block',
  details: { policy: 'tenant-cap', cap: 1000, spend: 1000 },
};

function binding(source: InferenceTargetSource): InferenceResolver {
  return {
    resolve(request) {
      return {
        tierResolved:
          request.tier === 'auto' ? 'good' : (request.tier as 'good'),
        via: 'resolver',
        target: {
          provider: 'openai',
          baseUrl: `https://${source}.example/v1`,
          apiKey: `sk-${source}`,
          model: 'gpt-4o',
          source,
        },
      };
    },
  };
}

function rowsOf(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const rows = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
}

async function usageRows(
  db: DatabaseInterface,
): Promise<Record<string, unknown>[]> {
  return rowsOf(
    await db.query(
      'SELECT id, operation, estimated_cost, tenant_id, tags FROM _smrt_ai_usage ORDER BY created_at, id',
    ),
  );
}

describe('hosted spend holds (#5489)', () => {
  const dbs: DatabaseInterface[] = [];
  let reported: Record<string, number> | undefined;
  let failNext = false;
  const messages = vi.fn();

  async function memoryDb(): Promise<DatabaseInterface> {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    dbs.push(db);
    return db;
  }

  /** A gate answering `decisions` in turn (then allow), seeing the holds. */
  function gate(
    db: () => DatabaseInterface | undefined,
    decisions: InferenceGateDecision[] = [],
  ) {
    const seen: Record<string, unknown>[][] = [];
    const check = vi.fn(async () => {
      // The check made while the client is built runs before the test
      // holds the database.
      const current = db();
      if (current) {
        seen.push((await usageRows(current)).filter(isHostedAiHoldRow));
      }
      return decisions.shift() ?? ({ action: 'allow' } as const);
    });
    const registered: InferenceGate = { check };
    setInferenceGate(registered);
    return { check, seen };
  }

  beforeEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceGate(undefined);
    reported = { promptTokens: 100, completionTokens: 50, totalTokens: 150 };
    failNext = false;
    messages.mockReset();
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (aiConfig: Record<string, unknown>) => {
      const emit = (operation: string, options: Record<string, unknown>) =>
        (aiConfig.onUsage as (event: unknown) => Promise<void>)({
          provider: 'openai',
          model: 'gpt-4o',
          operation,
          usage: reported,
          duration: 2,
          tags: options.usageTags,
        });
      return {
        async message(_text: string, options: Record<string, unknown> = {}) {
          messages(options);
          if (failNext) throw new Error('provider unavailable');
          await emit('message', options);
          return 'answer';
        },
        async *stream(_text: string, options: Record<string, unknown> = {}) {
          messages(options);
          yield 'streamed';
          await emit('stream', options);
        },
      };
    });
  });

  afterEach(async () => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceGate(undefined);
    for (const db of dbs.splice(0)) {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });

  async function hostedClient(source: InferenceTargetSource = 'hosted') {
    setInferenceResolver(binding(source));
    const db = await memoryDb();
    const tracked = createTrackedAiClient({
      db,
      tenantId: 'tenant-a',
      ai: BASE_AI,
    });
    const client = await tracked.client({
      promptKey: 'test.holds',
      tier: 'good',
    });
    return { db, tracked, client };
  }

  it('asks the gate before every send on a kept client and stops at a block', async () => {
    let db!: DatabaseInterface;
    const { check } = gate(
      () => db,
      [{ action: 'allow' }, { action: 'allow' }, { action: 'allow' }, BLOCK],
    );
    const made = await hostedClient();
    db = made.db;
    await made.client.message('hello', { maxTokens: 100 } as never);
    await made.client.message('hello', { maxTokens: 100 } as never);
    // Once when the client was built, then once per send.
    expect(check).toHaveBeenCalledTimes(3);
    const error = await made.client
      .message('hello', { maxTokens: 100 } as never)
      .then(
        () => undefined,
        (caught: unknown) => caught,
      );
    expect(isInferenceUnavailableError(error)).toBe(true);
    expect(messages).toHaveBeenCalledTimes(2);
  });

  it("holds the call's estimate while the gate is asked, then releases it", async () => {
    let db!: DatabaseInterface;
    const { seen } = gate(() => db);
    const made = await hostedClient();
    db = made.db;
    await made.client.message('hello', { maxTokens: 100 } as never);
    // The send's check saw exactly this call's hold.
    const held = seen[seen.length - 1] ?? [];
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({
      operation: HOSTED_AI_HOLD_OPERATION,
      tenant_id: 'tenant-a',
    });
    expect(Number(held[0]?.estimated_cost)).toBeCloseTo(ESTIMATE, 12);
    expect(JSON.parse(String(held[0]?.tags))).toMatchObject({
      source: 'hosted',
    });
    await vi.waitFor(async () => {
      const rows = await usageRows(db);
      expect(rows.filter(isHostedAiHoldRow)).toEqual([]);
      expect(rows).toHaveLength(1);
    });
    expect(Number((await usageRows(db))[0]?.estimated_cost)).toBeCloseTo(
      (100 * 0.0025 + 50 * 0.01) / 1000,
      12,
    );
  });

  it('releases the hold of a call that fails or is refused', async () => {
    let db!: DatabaseInterface;
    gate(() => db, [{ action: 'allow' }, { action: 'allow' }, BLOCK]);
    const made = await hostedClient();
    db = made.db;
    failNext = true;
    await expect(
      made.client.message('hello', { maxTokens: 100 } as never),
    ).rejects.toThrow('provider unavailable');
    failNext = false;
    await expect(
      made.client.message('hello', { maxTokens: 100 } as never),
    ).rejects.toSatisfy(isInferenceUnavailableError);
    const rows = await usageRows(db);
    expect(rows.filter(isHostedAiHoldRow)).toEqual([]);
    expect(rows.map((row) => row.operation)).toEqual(['blocked']);
  });

  it('records a call outside a run that reports no usage at its held estimate', async () => {
    let db!: DatabaseInterface;
    gate(() => db);
    reported = undefined;
    const made = await hostedClient();
    db = made.db;
    const streaming = made.client as unknown as {
      stream(text: string, options?: unknown): AsyncIterable<unknown>;
    };
    for await (const _chunk of streaming.stream('hello', { maxTokens: 100 })) {
      // drain
    }
    await vi.waitFor(async () => {
      expect((await usageRows(db)).filter(isHostedAiHoldRow)).toEqual([]);
    });
    const rows = await usageRows(db);
    expect(rows).toHaveLength(1);
    expect(Number(rows[0]?.estimated_cost)).toBeCloseTo(ESTIMATE, 12);
    const tags = JSON.parse(String(rows[0]?.tags));
    expect(tags).toMatchObject({
      source: 'hosted',
      usageEstimate: 'reservation',
    });
    expect(tags).not.toHaveProperty('hostedHold');
  });

  it('holds a call of a run and releases it after its settlement', async () => {
    let db!: DatabaseInterface;
    const { seen } = gate(() => db);
    const made = await hostedClient();
    db = made.db;
    const run = await made.tracked.openRun({ type: 'turn' });
    const client = await made.tracked.client(
      { promptKey: 'test.holds', tier: 'good' },
      { runContext: run.context },
    );
    await client.message('hello', { maxTokens: 100 } as never);
    expect(seen[seen.length - 1]).toHaveLength(1);
    const rows = await usageRows(db);
    expect(rows.filter(isHostedAiHoldRow)).toEqual([]);
    expect(rows).toHaveLength(1);
  });

  it('keeps hold rows out of usage reports', async () => {
    let db!: DatabaseInterface;
    let report: Awaited<ReturnType<typeof reportAiUsage>> | undefined;
    const check = vi.fn(async () => {
      if (db) report = await reportAiUsage(db, { tenantId: 'tenant-a' });
      return { action: 'allow' } as const;
    });
    setInferenceGate({ check });
    const made = await hostedClient();
    db = made.db;
    await made.client.message('hello', { maxTokens: 100 } as never);
    expect(report?.totals).toMatchObject({ calls: 0 });
  });

  it('never holds or asks the gate for a byo binding', async () => {
    let db!: DatabaseInterface;
    const { check } = gate(() => db);
    const made = await hostedClient('byo');
    db = made.db;
    await made.client.message('hello', { maxTokens: 100 } as never);
    expect(check).not.toHaveBeenCalled();
    expect((await usageRows(db)).filter(isHostedAiHoldRow)).toEqual([]);
  });
});
