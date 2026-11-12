import { describe, expect, it, vi } from 'vitest';
import {
  recommendedWorkProfile,
  resolveWorkProfile,
  runWorkModelWithFallback,
  strongestWorkModel,
  WORK_MODEL_FALLBACK_MESSAGE,
} from './work-profiles.js';

describe('owner work profiles', () => {
  it('prioritizes intelligence for design and assist on every selected engine', () => {
    for (const engine of ['claude-code', 'codex', 'chatgpt', 'api'] as const) {
      const catalog = [
        { id: 'fast', intelligenceRank: 1 },
        { id: 'strong', intelligenceRank: 9 },
      ];
      for (const profile of ['design', 'assist'] as const) {
        const resolved = resolveWorkProfile({ engine, profile, catalog });
        expect(resolved.engine).toBe(engine);
        expect(resolved.tier).toBe('best');
        expect(resolved.effort).toBe(profile === 'design' ? 'max' : 'high');
        if (engine !== 'api') expect(resolved.model).toBe('strong');
      }
    }
    expect(resolveWorkProfile({ engine: 'claude-code' }).model).toBe('fable');
    expect(
      resolveWorkProfile({
        engine: 'claude-code',
        claudeModels: ['opus', 'sonnet'],
      }).model,
    ).toBe('opus');
    expect(
      resolveWorkProfile({ engine: 'claude-code', profile: 'background' })
        .effort,
    ).toBe('low');
  });
  it('requires ranked catalogs rather than assuming first is strongest', () => {
    expect(strongestWorkModel([{ id: 'unknown' }])).toBeUndefined();
    expect(() =>
      resolveWorkProfile({ engine: 'chatgpt', catalog: [{ id: 'unknown' }] }),
    ).toThrow('no available model');
    expect(() => resolveWorkProfile({ engine: 'codex' })).toThrow(
      'no available model',
    );
    expect(
      resolveWorkProfile({
        engine: 'chatgpt',
        settings: { model: 'owner-choice' },
      }).model,
    ).toBe('owner-choice');
  });
  it('applies owner budgets without mutating recommendations', () => {
    const result = resolveWorkProfile({
      engine: 'api',
      settings: {
        effort: 'medium',
        budgets: { passes: 7 },
        previewBeforeApply: false,
        autoEscalate: false,
      },
    });
    expect(result).toMatchObject({
      effort: 'medium',
      budgets: { passes: 7 },
      previewBeforeApply: false,
      autoEscalate: false,
    });
    expect(recommendedWorkProfile('assist').budgets.passes).toBe(1);
    expect(() =>
      resolveWorkProfile({
        engine: 'api',
        settings: { budgets: { maxSteps: 0 } },
      }),
    ).toThrow();
  });
  it('remembers one refused-model fallback under owner, engine, requested model and connection', async () => {
    const store = {
      read: vi.fn(async () => undefined),
      write: vi.fn(async () => {}),
    };
    const notify = vi.fn();
    const execute = vi.fn(async (model: string) => {
      if (model === 'fable') throw { code: 'denied' };
      return 'ok';
    });
    const result = await runWorkModelWithFallback({
      ownerId: 'owner',
      connectionKey: 'account/catalog-v1',
      profile: resolveWorkProfile({ engine: 'claude-code' }),
      nextModel: 'opus',
      store,
      execute,
      isPlanModelRefusal: () => true,
      notify,
    });
    expect(result).toMatchObject({
      model: 'opus',
      fallback: { from: 'fable', to: 'opus' },
    });
    expect(store.write).toHaveBeenCalledWith(
      'owner',
      'claude-code',
      'fable',
      'account/catalog-v1',
      'opus',
    );
    expect(notify).toHaveBeenCalledWith(WORK_MODEL_FALLBACK_MESSAGE);
    expect(execute).toHaveBeenCalledTimes(2);
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
      runWorkModelWithFallback({
        ownerId: 'a',
        connectionKey: 'v1',
        profile: resolveWorkProfile({ engine: 'claude-code' }),
        nextModel: 'opus',
        store: { read: async () => undefined, write: async () => {} },
        execute,
        isPlanModelRefusal: () => kind !== 'unclassified',
        notify: vi.fn(),
      }),
    ).rejects.toThrow('failed');
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

it.each([
  '--dangerously-skip-permissions',
  '-m',
  ' model',
  'model name',
  'model\nname',
  'model\0name',
  'model\x7fname',
])('rejects unsafe model option value %j', (model) => {
  expect(() =>
    resolveWorkProfile({ engine: 'claude-code', settings: { model } }),
  ).toThrow('Invalid work profile model');
});
