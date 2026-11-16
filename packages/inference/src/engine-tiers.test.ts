import { config } from '@happyvertical/smrt-core';
import { afterEach, describe, expect, it } from 'vitest';
import {
  engineModels,
  engineReasoningEffort,
  engineTierModel,
  nextEngineModel,
  nextModel,
  rankOpenAIModels,
  resolveEngineEffort,
  strongestModel,
  validateModelId,
  weakestModel,
} from './engine-tiers.js';

describe('the default tier binding of an engine that is not an API key', () => {
  afterEach(() => config.reset());

  it('binds Claude Code tiers to fable, opus and sonnet', () => {
    const model = (tier: 'best' | 'great' | 'good' | 'cheap') =>
      engineTierModel({ engine: 'claude-code', tier });
    expect(model('best')).toBe('fable');
    expect(model('great')).toBe('fable');
    expect(model('good')).toBe('opus');
    expect(model('cheap')).toBe('sonnet');
  });

  it('binds Codex tiers to the recommended OpenAI ranks', () => {
    const model = (tier: 'best' | 'great' | 'good' | 'cheap') =>
      engineTierModel({ engine: 'codex', tier });
    expect(model('best')).toBe('gpt-6-astra');
    expect(model('great')).toBe('gpt-6-astra');
    expect(model('good')).toBe('gpt-6.1-sol');
    expect(model('cheap')).toBe('gpt-6-luna');
  });

  it('binds a ChatGPT plan only to models its catalog offers', () => {
    const catalog = [
      { id: 'gpt-6.1-terra' },
      { id: 'gpt-6.1-sol' },
      { id: 'unranked-preview' },
    ];
    expect(engineTierModel({ engine: 'chatgpt', tier: 'best', catalog })).toBe(
      'gpt-6.1-sol',
    );
    expect(engineTierModel({ engine: 'chatgpt', tier: 'good', catalog })).toBe(
      'gpt-6.1-terra',
    );
    expect(engineTierModel({ engine: 'chatgpt', tier: 'cheap', catalog })).toBe(
      'gpt-6.1-terra',
    );
    expect(
      engineTierModel({ engine: 'chatgpt', tier: 'best' }),
    ).toBeUndefined();
  });

  it('leaves an API key to core and reads auto as the default tier', () => {
    expect(engineTierModel({ engine: 'api', tier: 'best' })).toBeUndefined();
    expect(engineTierModel({ engine: 'claude-code', tier: 'auto' })).toBe(
      'opus',
    );
    expect(
      engineTierModel({
        engine: 'claude-code',
        tier: 'auto',
        defaultTier: 'cheap',
      }),
    ).toBe('sonnet');
    config({ inference: { defaultTier: 'best' } });
    expect(engineTierModel({ engine: 'codex', tier: 'auto' })).toBe(
      'gpt-6-astra',
    );
  });

  it('honours an available-models list and falls back to the strongest for good', () => {
    expect(
      engineTierModel({
        engine: 'claude-code',
        tier: 'best',
        catalog: [{ id: 'opus' }, { id: 'sonnet' }],
      }),
    ).toBe('opus');
    expect(
      engineTierModel({
        engine: 'claude-code',
        tier: 'good',
        catalog: [{ id: 'sonnet' }],
      }),
    ).toBe('sonnet');
  });

  it('steps one rank down the binding order on a plan refusal', () => {
    expect(nextEngineModel({ engine: 'claude-code', model: 'fable' })).toBe(
      'opus',
    );
    expect(nextEngineModel({ engine: 'claude-code', model: 'opus' })).toBe(
      'sonnet',
    );
    expect(
      nextEngineModel({ engine: 'claude-code', model: 'sonnet' }),
    ).toBeUndefined();
    expect(nextEngineModel({ engine: 'codex', model: 'gpt-6-astra' })).toBe(
      'gpt-6.1-sol',
    );
    expect(
      nextEngineModel({ engine: 'codex', model: 'custom' }),
    ).toBeUndefined();
  });

  it('ranks only by explicit rank, never catalog order', () => {
    const catalog = rankOpenAIModels([
      { id: 'zzz' },
      { id: 'gpt-6-luna' },
      { id: 'gpt-6-astra' },
    ]);
    expect(strongestModel(catalog)).toBe('gpt-6-astra');
    expect(weakestModel(catalog)).toBe('gpt-6-luna');
    expect(nextModel(catalog, 'gpt-6-astra')).toBe('gpt-6-luna');
    expect(engineModels('api')).toEqual([]);
  });

  it('refuses a model id that is not a single safe value', () => {
    expect(validateModelId('fable')).toBe('fable');
    for (const bad of ['', '-x', 'a b', 'a\nb', 'x'.repeat(201)])
      expect(() => validateModelId(bad)).toThrow('Invalid model id.');
  });
});

describe('reasoning effort on an engine', () => {
  afterEach(() => config.reset());

  it('maps effort to each engine and records only on a ChatGPT plan', () => {
    expect(engineReasoningEffort('claude-code', 'max')).toBe('max');
    expect(engineReasoningEffort('codex', 'max')).toBe('xhigh');
    expect(engineReasoningEffort('codex', 'low')).toBe('low');
    expect(engineReasoningEffort('api', 'xhigh')).toBe('xhigh');
    expect(engineReasoningEffort('chatgpt', 'high')).toBeUndefined();
    expect(engineReasoningEffort('claude-code', undefined)).toBeUndefined();
  });

  it('takes the caller, then the prompt, then the tier binding, then nothing', () => {
    config({
      inference: {
        tiers: { best: { params: { reasoning: { effort: 'medium' } } } },
      },
    });
    expect(
      resolveEngineEffort({ caller: 'low', prompt: 'high', tier: 'best' }),
    ).toBe('low');
    expect(resolveEngineEffort({ prompt: 'high', tier: 'best' })).toBe('high');
    expect(resolveEngineEffort({ tier: 'best' })).toBe('medium');
    expect(resolveEngineEffort({ tier: 'good' })).toBeUndefined();
    expect(resolveEngineEffort({})).toBeUndefined();
  });

  it('ignores a binding effort outside the validated set', () => {
    config({
      inference: {
        tiers: { best: { params: { reasoning: { effort: 'unbounded' } } } },
      },
    });
    expect(resolveEngineEffort({ tier: 'best' })).toBeUndefined();
  });
});
