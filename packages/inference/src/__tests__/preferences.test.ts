/**
 * The `inference` preference kind's validator and the read/write layer over
 * a structural store. The round trip through smrt-preferences' real store is
 * `packages/preferences/src/__tests__/inference-kind.test.ts` (a dev
 * dependency on smrt-preferences here would be a workspace cycle through
 * smrt-cli).
 */
import { describe, expect, it } from 'vitest';
import {
  createInferencePreferences,
  INFERENCE_PREFERENCE_KIND,
  type InferencePreferenceStoreLike,
  inferencePreferenceKind,
  validateInferencePreferences,
} from '../server.js';

describe('validateInferencePreferences', () => {
  it('keeps valid choices and reports the rest', () => {
    expect(
      validateInferencePreferences({
        mode: 'byo',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen/qwen3',
        defaultTier: 'great',
      }),
    ).toEqual({
      ok: true,
      canonical: {
        mode: 'byo',
        provider: 'openrouter',
        baseUrl: 'https://openrouter.ai/api/v1',
        model: 'qwen/qwen3',
        defaultTier: 'great',
      },
      issues: [],
    });
    const mixed = validateInferencePreferences({
      mode: 'turbo',
      baseUrl: 'https://x.test/v1?key=1',
      defaultTier: 'fast',
      extra: 1,
      model: 'm',
    });
    expect(mixed.ok).toBe(false);
    expect(mixed.canonical).toEqual({ model: 'm' });
    expect(mixed.issues.map((issue) => issue.path).sort()).toEqual([
      'baseUrl',
      'defaultTier',
      'extra',
      'mode',
    ]);
  });

  it('refuses a payload that carries a key', () => {
    const result = validateInferencePreferences({
      provider: 'openai',
      apiKey: 'sk-secret-value',
    });
    expect(result).toMatchObject({ ok: false, canonical: null });
    expect(JSON.stringify(result)).not.toContain('sk-secret-value');
  });
});

describe('createInferencePreferences', () => {
  it('saves through the kind validator and reads tenant + user merged', async () => {
    const rows = new Map<string, unknown>();
    const store: InferencePreferenceStoreLike = {
      async load(kind) {
        expect(kind).toBe(INFERENCE_PREFERENCE_KIND);
        return {
          tenant: { payload: rows.get('tenant') ?? null, revision: null },
          user: { payload: rows.get('user') ?? null, revision: null },
          issues: [],
          canCustomize: { tenant: true, user: true },
        };
      },
      async save(_kind, _surface, input) {
        const result = inferencePreferenceKind.validate(input.payload);
        if (!result.ok) return { ok: false, reason: 'invalid' };
        rows.set(input.scope, result.canonical);
        return { ok: true };
      },
      async reset(_kind, _surface, input) {
        rows.delete(input.scope);
        return { ok: true };
      },
    };
    const prefs = createInferencePreferences(store);
    await prefs.write(
      { mode: 'hosted', defaultTier: 'good' },
      { scope: 'tenant', revision: null },
    );
    await prefs.write(
      { mode: 'byo', provider: 'openrouter' },
      { revision: null },
    );
    expect((await prefs.read()).choices).toEqual({
      mode: 'byo',
      provider: 'openrouter',
      defaultTier: 'good',
    });
    expect(
      await prefs.write({ apiKey: 'sk-secret-value' } as never, {
        revision: null,
      }),
    ).toMatchObject({ ok: false });
    await prefs.reset();
    expect((await prefs.read()).choices).toEqual({
      mode: 'hosted',
      defaultTier: 'good',
    });
  });
});
