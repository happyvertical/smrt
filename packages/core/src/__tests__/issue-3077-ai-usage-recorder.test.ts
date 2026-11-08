/**
 * #3077: the public AI usage recorder, `SmrtClass#withAiUsage()`, ambient
 * tenant attribution, and gateway model ids in cost estimation.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({ getAIMock: vi.fn() }));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return { ...actual, getAI: getAIMock };
});

import {
  attachAiUsageRecorder,
  createAiUsageRecorder,
  getAiUsageTenantResolver,
  resolveAiUsageTenantId,
  setAiUsageTenantResolver,
} from '../adapters/ai-usage-recorder.js';
import { aiCostRateKeys, estimateAiUsageCost } from '../adapters/cost-rates.js';
import { SmrtClass } from '../class.js';
import { config } from '../config.js';
import * as nodeEntry from '../index.js';

class RecorderTestClass extends SmrtClass {
  async init(): Promise<this> {
    return this.initialize();
  }

  get database(): DatabaseInterface {
    return this._db;
  }
}

class TenantRecorderTestClass extends RecorderTestClass {
  tenantId: string | null = 'tenant-instance';
}

class NullTenantRecorderTestClass extends RecorderTestClass {
  tenantId: string | null = null;
}

const AI = { provider: 'openai', model: 'gpt-4o-mini' };

function usageEvent(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'openai',
    model: 'gpt-4o-mini',
    operation: 'chat',
    usage: { promptTokens: 1000, completionTokens: 500, totalTokens: 1500 },
    duration: 120,
    timestamp: new Date('2026-11-08T00:00:00.000Z'),
    ...overrides,
  };
}

function handlerSpy() {
  return { handle: vi.fn().mockResolvedValue(undefined) };
}

describe('#3077 public AI usage recorder', () => {
  beforeEach(() => {
    config.reset();
    setAiUsageTenantResolver(undefined);
    getAIMock.mockReset();
    getAIMock.mockResolvedValue({
      embed: async () => ({ embeddings: [[]] }),
      message: async () => 'ok',
    });
  });

  afterEach(() => {
    config.reset();
    setAiUsageTenantResolver(undefined);
    vi.restoreAllMocks();
  });

  it('is exported from the Node entry', () => {
    expect(nodeEntry.createAiUsageRecorder).toBe(createAiUsageRecorder);
    expect(nodeEntry.attachAiUsageRecorder).toBe(attachAiUsageRecorder);
    expect(nodeEntry.setAiUsageTenantResolver).toBe(setAiUsageTenantResolver);
  });

  it('persists a per-call event with class, tenant, tags, and cost', async () => {
    const owner = new RecorderTestClass({ db: ':memory:' });
    await owner.init();
    const record = createAiUsageRecorder({
      db: owner.database,
      className: 'ComposeRoute',
      tenantId: 'tenant-explicit',
      tags: { feature: 'compose', promptKey: 'default.key' },
    });

    await record(
      usageEvent({
        model: 'openai/gpt-4o-mini',
        tags: { promptKey: 'site.compose', runId: 'run-1' },
      }),
    );

    const rows = await owner.listAiUsage({ className: 'ComposeRoute' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'openai',
      model: 'openai/gpt-4o-mini',
      operation: 'chat',
      className: 'ComposeRoute',
      tenantId: 'tenant-explicit',
      promptKey: 'site.compose',
      runId: 'run-1',
      tags: { feature: 'compose', promptKey: 'site.compose', runId: 'run-1' },
    });
    // gateway id priced at the openai:gpt-4o-mini default rate
    expect(rows[0].estimatedCost).toBeCloseTo(0.00045, 8);
  });

  it('falls back to the ambient tenant only when none is named', async () => {
    const handler = handlerSpy();
    setAiUsageTenantResolver(() => 'tenant-ambient');

    await createAiUsageRecorder({ usage: { handlers: [handler] } })(
      usageEvent(),
    );
    await createAiUsageRecorder({
      tenantId: 'tenant-explicit',
      usage: { handlers: [handler] },
    })(usageEvent());
    await createAiUsageRecorder({
      tenantId: null,
      usage: { handlers: [handler] },
    })(usageEvent());

    expect(handler.handle.mock.calls.map(([event]) => event.tenantId)).toEqual([
      'tenant-ambient',
      'tenant-explicit',
      null,
    ]);
  });

  it('records no tenant when the resolver is absent, empty, or throws', async () => {
    const handler = handlerSpy();
    const record = createAiUsageRecorder({ usage: { handlers: [handler] } });

    await record(usageEvent());
    setAiUsageTenantResolver(() => '');
    await record(usageEvent());
    setAiUsageTenantResolver(() => {
      throw new Error('no context');
    });
    await record(usageEvent());

    expect(handler.handle.mock.calls.map(([event]) => event.tenantId)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(getAiUsageTenantResolver()).toBeTypeOf('function');
  });

  it('orders tenant sources explicit, instance, ambient', () => {
    setAiUsageTenantResolver(() => 'ambient');
    expect(resolveAiUsageTenantId('explicit', 'instance')).toBe('explicit');
    expect(resolveAiUsageTenantId(null, 'instance')).toBeNull();
    expect(resolveAiUsageTenantId(undefined, 'instance')).toBe('instance');
    expect(resolveAiUsageTenantId(undefined, null)).toBe('ambient');
    expect(resolveAiUsageTenantId(undefined, undefined)).toBe('ambient');
    setAiUsageTenantResolver(undefined);
    expect(resolveAiUsageTenantId(undefined, null)).toBeNull();
    expect(resolveAiUsageTenantId(undefined, undefined)).toBeUndefined();
  });

  it('merges global usage config and honours enabled/persist/estimateCosts', async () => {
    const globalHandler = handlerSpy();
    const localHandler = handlerSpy();
    config({ usage: { handlers: [globalHandler] } });

    await createAiUsageRecorder({
      usage: { handlers: [localHandler], estimateCosts: false },
    })(usageEvent());
    expect(globalHandler.handle).toHaveBeenCalledTimes(1);
    expect(localHandler.handle.mock.calls[0][0].estimatedCost).toBeUndefined();

    await createAiUsageRecorder({
      usage: { enabled: false, handlers: [localHandler] },
    })(usageEvent());
    expect(localHandler.handle).toHaveBeenCalledTimes(1);

    const owner = new RecorderTestClass({ db: ':memory:' });
    await owner.init();
    await createAiUsageRecorder({
      db: owner.database,
      className: 'NoPersist',
      usage: { persist: false },
    })(usageEvent());
    expect(await owner.listAiUsage({ className: 'NoPersist' })).toHaveLength(0);
  });

  it('never rejects: a failing handler or an unusable event is absorbed', async () => {
    const failing = { handle: vi.fn().mockRejectedValue(new Error('boom')) };
    const record = createAiUsageRecorder({ usage: { handlers: [failing] } });

    await expect(record(usageEvent())).resolves.toBeUndefined();
    await expect(record(null)).resolves.toBeUndefined();
    await expect(record({ operation: 'chat' })).resolves.toBeUndefined();
    expect(failing.handle).toHaveBeenCalledTimes(1);
  });

  it('uses aiConfig as the provider/model fallback', async () => {
    const handler = handlerSpy();
    await createAiUsageRecorder({
      aiConfig: { type: 'anthropic', defaultModel: 'claude-haiku-4.5' },
      usage: { handlers: [handler] },
    })({ operation: 'chat', duration: 1 });
    expect(handler.handle.mock.calls[0][0]).toMatchObject({
      provider: 'anthropic',
      model: 'claude-haiku-4.5',
    });
  });

  it('attachAiUsageRecorder keeps the caller onUsage and never stacks', async () => {
    const handler = handlerSpy();
    const callerOnUsage = vi.fn();
    const record = createAiUsageRecorder({ usage: { handlers: [handler] } });
    const original = { ...AI, onUsage: callerOnUsage };

    const once = attachAiUsageRecorder(original, record);
    const twice = attachAiUsageRecorder(once, record);
    expect(original.onUsage).toBe(callerOnUsage);

    await twice.onUsage(usageEvent());
    expect(callerOnUsage).toHaveBeenCalledTimes(1);
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('records even when the caller onUsage throws', async () => {
    const handler = handlerSpy();
    const wired = attachAiUsageRecorder(
      {
        ...AI,
        onUsage: () => {
          throw new Error('caller failed');
        },
      },
      createAiUsageRecorder({ usage: { handlers: [handler] } }),
    );
    await expect(wired.onUsage(usageEvent())).rejects.toThrow('caller failed');
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });
});

describe('#3077 SmrtClass#withAiUsage()', () => {
  beforeEach(() => {
    config.reset();
    setAiUsageTenantResolver(undefined);
    getAIMock.mockReset();
    getAIMock.mockResolvedValue({
      embed: async () => ({ embeddings: [[]] }),
      message: async () => 'ok',
    });
  });

  afterEach(() => {
    config.reset();
    setAiUsageTenantResolver(undefined);
    vi.restoreAllMocks();
  });

  it('routes a per-call config through the instance pipeline', async () => {
    const handler = handlerSpy();
    const callerOnUsage = vi.fn();
    const instance = new RecorderTestClass({ usage: { handlers: [handler] } });
    await instance.init();

    const wired = instance.withAiUsage({ ...AI, onUsage: callerOnUsage });
    await wired.onUsage(usageEvent());

    expect(callerOnUsage).toHaveBeenCalledTimes(1);
    expect(handler.handle.mock.calls[0][0]).toMatchObject({
      className: 'RecorderTestClass',
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
    expect(instance.getAiUsageSnapshot()?.totalCalls).toBe(1);
  });

  it('initializes the pipeline lazily for an uninitialized instance', async () => {
    const handler = handlerSpy();
    const instance = new RecorderTestClass({ usage: { handlers: [handler] } });
    await instance.withAiUsage(AI).onUsage(usageEvent());
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  it('attributes explicit, then instance, then ambient tenant', async () => {
    const handler = handlerSpy();
    setAiUsageTenantResolver(() => 'tenant-ambient');

    const owned = new TenantRecorderTestClass({
      usage: { handlers: [handler] },
    });
    await owned.withAiUsage(AI).onUsage(usageEvent());
    await owned
      .withAiUsage(AI, { tenantId: 'tenant-call' })
      .onUsage(usageEvent());

    const global = new NullTenantRecorderTestClass({
      usage: { handlers: [handler] },
    });
    await global.withAiUsage(AI).onUsage(usageEvent());

    const plain = new RecorderTestClass({ usage: { handlers: [handler] } });
    await plain.withAiUsage(AI).onUsage(usageEvent());

    expect(handler.handle.mock.calls.map(([event]) => event.tenantId)).toEqual([
      'tenant-instance',
      'tenant-call',
      'tenant-ambient',
      'tenant-ambient',
    ]);
  });

  it('keeps the pre-#3077 null tenant when no ambient tenant exists', async () => {
    const handler = handlerSpy();
    const instance = new NullTenantRecorderTestClass({
      ai: AI as never,
      usage: { handlers: [handler] },
    });
    await instance.init();
    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)(usageEvent());
    expect(handler.handle.mock.calls[0][0].tenantId).toBeNull();
  });

  it('the instance client records an already-wired config only once', async () => {
    const instanceHandler = handlerSpy();
    const recorderHandler = handlerSpy();
    const callerOnUsage = vi.fn();
    const wired = attachAiUsageRecorder(
      { ...AI, onUsage: callerOnUsage },
      createAiUsageRecorder({ usage: { handlers: [recorderHandler] } }),
    );
    const instance = new RecorderTestClass({
      ai: wired as never,
      usage: { handlers: [instanceHandler] },
    });
    await instance.init();

    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)(usageEvent());

    expect(callerOnUsage).toHaveBeenCalledTimes(1);
    expect(instanceHandler.handle).toHaveBeenCalledTimes(1);
    expect(recorderHandler.handle).not.toHaveBeenCalled();
  });

  it('a withAiUsage() config set as options.ai records once', async () => {
    const handler = handlerSpy();
    const instance = new RecorderTestClass({ usage: { handlers: [handler] } });
    const wired = instance.withAiUsage(AI);
    const second = new RecorderTestClass({
      ai: wired as never,
      usage: { handlers: [handler] },
    });
    await second.init();
    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)(usageEvent());
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });

  async function recordThroughInstanceClient(
    ai: Record<string, unknown>,
    handler: ReturnType<typeof handlerSpy>,
    Cls: typeof RecorderTestClass = RecorderTestClass,
  ) {
    getAIMock.mockClear();
    const instance = new Cls({
      ai: ai as never,
      usage: { handlers: [handler] },
    });
    await instance.init();
    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)(usageEvent());
    return handler.handle.mock.calls.at(-1)?.[0];
  }

  it('keeps a replaced sink explicit tenant and tags (review round 1)', async () => {
    setAiUsageTenantResolver(() => 'tenant-ambient');
    const handler = handlerSpy();

    const viaRecorder = await recordThroughInstanceClient(
      attachAiUsageRecorder(
        AI,
        createAiUsageRecorder({
          tenantId: 'tenant-explicit',
          tags: { feature: 'compose' },
        }),
      ),
      handler,
      TenantRecorderTestClass,
    );
    expect(viaRecorder).toMatchObject({
      tenantId: 'tenant-explicit',
      className: 'TenantRecorderTestClass',
      tags: { feature: 'compose' },
    });

    const owner = new RecorderTestClass({});
    const viaWithAiUsage = await recordThroughInstanceClient(
      owner.withAiUsage(AI, { tenantId: 'tenant-call', tags: { k: 'v' } }),
      handler,
      TenantRecorderTestClass,
    );
    expect(viaWithAiUsage).toMatchObject({
      tenantId: 'tenant-call',
      tags: { k: 'v' },
    });

    const explicitGlobal = await recordThroughInstanceClient(
      attachAiUsageRecorder(AI, createAiUsageRecorder({ tenantId: null })),
      handler,
    );
    expect(explicitGlobal.tenantId).toBeNull();

    const implicit = await recordThroughInstanceClient(
      attachAiUsageRecorder(AI, createAiUsageRecorder({})),
      handler,
    );
    expect(implicit.tenantId).toBe('tenant-ambient');
    expect(handler.handle).toHaveBeenCalledTimes(4);
  });

  it('a tier client keeps the replaced sink attribution too', async () => {
    class TierRecorder extends RecorderTestClass {
      client(tier: 'cheap') {
        return this.getAiClient(tier);
      }
    }
    const handler = handlerSpy();
    const recorderHandler = handlerSpy();
    const instance = new TierRecorder({
      ai: attachAiUsageRecorder(
        { ...AI, apiKey: 'sk-test' },
        createAiUsageRecorder({
          tenantId: 'tenant-explicit',
          usage: { handlers: [recorderHandler] },
        }),
      ) as never,
      inference: { tiers: { cheap: { model: 'mini' } } },
      usage: { handlers: [handler] },
    } as never);
    await instance.client('cheap');
    const tierConfig = getAIMock.mock.calls.at(-1)?.[0] as Record<
      string,
      unknown
    >;
    expect(tierConfig.model).toBe('mini');
    await (tierConfig.onUsage as (event: unknown) => Promise<void>)(
      usageEvent({ model: 'mini' }),
    );
    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(handler.handle.mock.calls[0][0].tenantId).toBe('tenant-explicit');
    expect(recorderHandler.handle).not.toHaveBeenCalled();
  });

  it('withAiUsage() keeps an existing sink attribution unless overridden (review round 3)', async () => {
    setAiUsageTenantResolver(() => 'tenant-ambient');
    const handler = handlerSpy();
    const instance = new TenantRecorderTestClass({
      usage: { handlers: [handler] },
    });
    const branded = attachAiUsageRecorder(
      AI,
      createAiUsageRecorder({ tenantId: null, tags: { feature: 'f' } }),
    );

    await instance.withAiUsage(branded).onUsage(usageEvent());
    await instance
      .withAiUsage(branded, { tenantId: 'tenant-call' })
      .onUsage(usageEvent());

    expect(handler.handle.mock.calls[0][0]).toMatchObject({
      tenantId: null,
      tags: { feature: 'f' },
    });
    expect(handler.handle.mock.calls[1][0]).toMatchObject({
      tenantId: 'tenant-call',
      tags: { feature: 'f' },
    });
  });

  it('the instance client records even when the caller callback throws (review round 3)', async () => {
    const handler = handlerSpy();
    const wired = attachAiUsageRecorder(
      {
        ...AI,
        onUsage: () => {
          throw new Error('caller failed');
        },
      },
      createAiUsageRecorder({}),
    );
    const instance = new RecorderTestClass({
      ai: wired as never,
      usage: { handlers: [handler] },
    });
    await instance.init();
    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await expect(
      (aiConfig.onUsage as (event: unknown) => Promise<void>)(usageEvent()),
    ).rejects.toThrow('caller failed');
    expect(handler.handle).toHaveBeenCalledTimes(1);
  });
});

describe('#3077 gateway model ids in cost estimation', () => {
  const usage = {
    promptTokens: 1000,
    completionTokens: 500,
    totalTokens: 1500,
  };

  it('tries provider:model, model, then vendor:rest and rest', () => {
    expect(aiCostRateKeys('bifrost', 'openai/gpt-4.1-mini')).toEqual([
      'bifrost:openai/gpt-4.1-mini',
      'openai/gpt-4.1-mini',
      'openai:gpt-4.1-mini',
      'gpt-4.1-mini',
    ]);
    expect(aiCostRateKeys('openai', 'gpt-4o')).toEqual([
      'openai:gpt-4o',
      'gpt-4o',
    ]);
    expect(aiCostRateKeys('x', 'a/b/c')).toEqual([
      'x:a/b/c',
      'a/b/c',
      'a:b/c',
      'b/c',
      'b:c',
      'c',
    ]);
    expect(aiCostRateKeys('x', '/odd/')).toEqual(['x:/odd/', '/odd/']);
  });

  it('prices a gateway id at the vendor rate, preferring exact rates', () => {
    expect(
      estimateAiUsageCost('bifrost', 'openai/gpt-4o-mini', usage),
    ).toBeCloseTo(0.00045, 8);
    expect(
      estimateAiUsageCost('bifrost', 'openai/gpt-4o-mini', usage, {
        'bifrost:openai/gpt-4o-mini': { input: 0.01, output: 0.01 },
      }),
    ).toBeCloseTo(0.015, 8);
  });

  it('never matches an Object.prototype member as a rate', () => {
    expect(estimateAiUsageCost('openai', 'constructor', usage)).toBeUndefined();
    expect(estimateAiUsageCost('gw', 'vendor/toString', usage)).toBeUndefined();
  });
});
