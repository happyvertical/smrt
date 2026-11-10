/**
 * #4800: fusions defined only in the settings panel's app-scope override
 * rows reach the executor through core's `InferenceExecutionContext
 * .lookupFusion()`, answered by the override resolver. Precedence (each
 * replaces the lower whole): app row, `inference.fusions`, `defineFusion()`.
 * A stored definition is re-validated (prompt keys included) before it runs;
 * tenant rows never define a fusion.
 */
import { randomUUID } from 'node:crypto';
import {
  field,
  getTestDatabase,
  type InferenceConfig,
  type InferenceFusionDefinition,
  type InferenceResolver,
  listAiRuns,
  lookupInferenceFusion,
  SmrtObject,
  setInferenceExecutor,
  setInferenceResolver,
  smrt,
  config as smrtConfig,
} from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  definePrompt,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearFusions,
  createInferenceResolver,
  defineFusion,
  InferenceConfigError,
  registerInference,
} from '../index.js';
import {
  APP_INFERENCE_SCOPE_ID,
  createInferenceOverrideResolver,
  InferenceOverrideCollection,
  InferenceSettingsConfigError,
  InferenceSettingsService,
} from '../server.js';

@smrt()
class Issue4800Note extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';
}

const CONFIG: InferenceConfig = {
  tiers: {
    cheap: { model: 'cheap-m' },
    great: { model: 'great-m' },
  },
};

const PAIR: InferenceFusionDefinition = {
  mode: 'pair',
  description: 'Panel-defined pair',
  seats: [
    { name: 'skeptic', prompt: 'p4800.skeptic', target: 'cheap' },
    { name: 'advocate', prompt: 'p4800.advocate', target: 'great' },
    { name: 'synthesis', prompt: 'p4800.synthesis', target: 'great' },
  ],
};

const SINGLE: InferenceFusionDefinition = {
  mode: 'single',
  seats: [{ name: 'only', prompt: 'p4800.skeptic', target: 'cheap' }],
};

const HANDOFF: InferenceFusionDefinition = {
  mode: 'handoff',
  seats: [
    { name: 'draft', prompt: 'p4800.skeptic', target: 'cheap' },
    { name: 'answer', prompt: 'p4800.synthesis', target: 'great' },
  ],
};

