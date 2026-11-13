import { describe, expect, it, vi } from 'vitest';
import {
  nextWorkModel,
  projectWorkModelSelection,
  rankOpenAIWorkModels,
  recommendedWorkProfile,
  resolveWorkProfile,
  runWorkModelWithFallback,
  strongestWorkModel,
  WORK_MODEL_FALLBACK_MESSAGE,
} from './work-profiles.js';

describe('owner work profiles', () => {
  it('reports model strength only from recommended native or ranked selection evidence', () => {
    expect(
      resolveWorkProfile({ engine: 'claude-code', profile: 'design' }),
    ).toMatchObject({
      model: 'fable',
      effort: 'max',
      modelSelection: {
        kind: 'strongest',
        requestedModel: 'fable',
        resolvedModel: 'fable',
      },
    });
    expect(
      resolveWorkProfile({
        engine: 'claude-code',
        claudeModels: ['opus', 'sonnet'],
      }).modelSelection?.kind,
    ).toBe('configured');
    expect(
      resolveWorkProfile({ engine: 'claude-code', profile: 'background' })
        .modelSelection?.kind,
    ).toBe('configured');
    expect(
      resolveWorkProfile({
        engine: 'claude-code',
        settings: { model: 'fable' },
      }).modelSelection?.kind,
    ).toBe('custom');
    expect(
      resolveWorkProfile({
        engine: 'chatgpt',
        catalog: [{ id: 'ranked', intelligenceRank: 1 }],
      }).modelSelection,
    ).toEqual({
      kind: 'strongest',
      requestedModel: 'ranked',
      resolvedModel: 'ranked',
    });
    expect(resolveWorkProfile({ engine: 'api' }).modelSelection).toEqual({
      kind: 'configured',
    });
    expect(
      resolveWorkProfile({ engine: 'api', catalog: [{ id: 'unverified' }] })
        .modelSelection?.kind,
    ).toBe('configured');
    expect(
      resolveWorkProfile({
        engine: 'codex',
        settings: { model: 'unranked-custom' },
      }).modelSelection?.kind,
    ).toBe('custom');
  });

  it('projects an existing refusal memo without changing execution identity or starting a fallback chain', async () => {
    const profile = resolveWorkProfile({
      engine: 'claude-code',
      profile: 'design',
    });
    const original = structuredClone(profile);
    const store = {
      read: vi.fn(async () => 'opus'),
      write: vi.fn(async () => {}),
    };
    const input = {
      ownerId: 'owner',
      connectionKey: 'cli:account:selection',
      profile,
      store,
    };
    const presented = await projectWorkModelSelection(input);
    expect(presented).toMatchObject({
      model: 'fable',
      modelSelection: {
        kind: 'fallback',
        requestedModel: 'fable',
        resolvedModel: 'opus',
      },
    });
    expect(profile).toEqual(original);
    expect(store.read).toHaveBeenCalledExactlyOnceWith(
      'owner',
      'claude-code',
      'fable',
      'cli:account:selection',
    );
    expect(store.write).not.toHaveBeenCalled();
    const execute = vi.fn(async () => 'answer');
    await runWorkModelWithFallback({
      ...input,
      profile: presented,
      nextModel: 'sonnet',
      execute,
      isPlanModelRefusal: () => true,
      notify: vi.fn(),
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledWith('opus', expect.any(Object));
    expect(store.write).not.toHaveBeenCalled();
    expect(store.read.mock.calls[1]).toEqual(store.read.mock.calls[0]);
  });

  it('leaves unknown/provider defaults and absent or unchanged refusal memos unchanged', async () => {
    const read = vi.fn(async (): Promise<string | undefined> => undefined);
    const input = {
      ownerId: 'owner',
      connectionKey: 'version:account:revision',
      store: { read },
    };
    const provider = resolveWorkProfile({ engine: 'api' });
    expect(
      await projectWorkModelSelection({ ...input, profile: provider }),
    ).toBe(provider);
    expect(read).not.toHaveBeenCalled();
    const custom = resolveWorkProfile({
      engine: 'claude-code',
      settings: { model: 'owner-choice' },
    });
    expect(await projectWorkModelSelection({ ...input, profile: custom })).toBe(
      custom,
    );
    read.mockResolvedValue('owner-choice');
    expect(await projectWorkModelSelection({ ...input, profile: custom })).toBe(
      custom,
    );
    read.mockResolvedValue('--unsafe');
    await expect(
      projectWorkModelSelection({ ...input, profile: custom }),
    ).rejects.toThrow('Invalid work profile model');
  });

  it('looks up only the supplied owner, engine, request and connection scope', async () => {
    const memo = new Map([
      ['owner:claude-code:fable:version:account:revision', 'opus'],
    ]);
    const store = {
      read: vi.fn(
        async (
          owner: string,
          engine: string,
          request: string,
          connection: string,
        ) => memo.get(`${owner}:${engine}:${request}:${connection}`),
      ),
    };
    const profile = resolveWorkProfile({ engine: 'claude-code' });
    const input = {
      ownerId: 'owner',
      profile,
      connectionKey: 'version:account:revision',
      store,
    };
    expect((await projectWorkModelSelection(input)).modelSelection?.kind).toBe(
      'fallback',
    );
    for (const changed of [
      { ownerId: 'other' },
      { connectionKey: 'newversion:account:revision' },
      { connectionKey: 'version:newaccount:revision' },
      { connectionKey: 'version:account:newrevision' },
      { profile: { ...profile, engine: 'codex' as const } },
      { profile: { ...profile, model: 'opus' } },
      { store: { read: async () => undefined } },
    ]) {
      expect(
        (await projectWorkModelSelection({ ...input, ...changed }))
          .modelSelection?.kind,
      ).toBe('strongest');
    }
  });

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
    expect(resolveWorkProfile({ engine: 'codex' }).model).toBe('gpt-6-astra');
    expect(() =>
      resolveWorkProfile({ engine: 'codex', catalog: [{ id: 'unknown' }] }),
    ).toThrow('no available model');
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

it('uses reviewed OpenAI ranks only on offered models, independent of catalog order or spelling', () => {
  const catalog = rankOpenAIWorkModels<
    import('./work-profiles.js').WorkModelCatalogEntry
  >([
    { id: 'gpt-6-luna' },
    { id: 'gpt-99-new-unknown' },
    { id: 'gpt-6.1-sol' },
    { id: 'gpt-6-astra' },
  ]);
  for (const profile of ['design', 'assist'] as const)
    expect(
      resolveWorkProfile({ engine: 'chatgpt', profile, catalog }).model,
    ).toBe('gpt-6-astra');
  expect(nextWorkModel(catalog, 'gpt-6-astra')).toBe('gpt-6.1-sol');
  expect(nextWorkModel(catalog, 'gpt-6-luna')).toBeUndefined();
  expect(catalog[1].intelligenceRank).toBeUndefined();
  expect(
    strongestWorkModel(
      rankOpenAIWorkModels([{ id: 'gpt-6.1-sol' }, { id: 'gpt-6-luna' }]),
    ),
  ).toBe('gpt-6.1-sol');
  expect(
    rankOpenAIWorkModels([{ id: 'future', intelligenceRank: 10 }])[0]
      .intelligenceRank,
  ).toBe(10);
});
