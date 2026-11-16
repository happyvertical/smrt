import { describe, expect, it, vi } from 'vitest';
import {
  MODEL_FALLBACK_MESSAGE,
  runWithModelFallback,
} from './model-fallback.js';

describe('plan-refusal model fallback', () => {
  it('remembers one refused-model step under owner, engine, requested model and connection', async () => {
    const memo = new Map<string, string>();
    const store = {
      read: vi.fn(async (...key: string[]) => memo.get(key.join('|'))),
      write: vi.fn(async (...args: string[]) => {
        memo.set(args.slice(0, 4).join('|'), args[4]);
      }),
    };
    const execute = vi.fn(async (model: string) => {
      if (model === 'fable') throw new Error('refused');
      return model;
    });
    const notify = vi.fn();
    const result = await runWithModelFallback({
      ownerId: 'owner',
      connectionKey: 'account/catalog-v1',
      engine: 'claude-code',
      model: 'fable',
      nextModel: 'opus',
      store,
      execute,
      isPlanModelRefusal: () => true,
      notify,
    });
    expect(result).toMatchObject({
      model: 'opus',
      fallback: { from: 'fable', to: 'opus', reason: 'plan-model-refused' },
    });
    expect(store.write).toHaveBeenCalledWith(
      'owner',
      'claude-code',
      'fable',
      'account/catalog-v1',
      'opus',
    );
    expect(notify).toHaveBeenCalledWith(MODEL_FALLBACK_MESSAGE);
    // The memo answers the next turn directly: no second refusal.
    execute.mockClear();
    const again = await runWithModelFallback({
      ownerId: 'owner',
      connectionKey: 'account/catalog-v1',
      engine: 'claude-code',
      model: 'fable',
      nextModel: 'opus',
      store,
      execute,
      isPlanModelRefusal: () => true,
      notify,
    });
    expect(again.model).toBe('opus');
    expect(execute).toHaveBeenCalledOnce();
  });

  it.each([
    'output',
    'tool',
    'unclassified',
  ])('never retries after %s', async (kind) => {
    const execute = vi.fn(
      async (
        _model: string,
        activity: { markOutput(): void; markToolExecution(): void },
      ) => {
        if (kind === 'output') activity.markOutput();
        if (kind === 'tool') activity.markToolExecution();
        throw new Error('failed');
      },
    );
    await expect(
      runWithModelFallback({
        ownerId: 'a',
        connectionKey: 'v1',
        engine: 'claude-code',
        model: 'fable',
        nextModel: 'opus',
        store: { read: async () => undefined, write: async () => {} },
        execute,
        isPlanModelRefusal: () => kind !== 'unclassified',
        notify: vi.fn(),
      }),
    ).rejects.toThrow('failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses an unsafe model or remembered model', async () => {
    const base = {
      ownerId: 'a',
      connectionKey: 'v1',
      engine: 'codex' as const,
      execute: async () => 'x',
      isPlanModelRefusal: () => true,
      notify: () => {},
    };
    await expect(
      runWithModelFallback({
        ...base,
        model: '--dangerously-skip-permissions',
        store: { read: async () => undefined, write: async () => {} },
      }),
    ).rejects.toThrow('Invalid model id.');
    await expect(
      runWithModelFallback({
        ...base,
        model: 'gpt-6-astra',
        store: { read: async () => '-m', write: async () => {} },
      }),
    ).rejects.toThrow('Invalid model id.');
  });
});
