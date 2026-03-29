/**
 * Integration tests for SmrtClass AI usage tracking
 */

import type { SmrtAiUsageEvent } from '@happyvertical/smrt-types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAIMock } = vi.hoisted(() => ({
  getAIMock: vi.fn(),
}));

vi.mock('@happyvertical/ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@happyvertical/ai')>();
  return {
    ...actual,
    getAI: getAIMock,
  };
});

import { SmrtClass } from '../class.js';
import { config } from '../config.js';

class TestSmrtClass extends SmrtClass {
  async init(): Promise<this> {
    return this.initialize();
  }
}

class TenantTestSmrtClass extends TestSmrtClass {
  tenantId: string | null = 'tenant-123';
}

class RuntimeSingleFlightTestSmrtClass extends SmrtClass {
  initializeSignalsCalls = 0;
  private _signalsInitStarted?: () => void;
  private _releaseSignalsInit?: () => void;

  readonly signalsInitStarted = new Promise<void>((resolve) => {
    this._signalsInitStarted = resolve;
  });

  readonly releaseSignalsInit = new Promise<void>((resolve) => {
    this._releaseSignalsInit = resolve;
  });

  async ensureRuntimeReady(): Promise<void> {
    await this.ensureRuntimeServicesInitialized();
  }

  protected async initializeSignals(): Promise<void> {
    this.initializeSignalsCalls += 1;
    this._signalsInitStarted?.();
    await this.releaseSignalsInit;
  }

  releaseBlockedSignalsInitialization(): void {
    this._releaseSignalsInit?.();
  }
}

describe('SmrtClass AI usage tracking', () => {
  beforeEach(() => {
    config.reset();
    getAIMock.mockReset();
    getAIMock.mockResolvedValue({
      embed: async () => ({ embeddings: [[]] }),
      chat: async () => ({ content: 'ok' }),
    });
  });

  afterEach(() => {
    config.reset();
    vi.restoreAllMocks();
  });

  it('should wire onUsage into getAI and collect normalized usage', async () => {
    const handler = {
      handle: vi.fn().mockResolvedValue(undefined),
    };
    const instance = new TestSmrtClass({
      ai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
      } as any,
      usage: {
        handlers: [handler],
      },
    });

    await instance.init();

    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(typeof aiConfig.onUsage).toBe('function');

    await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      usage: {
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
      },
      duration: 200,
      timestamp: new Date('2026-03-12T02:00:00.000Z'),
      tags: { feature: 'test' },
    });

    const snapshot = instance.getAiUsageSnapshot();
    expect(snapshot?.totalCalls).toBe(1);
    expect(snapshot?.byModel['openai:gpt-4o-mini']?.totalTokens).toBe(150);
    expect(snapshot?.byClass['TestSmrtClass:chat']?.callCount).toBe(1);

    expect(handler.handle).toHaveBeenCalledTimes(1);
    expect(handler.handle.mock.calls[0][0]).toMatchObject({
      className: 'TestSmrtClass',
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
    } satisfies Partial<SmrtAiUsageEvent>);
  });

  it('should persist usage records and return summaries', async () => {
    const instance = new TenantTestSmrtClass({
      db: ':memory:',
      ai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
      } as any,
    });

    await instance.init();

    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      usage: {
        promptTokens: 200,
        completionTokens: 100,
        totalTokens: 300,
      },
      duration: 320,
      timestamp: new Date('2026-03-12T03:00:00.000Z'),
    });

    const records = await instance.listAiUsage();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      tenantId: 'tenant-123',
    });
    expect(records[0].usage?.totalTokens).toBe(300);

    const summary = await instance.summarizeAiUsage({ groupBy: 'model' });
    expect(summary['openai:gpt-4o-mini']?.callCount).toBe(1);
    expect(summary['openai:gpt-4o-mini']?.totalTokens).toBe(300);
  });

  it('should allow usage tracking to be disabled', async () => {
    const handler = { handle: vi.fn().mockResolvedValue(undefined) };
    const instance = new TestSmrtClass({
      ai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
      } as any,
      usage: {
        enabled: false,
        handlers: [handler],
      },
    });

    await instance.init();

    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      },
      duration: 50,
      timestamp: new Date(),
    });

    expect(instance.getAiUsageSnapshot()).toBeUndefined();
    expect(handler.handle).not.toHaveBeenCalled();
  });

  it('should warn when an AI usage handler fails', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = {
      handle: vi.fn().mockRejectedValue(new Error('handler exploded')),
    };
    const instance = new TestSmrtClass({
      ai: {
        provider: 'openai',
        model: 'gpt-4o-mini',
      } as any,
      usage: {
        handlers: [handler],
      },
    });

    await instance.init();

    const aiConfig = getAIMock.mock.calls[0]?.[0] as Record<string, unknown>;
    await (aiConfig.onUsage as (event: unknown) => Promise<void>)({
      provider: 'openai',
      model: 'gpt-4o-mini',
      operation: 'chat',
      usage: {
        promptTokens: 10,
        completionTokens: 10,
        totalTokens: 20,
      },
      duration: 50,
      timestamp: new Date('2026-03-12T02:30:00.000Z'),
    });

    expect(warnSpy).toHaveBeenCalledWith(
      '[smrt] AI usage handler failed for openai:gpt-4o-mini: handler exploded',
    );
  });

  it('should single-flight deferred runtime initialization', async () => {
    const instance = new RuntimeSingleFlightTestSmrtClass();

    const firstEnsure = instance.ensureRuntimeReady();
    await instance.signalsInitStarted;

    const secondEnsure = instance.ensureRuntimeReady();
    await Promise.resolve();

    expect(instance.initializeSignalsCalls).toBe(1);

    instance.releaseBlockedSignalsInitialization();
    await Promise.all([firstEnsure, secondEnsure]);

    expect(instance.initializeSignalsCalls).toBe(1);
  });
});
