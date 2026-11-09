/**
 * The hosted inference gate seam (#4760): before a `source: hosted` call
 * core asks the registered gate; BYO/local/app targets never reach it; a
 * block (or a failing gate: fail closed) writes one zero-usage
 * `operation: 'blocked'` row and throws `InferenceUnavailableError`
 * (`reason: 'entitlement'`) carrying cap, spend and reset; probes decide
 * without recording; `ai:usage` counts blocked rows beside calls.
 */
import { clearRuntimeConfig } from '@happyvertical/smrt-config';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock, messageMock } = vi.hoisted(() => ({
  getAIMock: vi.fn(),
  messageMock: vi.fn(),
}));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import {
  normalizeAiUsageEvent,
  setAiUsageUserResolver,
} from '../adapters/ai-usage-recorder.js';
import { config } from '../config.js';
import { field } from '../decorators';
import {
  type InferenceResolver,
  type InferenceTargetSource,
  setInferenceResolver,
} from '../inference.js';
import {
  type InferenceUnavailableError,
  isInferenceUnavailableError,
} from '../inference-availability.js';
import {
  checkInferenceGate,
  type InferenceGate,
  type InferenceGateDecision,
  type InferenceGateRequest,
  setInferenceGate,
} from '../inference-gate.js';
import { getInferenceStatus } from '../inference-status.js';
import { resolveInferenceTarget } from '../inference-target.js';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { reportAiUsage } from '../system/ai-usage-observability.js';

@smrt()
class Issue4760Doc extends SmrtObject {
  @field({ type: 'text' })
  name: string = 'doc';
}

const BASE_AI = { provider: 'openai', apiKey: 'sk-base', model: 'base-model' };
const RESET = '2026-12-01T00:00:00.000Z';

/** A resolver binding every tier to one target of the given source. */
function resolverFor(source: InferenceTargetSource): InferenceResolver {
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
          model: `${source}-model`,
          source,
        },
      };
    },
  };
}

function gateAnswering(
  answer: InferenceGateDecision | (() => Promise<InferenceGateDecision>),
): InferenceGate & { check: ReturnType<typeof vi.fn> } {
  return {
    check: vi.fn(async (_request: InferenceGateRequest) =>
      typeof answer === 'function' ? answer() : answer,
    ),
  };
}

const BLOCK: InferenceGateDecision = {
  action: 'block',
  details: {
    policy: 'user-cap',
    cap: 5_000_000,
    spend: 5_200_000,
    resetsAt: RESET,
  },
};

async function caught(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    (value) => {
      throw new Error(`expected a rejection, got ${String(value)}`);
    },
    (error: unknown) => error,
  );
}