describe('app-row fusions reach the executor (#4800)', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;
  let config: InferenceConfig;
  let admin: InferenceSettingsService;
  let overrides: InferenceOverrideCollection;
  let resolver: InferenceResolver;

  beforeEach(async () => {
    smrtConfig.reset();
    setInferenceResolver(undefined);
    clearFusions();
    PromptRegistry.clear();
    clearPromptCache();
    definePrompt({ key: 'p4800.skeptic', template: 'Find the weak points.' });
    definePrompt({ key: 'p4800.advocate', template: 'Find the strengths.' });
    definePrompt({ key: 'p4800.synthesis', template: 'Merge the reviews.' });
    db = await getTestDatabase({
      classes: ['Issue4800Note', 'InferenceOverride', 'PromptOverride'],
    });
    config = structuredClone(CONFIG);
    admin = await InferenceSettingsService.create(
      { db },
      { config: () => config, authorize: () => true },
    );
    overrides = await InferenceOverrideCollection.create({ db });
    // ttlMs 0: raw collection writes (a foreign writer) are seen at once.
    resolver = createInferenceOverrideResolver({ db: { db }, ttlMs: 0 });
    // The documented composition: the validating wrapper outermost.
    setInferenceResolver(createInferenceResolver(resolver));
    registerInference({ executor: { sleep: async () => {} } });
  });

  afterEach(async () => {
    clearFusions();
    clearPromptCache();
    PromptRegistry.clear();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  afterAll(() => {
    setInferenceResolver(undefined);
    setInferenceExecutor(undefined);
  });

  async function note() {
    const calls: Array<{ model: string; options: Record<string, unknown> }> =
      [];
    const ai = {
      embed: () => {},
      message: async (_text: string, options: Record<string, unknown>) => {
        const model = String(options.model ?? 'configured');
        calls.push({ model, options });
        return `from ${model}`;
      },
    };
    const instance = new Issue4800Note({
      ai,
      db,
      inference: config,
    } as never);
    await instance.initialize();
    return { instance, calls };
  }

  const bindBest = (fusion: string) =>
    admin.setTierOverride({
      tier: 'best',
      scopeType: 'app',
      scopeId: APP_INFERENCE_SCOPE_ID,
      target: { kind: 'fusion', fusion } as never,
    });

  it('runs a tier bound to a fusion defined only in an app row', async () => {
    await admin.setFusion({
      name: 'panel-pair',
      definition: PAIR as unknown as Record<string, unknown>,
    });
    await bindBest('panel-pair');

    const { instance, calls } = await note();
    await expect(
      instance.do('Review this contract', { tier: 'best' }),
    ).resolves.toBe('from great-m');
    expect(calls.map((call) => call.model).sort()).toEqual([
      'cheap-m',
      'great-m',
      'great-m',
    ]);
    for (const call of calls) {
      expect((call.options.usageTags as Record<string, string>).fusionKey).toBe(
        'panel-pair',
      );
    }
    const runs = await listAiRuns(db);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      fusionKey: 'panel-pair',
      mode: 'pair',
      seats: 3,
      status: 'ok',
    });

    // The panel's list shows exactly that definition, valid.
    const listed = await admin.listInferenceFusions();
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'panel-pair',
        source: 'app',
        editable: true,
      }),
    ]);
    expect(listed[0]).not.toHaveProperty('issues');
    expect(listed[0]).not.toHaveProperty('shadows');
  });

  it('an app row shadows a config fusion (and config the registry) of the same name', async () => {
    defineFusion({ key: 'review', ...SINGLE });
    config.fusions = { review: SINGLE };
    config.tiers = { ...config.tiers, best: { fusion: 'review' } };
    await admin.setFusion({
      name: 'review',
      definition: HANDOFF as unknown as Record<string, unknown>,
    });

    const app = await note();
    await app.instance.do('Review', { tier: 'best' });
    // handoff: 2 calls (the app row), not single's 1 (config).
    expect(app.calls.map((call) => call.model)).toEqual(['cheap-m', 'great-m']);
    expect((await listAiRuns(db))[0]).toMatchObject({ mode: 'handoff' });

    const listed = await admin.listInferenceFusions();
    expect(listed).toEqual([
      expect.objectContaining({
        name: 'review',
        source: 'app',
        shadows: ['registry', 'config'],
      }),
    ]);

    // Removing the app row restores the config definition, as listed.
    await admin.setFusion({ name: 'review', definition: null });
    const fromConfig = await note();
    await fromConfig.instance.do('Review', { tier: 'best' });
    expect(fromConfig.calls.map((call) => call.model)).toEqual(['cheap-m']);
    expect(await admin.listInferenceFusions()).toEqual([
      expect.objectContaining({
        name: 'review',
        source: 'config',
        shadows: ['registry'],
      }),
    ]);
  });

  it('removes a referenced app row while defineFusion() keeps the name', async () => {
    defineFusion({ key: 'kept', ...SINGLE });
    await admin.setFusion({ name: 'kept', definition: HANDOFF as never });
    await bindBest('kept');
    // The default registry (no `registryFusions` option) counts.
    await admin.setFusion({ name: 'kept', definition: null });
    expect((await admin.listInferenceFusions())[0]?.source).toBe('registry');
  });

  it('core lookup precedence: resolver answer, then config, then undefined', async () => {
    const stored: InferenceFusionDefinition = HANDOFF;
    const answering: InferenceResolver = {
      resolve: () => undefined,
      lookupFusion: (key) => (key === 'both' ? stored : undefined),
    };
    const fusions = { both: SINGLE, configOnly: SINGLE };
    await expect(
      lookupInferenceFusion(
        'both',
        { tier: 'best' },
        { resolver: answering, config: { fusions } },
      ),
    ).resolves.toEqual({ definition: HANDOFF, source: 'resolver' });
    await expect(
      lookupInferenceFusion(
        'configOnly',
        { tier: 'best' },
        { resolver: answering, config: { fusions } },
      ),
    ).resolves.toEqual({ definition: SINGLE, source: 'config' });
    await expect(
      lookupInferenceFusion(
        'nowhere',
        { tier: 'best' },
        { resolver: answering, config: { fusions } },
      ),
    ).resolves.toBeUndefined();
    await expect(
      lookupInferenceFusion(
        'bad',
        { tier: 'best' },
        {
          resolver: {
            resolve: () => undefined,
            lookupFusion: () => 7 as never,
          },
          config: {},
        },
      ),
    ).rejects.toThrow(/invalid definition for fusion "bad"/);
  });

  it('refuses an invalid stored definition with a load error, before any call', async () => {
    // Structure passes the write check; the seat prompt is not registered.
    await admin.setFusion({
      name: 'ghost-prompt',
      definition: {
        mode: 'single',
        seats: [{ prompt: 'p4800.missing', target: 'cheap' }],
      },
    });
    await bindBest('ghost-prompt');

    const { instance, calls } = await note();
    let error: unknown;
    try {
      await instance.do('Review', { tier: 'best' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InferenceConfigError);
    expect((error as InferenceConfigError).issues).toEqual([
      expect.objectContaining({
        path: 'fusion:ghost-prompt.seats[0].prompt',
        code: 'fusion-prompt-unknown',
      }),
    ]);
    expect(calls).toHaveLength(0);
    expect(await listAiRuns(db)).toHaveLength(0);

    // The panel shows the same issue the executor raised.
    const [listed] = await admin.listInferenceFusions();
    expect(listed?.issues).toEqual([
      expect.objectContaining({ code: 'fusion-prompt-unknown' }),
    ]);
  });

  it('refuses a structurally invalid row on write, and at run time from a foreign writer', async () => {
    const broken = { mode: 'pair', seats: [PAIR.seats[0]] };
    await expect(
      admin.setFusion({ name: 'broken', definition: broken }),
    ).rejects.toBeInstanceOf(InferenceSettingsConfigError);

    // A row written past the service (older or foreign writer).
    await overrides.setOverride(
      'fusion:broken',
      'app',
      APP_INFERENCE_SCOPE_ID,
      {
        target: broken,
      },
    );
    await bindBest('broken');
    const { instance, calls } = await note();
    let error: unknown;
    try {
      await instance.do('Review', { tier: 'best' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InferenceConfigError);
    expect((error as InferenceConfigError).issues).toEqual([
      expect.objectContaining({
        path: 'fusion:broken.seats',
        code: 'fusion-invalid',
      }),
    ]);
    expect(calls).toHaveLength(0);
  });

  it('refuses an unreadable app row instead of running a config fusion of that name', async () => {
    config.fusions = { review: SINGLE };
    config.tiers = { ...config.tiers, best: { fusion: 'review' } };
    // Not JSON: written past the model by a foreign writer.
    const now = new Date().toISOString();
    await db.query(
      'INSERT INTO _smrt_inference_overrides (id, slug, binding, tenant_id, context, target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        randomUUID(),
        'fusion-review',
        'fusion:review',
        null,
        APP_INFERENCE_SCOPE_ID,
        '{not json',
        now,
        now,
      ],
    );
    const { instance, calls } = await note();
    let error: unknown;
    try {
      await instance.do('Review', { tier: 'best' });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(InferenceConfigError);
    expect((error as InferenceConfigError).issues).toEqual([
      expect.objectContaining({
        path: 'fusion:review',
        code: 'fusion-invalid',
      }),
    ]);
    expect(calls).toHaveLength(0);
    expect(await listAiRuns(db)).toHaveLength(0);
    // The panel names the same winner and the same refusal.
    expect(await admin.listInferenceFusions()).toEqual([
      expect.objectContaining({
        name: 'review',
        source: 'app',
        definition: {},
        shadows: ['config'],
        issues: [expect.objectContaining({ code: 'fusion-invalid' })],
      }),
    ]);
  });

  it('never reads a fusion from a tenant row', async () => {
    const tenantId = randomUUID();
    config.fusions = { review: SINGLE };
    // Refused by the service and the model; possible only from a foreign
    // writer, so written with raw SQL.
    for (const binding of ['fusion:review', 'fusion:tenant-only']) {
      const now = new Date().toISOString();
      await db.query(
        'INSERT INTO _smrt_inference_overrides (id, slug, binding, tenant_id, context, target, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [
          randomUUID(),
          binding.replace(':', '-'),
          binding,
          tenantId,
          tenantId,
          JSON.stringify(HANDOFF),
          now,
          now,
        ],
      );
    }
    expect(
      (await overrides.getScopeMap('tenant', tenantId)).has('fusion:review'),
    ).toBe(true);
    const context = {
      config,
      resolveFromConfig: () => ({
        tierResolved: 'best' as const,
        target: {},
        via: 'default' as const,
      }),
    };
    const request = { tier: 'best' as const, tenantId };
    expect(await resolver.lookupFusion?.('review', request, context)).toBe(
      undefined,
    );
    expect(
      await resolver.lookupFusion?.('tenant-only', request, context),
    ).toBeUndefined();
    await expect(
      lookupInferenceFusion('review', request, { resolver, config }),
    ).resolves.toEqual({ definition: SINGLE, source: 'config' });
  });

  it('inlines app-only aliases in seat targets, keeps config aliases', async () => {
    config.aliases = { frontier: { candidates: [{ model: 'great-m' }] } };
    await admin.setAlias({
      name: 'panel-local',
      alias: { candidates: [{ model: 'cheap-m' }] },
    });
    await admin.setFusion({
      name: 'aliased',
      definition: {
        mode: 'handoff',
        seats: [
          {
            name: 'draft',
            prompt: 'p4800.skeptic',
            target: { alias: 'panel-local' },
          },
          {
            name: 'answer',
            prompt: 'p4800.synthesis',
            target: { alias: 'frontier' },
          },
        ],
      },
    });
    // An inline candidate list naming an app alias (PR review, #4855).
    await admin.setFusion({
      name: 'listed',
      definition: {
        mode: 'single',
        seats: [
          {
            name: 'only',
            prompt: 'p4800.skeptic',
            target: {
              candidates: [{ alias: 'panel-local' }, { alias: 'frontier' }],
            },
          },
        ],
      },
    });
    const listed = await lookupInferenceFusion(
      'listed',
      { tier: 'best' },
      { resolver, config },
    );
    expect(listed?.definition.seats[0]?.target).toEqual({
      candidates: [{ model: 'cheap-m' }, { alias: 'frontier' }],
    });
    const found = await lookupInferenceFusion(
      'aliased',
      { tier: 'best' },
      { resolver, config },
    );
    expect(found?.definition.seats.map((seat) => seat.target)).toEqual([
      { kind: 'candidates', candidates: [{ model: 'cheap-m' }] },
      { alias: 'frontier' },
    ]);

    await bindBest('aliased');
    const { instance, calls } = await note();
    await expect(instance.do('Review', { tier: 'best' })).resolves.toBe(
      'from great-m',
    );
    expect(calls.map((call) => call.model)).toEqual(['cheap-m', 'great-m']);

    // The listed fusion runs too: the executor's re-validation accepts it.
    await bindBest('listed');
    const second = await note();
    await expect(second.instance.do('Review', { tier: 'best' })).resolves.toBe(
      'from cheap-m',
    );
    expect(
      (await admin.listInferenceFusions()).find((f) => f.name === 'listed'),
    ).not.toHaveProperty('issues');
  });
});