describe('#4760 hosted inference gate seam', () => {
  const usage = { handle: vi.fn(async (_event: unknown) => {}) };

  beforeEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceGate(undefined);
    setAiUsageUserResolver(undefined);
    usage.handle.mockClear();
    messageMock.mockReset();
    messageMock.mockResolvedValue('done');
    getAIMock.mockReset();
    getAIMock.mockImplementation(async (options: Record<string, unknown>) => ({
      embed: () => {},
      message: messageMock,
      options,
    }));
  });

  afterEach(() => {
    config.reset();
    clearRuntimeConfig();
    setInferenceResolver(undefined);
    setInferenceGate(undefined);
    setAiUsageUserResolver(undefined);
  });

  it('never consults the gate for byo, local or app targets', async () => {
    const gate = gateAnswering(BLOCK);
    setInferenceGate(gate);
    for (const source of ['byo', 'local', 'app'] as const) {
      setInferenceResolver(resolverFor(source));
      const doc = new Issue4760Doc({ ai: BASE_AI } as never);
      await expect(doc.do('summarize', { tier: 'good' })).resolves.toBe('done');
    }
    expect(gate.check).not.toHaveBeenCalled();
  });

  it('runs hosted calls when no gate is registered', async () => {
    setInferenceResolver(resolverFor('hosted'));
    const doc = new Issue4760Doc({ ai: BASE_AI } as never);
    await expect(doc.do('summarize', { tier: 'good' })).resolves.toBe('done');
  });

  it('allows and warns without blocking, asking with the call scope', async () => {
    setInferenceResolver(resolverFor('hosted'));
    for (const decision of [
      { action: 'allow' },
      { action: 'warn', details: { policy: 'tenant-cap', cap: 10, spend: 9 } },
    ] as InferenceGateDecision[]) {
      const gate = gateAnswering(decision);
      setInferenceGate(gate);
      const doc = new Issue4760Doc({ ai: BASE_AI } as never);
      await expect(
        doc.do('summarize', { tier: 'great', promptKey: 'p.k' }),
      ).resolves.toBe('done');
      expect(gate.check).toHaveBeenCalledTimes(1);
      const request = gate.check.mock.calls[0]?.[0] as InferenceGateRequest;
      expect(request).toMatchObject({
        tierRequested: 'great',
        tier: 'great',
        className: 'Issue4760Doc',
        promptKey: 'p.k',
      });
      expect(request.target.source).toBe('hosted');
      expect(request.probe).toBeUndefined();
    }
  });

  it('blocks before any client is built, carrying cap, spend and reset', async () => {
    setInferenceResolver(resolverFor('hosted'));
    setInferenceGate(gateAnswering(BLOCK));
    const doc = new Issue4760Doc({
      ai: BASE_AI,
      usage: { handlers: [usage] },
    } as never);
    getAIMock.mockClear();
    const error = await caught(doc.do('summarize', { tier: 'good' }));
    expect(isInferenceUnavailableError(error)).toBe(true);
    const typed = error as InferenceUnavailableError;
    expect(typed.reason).toBe('entitlement');
    expect(typed.mode).toBe('hosted');
    expect(typed.tier).toBe('good');
    expect(typed.retryable).toBe(false);
    expect(typed.entitlement).toEqual({
      policy: 'user-cap',
      cap: 5_000_000,
      spend: 5_200_000,
      resetsAt: RESET,
    });
    expect(typed.toStatus()).toEqual({
      available: false,
      mode: 'hosted',
      reason: 'entitlement',
      tier: 'good',
      policy: 'user-cap',
      resetsAt: RESET,
    });
    expect(typed.message).toMatch(/spending limit/);
    expect(typed.message).not.toMatch(/sk-/);
    // No hosted client was built and no model call ran.
    expect(
      getAIMock.mock.calls.some(
        ([options]) => (options as { apiKey?: string }).apiKey === 'sk-hosted',
      ),
    ).toBe(false);
    expect(messageMock).not.toHaveBeenCalled();
  });

  it('writes one zero-usage blocked row with the audit tags', async () => {
    setInferenceResolver(resolverFor('hosted'));
    setInferenceGate(gateAnswering(BLOCK));
    const doc = new Issue4760Doc({
      ai: BASE_AI,
      usage: { handlers: [usage] },
    } as never);
    await caught(doc.do('summarize', { tier: 'good', promptKey: 'p.k' }));
    expect(usage.handle).toHaveBeenCalledTimes(1);
    const row = usage.handle.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(row).toMatchObject({
      provider: 'openai',
      model: 'hosted-model',
      operation: 'blocked',
      className: 'Issue4760Doc',
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    });
    expect(row.tags).toEqual({
      tierRequested: 'good',
      tierResolved: 'good',
      promptKey: 'p.k',
      source: 'hosted',
      reason: 'entitlement',
      policy: 'user-cap',
      cap: '5000000',
      spend: '5200000',
      resetsAt: RESET,
    });
    expect(JSON.stringify(row)).not.toMatch(/sk-hosted/);
  });

  it('fails closed when the gate throws (a transport failure), as no spend', async () => {
    setInferenceResolver(resolverFor('hosted'));
    setInferenceGate(
      gateAnswering(async () => {
        throw new Error('connect ECONNREFUSED 10.0.0.1:5432');
      }),
    );
    const doc = new Issue4760Doc({
      ai: BASE_AI,
      usage: { handlers: [usage] },
    } as never);
    const error = (await caught(
      doc.do('summarize', { tier: 'good' }),
    )) as InferenceUnavailableError;
    expect(error.reason).toBe('entitlement');
    expect(error.entitlement).toEqual({ policy: 'gate-error' });
    expect(error.message).not.toMatch(/ECONNREFUSED|10\.0\.0\.1/);
    expect(messageMock).not.toHaveBeenCalled();
    const row = usage.handle.mock.calls[0]?.[0] as {
      operation: string;
      usage: { totalTokens: number };
      tags: Record<string, string>;
    };
    expect(row.operation).toBe('blocked');
    expect(row.usage.totalTokens).toBe(0);
    expect(row.tags.policy).toBe('gate-error');
    expect(row.tags.cap).toBeUndefined();
    expect(row.tags.spend).toBeUndefined();
  });

  it('fails closed on a malformed decision', async () => {
    const request: InferenceGateRequest = {
      tierRequested: 'good',
      tier: 'good',
      target: { provider: 'openai', source: 'hosted' },
    };
    for (const answer of [
      undefined,
      { action: 'maybe' },
      { action: 'block' },
      { action: 'warn', details: { policy: '' } },
    ]) {
      const gate = { check: async () => answer as never };
      expect(await checkInferenceGate(request, gate)).toEqual({
        action: 'block',
        details: { policy: 'gate-error' },
      });
    }
    // Non-integer amounts are dropped, never passed on as money.
    expect(
      await checkInferenceGate(request, {
        check: async () => ({
          action: 'block',
          details: { policy: 'tenant-cap', cap: 1.5, spend: 'x' as never },
        }),
      }),
    ).toEqual({ action: 'block', details: { policy: 'tenant-cap' } });
  });

  it('passes a shared client as userId: null and the instance tenant', async () => {
    setInferenceResolver(resolverFor('hosted'));
    const gate = gateAnswering({ action: 'allow' });
    setInferenceGate(gate);
    class SharedDoc extends Issue4760Doc {
      tenantId = 'tenant-a';
      protected override inferenceUserScope(): null {
        return null;
      }
    }
    const doc = new SharedDoc({ ai: BASE_AI } as never);
    await doc.do('summarize', { tier: 'good' });
    expect(gate.check.mock.calls[0]?.[0]).toMatchObject({
      tenantId: 'tenant-a',
      userId: null,
    });
  });

  it('probes decide without recording or calling a model', async () => {
    setInferenceResolver(resolverFor('hosted'));
    const gate = gateAnswering(BLOCK);
    setInferenceGate(gate);
    const doc = new Issue4760Doc({
      ai: BASE_AI,
      usage: { handlers: [usage] },
    } as never);
    const expected = {
      available: false,
      mode: 'hosted',
      reason: 'entitlement',
      tier: 'good',
      policy: 'user-cap',
      resetsAt: RESET,
    };
    expect(await doc.getInferenceStatus({ tier: 'auto' })).toEqual(expected);
    expect(await getInferenceStatus({ tier: 'auto' })).toEqual(expected);
    expect(gate.check.mock.calls.every(([r]) => r.probe === true)).toBe(true);
    expect(usage.handle).not.toHaveBeenCalled();
    expect(messageMock).not.toHaveBeenCalled();

    setInferenceGate(gateAnswering({ action: 'allow' }));
    expect(await doc.getInferenceStatus({ tier: 'good' })).toMatchObject({
      available: true,
      mode: 'hosted',
    });
  });

  it('gates raw getAI() sites through resolveInferenceTarget()', async () => {
    setInferenceResolver(resolverFor('hosted'));
    setInferenceGate(
      gateAnswering({
        action: 'block',
        details: { policy: 'kill-switch', disabledBy: 'global' },
      }),
    );
    config({ usage: { handlers: [usage] } });
    const error = (await caught(
      resolveInferenceTarget({
        base: BASE_AI,
        className: 'ChatRoute',
        tenantId: 'tenant-a',
        usage: {},
      }),
    )) as InferenceUnavailableError;
    expect(error.reason).toBe('entitlement');
    expect(error.entitlement).toEqual({
      policy: 'kill-switch',
      disabledBy: 'global',
    });
    expect(error.message).toMatch(/paused/);
    expect(usage.handle).toHaveBeenCalledTimes(1);
    expect(usage.handle.mock.calls[0]?.[0]).toMatchObject({
      operation: 'blocked',
      className: 'ChatRoute',
      tenantId: 'tenant-a',
      tags: { policy: 'kill-switch', disabledBy: 'global', source: 'hosted' },
    });

    // A byo binding never reaches the gate.
    setInferenceResolver(resolverFor('byo'));
    await expect(
      resolveInferenceTarget({ base: BASE_AI, usage: {} }),
    ).resolves.toMatchObject({ bound: true, source: 'byo' });
  });

  it('gates a chain stamped hosted before its executor client is built', async () => {
    const createClient = vi.fn(() => ({ message: async () => 'ran' }));
    const { setInferenceExecutor } = await import('../inference.js');
    setInferenceExecutor({ kinds: ['candidates'], createClient } as never);
    try {
      setInferenceResolver({
        resolve: () => ({
          tierResolved: 'good',
          via: 'resolver',
          target: { candidates: [{ provider: 'openai' }], source: 'hosted' },
        }),
      });
      setInferenceGate(gateAnswering(BLOCK));
      const doc = new Issue4760Doc({
        ai: BASE_AI,
        usage: { handlers: [usage] },
      } as never);
      const error = await caught(doc.do('summarize', { tier: 'good' }));
      expect(isInferenceUnavailableError(error)).toBe(true);
      expect(createClient).not.toHaveBeenCalled();
      expect(usage.handle).toHaveBeenCalledTimes(1);
      expect(await doc.getInferenceStatus({ tier: 'good' })).toMatchObject({
        available: false,
        reason: 'entitlement',
      });
    } finally {
      setInferenceExecutor(undefined);
    }
  });

  it('gates a hosted target the executor reaches (a ladder step), without a second failed row', async () => {
    const recorded: unknown[] = [];
    const executor = {
      kinds: ['candidates'],
      createClient: (context: {
        clientFor(target: object): Promise<unknown>;
        recordUsage(record: unknown): Promise<void>;
      }) => ({
        async message() {
          await context.clientFor({ provider: 'openai', source: 'hosted' });
          return 'unreachable';
        },
      }),
    };
    const { setInferenceExecutor } = await import('../inference.js');
    setInferenceExecutor(executor as never);
    try {
      setInferenceResolver({
        resolve: () => ({
          tierResolved: 'good',
          via: 'resolver',
          target: { candidates: [{ provider: 'openai' }] },
        }),
      });
      setInferenceGate(gateAnswering(BLOCK));
      const doc = new Issue4760Doc({
        ai: BASE_AI,
        usage: {
          handlers: [{ handle: async (e: unknown) => recorded.push(e) }],
        },
      } as never);
      const error = await caught(doc.do('summarize', { tier: 'good' }));
      expect(isInferenceUnavailableError(error)).toBe(true);
      expect(recorded).toHaveLength(1);
      expect(recorded[0]).toMatchObject({ operation: 'blocked' });
    } finally {
      setInferenceExecutor(undefined);
    }
  });

  it('tags usage rows with the ambient user unless one is given', () => {
    setAiUsageUserResolver(() => 'user-1');
    const event = (tags?: Record<string, string>) =>
      normalizeAiUsageEvent(
        { provider: 'openai', model: 'm', operation: 'chat', tags },
        undefined,
      );
    expect(event()?.tags).toEqual({ userId: 'user-1' });
    expect(event({ userId: 'explicit' })?.tags).toEqual({ userId: 'explicit' });
    setAiUsageUserResolver(() => {
      throw new Error('no context');
    });
    expect(event()?.tags).toBeUndefined();
    setAiUsageUserResolver(undefined);
    expect(event({ a: 'b' })?.tags).toEqual({ a: 'b' });
  });

  it('persists the blocked row and reports it beside calls by tier', async () => {
    setInferenceResolver(resolverFor('hosted'));
    setInferenceGate(gateAnswering(BLOCK));
    const doc = new Issue4760Doc({ db: ':memory:', ai: BASE_AI } as never);
    await doc.initialize();
    await caught(doc.do('summarize', { tier: 'good' }));
    setInferenceGate(gateAnswering({ action: 'allow' }));
    const db = doc.db as DatabaseInterface;
    const rows = (
      await db.query(
        'SELECT operation, total_tokens, tier_requested, tier_resolved, tags FROM _smrt_ai_usage',
      )
    ).rows as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      operation: 'blocked',
      total_tokens: 0,
      tier_requested: 'good',
      tier_resolved: 'good',
    });
    expect(JSON.parse(String(rows[0]?.tags))).toMatchObject({
      reason: 'entitlement',
      policy: 'user-cap',
      cap: '5000000',
      spend: '5200000',
    });

    const report = await reportAiUsage(db, { by: ['tier'] });
    expect(report.totals).toMatchObject({
      calls: 0,
      blocked: 1,
      totalTokens: 0,
    });
    expect(report.buckets).toEqual([
      expect.objectContaining({
        key: { tier: 'good' },
        calls: 0,
        blocked: 1,
        uncostedCalls: 0,
        costedCalls: 0,
      }),
    ]);
    expect(report.unattributedCalls).toBe(0);
    doc.destroy();
  });
});
