import { randomUUID } from 'node:crypto';
import {
  getTestDatabase,
  type InferenceConfig,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearFusions, defineFusion } from '../fusion.js';
import {
  APP_INFERENCE_SCOPE_ID,
  InferenceBindingInUseError,
  InferenceBindingValueError,
  InferenceOverrideAuthorizationError,
  type InferenceOverrideWriteRequest,
  InferenceSettingsConfigError,
  InferenceSettingsService,
  InferenceTenantTargetNotAllowedError,
  type InferenceTenantTargetPolicy,
  InvalidInferenceScopeError,
} from '../server.js';

/** A structurally valid pair (seat prompts are checked at run time). */
const VALID_PAIR = {
  mode: 'pair',
  seats: [
    { name: 'a', prompt: 'p.a', target: 'good' },
    { name: 'b', prompt: 'p.b', target: 'good' },
    { name: 'c', prompt: 'p.c', target: 'great' },
  ],
};

const APP = APP_INFERENCE_SCOPE_ID;

describe('InferenceSettingsService', () => {
  let db: DatabaseInterface;
  let config: InferenceConfig;
  let tenantId: string;
  let requests: InferenceOverrideWriteRequest[];

  const service = (
    options: {
      authorize?: boolean | (() => boolean);
      policy?: InferenceTenantTargetPolicy;
      registry?: Array<{ key: string; description?: string }>;
    } = {},
  ) =>
    InferenceSettingsService.create(
      { db },
      {
        config: () => config,
        tenantTargetPolicy: options.policy,
        registryFusions: options.registry
          ? () => options.registry ?? []
          : undefined,
        authorize:
          options.authorize === undefined || options.authorize === false
            ? undefined
            : (request) => {
                requests.push(request);
                return typeof options.authorize === 'function'
                  ? options.authorize()
                  : true;
              },
      },
    );

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['InferenceOverride'] });
    tenantId = randomUUID();
    requests = [];
    config = {
      tiers: { great: { provider: 'anthropic', model: 'claude-config' } },
      aliases: {
        local: { candidates: [{ preset: 'lemonade', model: 'qwen' }] },
        frontier: {
          candidates: [{ provider: 'anthropic', model: 'claude-frontier' }],
        },
      },
    };
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('lists one row per tier with config, app and tenant layers', async () => {
    const admin = await service({ authorize: true });
    await admin.setTierOverride({
      tier: 'great',
      scopeType: 'app',
      scopeId: APP,
      target: { alias: 'frontier' },
    });
    await admin.setTenantAllowList({
      binding: 'tier:great',
      allowList: ['alias:local'],
    });
    await admin.setTierOverride({
      tier: 'great',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { alias: 'local' },
    });

    const rows = await admin.listInferenceSettings({ tenantId });
    expect(rows.map((row) => row.tier)).toEqual([
      'cheap',
      'good',
      'great',
      'best',
    ]);
    const cheap = rows[0];
    expect(cheap).toMatchObject({
      supplyingLevel: 'default',
      effectiveTarget: null,
      effectiveLabel: 'Same as default (configured client)',
    });
    const great = rows[2];
    expect(great).toMatchObject({
      supplyingLevel: 'tenant',
      effectiveTarget: { alias: 'local' },
      configTarget: { provider: 'anthropic', model: 'claude-config' },
      appTarget: { alias: 'frontier' },
      tenantTarget: { alias: 'local' },
      tenantAllowList: ['alias:local'],
      tenantBlocked: false,
    });
  });

  it('computes both revert previews per scope (never the bare default)', async () => {
    const admin = await service({ authorize: true });
    await admin.setTierOverride({
      tier: 'great',
      scopeType: 'app',
      scopeId: APP,
      target: { alias: 'frontier' },
    });

    const [great] = (await admin.listInferenceSettings({ tenantId })).filter(
      (row) => row.tier === 'great',
    );
    // Reverting the app scope returns to config, never to the app row itself.
    expect(great?.appRevertTarget).toEqual({
      provider: 'anthropic',
      model: 'claude-config',
    });
    expect(great?.appRevertLabel).toBe('anthropic/claude-config');
    // Reverting the tenant scope returns to config + app row.
    expect(great?.inheritedTarget).toEqual({ alias: 'frontier' });
    expect(great?.inheritedLabel).toBe('Alias frontier');
    // App-only view: effective includes the app row, no tenant preview.
    const [appOnly] = (await admin.listInferenceSettings()).filter(
      (row) => row.tier === 'great',
    );
    expect(appOnly?.effectiveTarget).toEqual({ alias: 'frontier' });
    expect(appOnly?.supplyingLevel).toBe('app');
    expect(appOnly?.inheritedLabel).toBeNull();
  });

  it('is read-only without an authorizer and fails closed on a throwing one', async () => {
    const readOnly = await service();
    await expect(
      readOnly.setTierOverride({
        tier: 'good',
        scopeType: 'app',
        scopeId: APP,
        target: { model: 'gpt-x' },
      }),
    ).rejects.toBeInstanceOf(InferenceOverrideAuthorizationError);

    const throwing = await service({
      authorize: () => {
        throw new Error('boom');
      },
    });
    await expect(
      throwing.setDefaultTierOverride({
        scopeType: 'app',
        scopeId: APP,
        tier: 'best',
      }),
    ).rejects.toBeInstanceOf(InferenceOverrideAuthorizationError);
    expect(
      (await readOnly.listInferenceSettings()).every(
        (row) => row.appTarget === null,
      ),
    ).toBe(true);
  });

  it('asks the authorizer with the exact scope and normalized value', async () => {
    const admin = await service({ authorize: true });
    await admin.setTierOverride({
      tier: 'cheap',
      scopeType: 'app',
      scopeId: APP,
      target: { provider: 'openai', model: ' gpt-mini ' },
    });
    expect(requests).toEqual([
      {
        operation: 'set',
        binding: 'tier:cheap',
        scopeType: 'app',
        scopeId: APP,
        value: { provider: 'openai', model: 'gpt-mini' },
      },
    ]);
  });

  it('refuses a tenant binding the allow-list does not open', async () => {
    const admin = await service({ authorize: true });
    // No list: tenants may bind nothing.
    await expect(
      admin.setTierOverride({
        tier: 'cheap',
        scopeType: 'tenant',
        scopeId: tenantId,
        target: { alias: 'frontier' },
      }),
    ).rejects.toBeInstanceOf(InferenceTenantTargetNotAllowedError);

    await admin.setTenantAllowList({
      binding: 'tier:cheap',
      allowList: ['alias:local', 'model:openai/*'],
    });
    await expect(
      admin.setTierOverride({
        tier: 'cheap',
        scopeType: 'tenant',
        scopeId: tenantId,
        target: { alias: 'frontier' },
      }),
    ).rejects.toThrow(/not on the tenant allow-list/);
    await admin.setTierOverride({
      tier: 'cheap',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { provider: 'openai', model: 'gpt-mini' },
    });
    // Reverting is always allowed.
    await admin.setTierOverride({
      tier: 'cheap',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: null,
    });
    // The default tier has its own list.
    await expect(
      admin.setDefaultTierOverride({
        scopeType: 'tenant',
        scopeId: tenantId,
        tier: 'best',
      }),
    ).rejects.toBeInstanceOf(InferenceTenantTargetNotAllowedError);
  });

  it('applies the policy hook on write and on read (#4667 hook)', async () => {
    let maxHosted = 'best';
    const policy: InferenceTenantTargetPolicy = ({ ref }) =>
      maxHosted === 'best' || ref !== 'alias:frontier';
    const admin = await service({ authorize: true, policy });
    await admin.setTenantAllowList({ binding: 'tier:good', allowList: ['*'] });
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { alias: 'frontier' },
    });
    maxHosted = 'good';
    await expect(
      admin.setTierOverride({
        tier: 'good',
        scopeType: 'tenant',
        scopeId: tenantId,
        target: { alias: 'frontier' },
      }),
    ).rejects.toBeInstanceOf(InferenceTenantTargetNotAllowedError);
    const [good] = (await admin.listInferenceSettings({ tenantId })).filter(
      (row) => row.tier === 'good',
    );
    expect(good).toMatchObject({
      tenantTarget: { alias: 'frontier' },
      tenantBlocked: true,
      effectiveTarget: null,
      supplyingLevel: 'default',
    });
  });

  it('stops a tenant row from taking effect when the list narrows', async () => {
    const admin = await service({ authorize: true });
    await admin.setTenantAllowList({
      binding: 'tier:best',
      allowList: ['alias:*'],
    });
    await admin.setTierOverride({
      tier: 'best',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { alias: 'frontier' },
    });
    await admin.setTenantAllowList({
      binding: 'tier:best',
      allowList: ['alias:local'],
    });
    const effective = await admin.getEffectiveConfig({ tenantId });
    expect(effective?.tiers?.best).toBeUndefined();
    const [best] = (await admin.listInferenceSettings({ tenantId })).filter(
      (row) => row.tier === 'best',
    );
    expect(best?.tenantBlocked).toBe(true);
  });

  it('never stores a key, an endpoint or an inline chain on a tier', async () => {
    const admin = await service({ authorize: true });
    for (const target of [
      { provider: 'openai', model: 'gpt', apiKey: 'sk-secret-value' },
      { provider: 'openai', model: 'gpt', baseUrl: 'https://x.test/v1' },
      { candidates: [{ provider: 'openai', model: 'gpt' }] },
      { model: 'gpt', alias: 'local' },
    ]) {
      await expect(
        admin.setTierOverride({
          tier: 'good',
          scopeType: 'app',
          scopeId: APP,
          target: target as never,
        }),
      ).rejects.toBeInstanceOf(InferenceBindingValueError);
    }
    await expect(
      admin.setAlias({
        name: 'byo',
        alias: {
          candidates: [
            {
              provider: 'openai',
              model: 'gpt',
              baseUrl: 'https://x.test/v1',
              apiKey: 'sk-secret-value',
            },
          ],
        },
      }),
    ).rejects.toBeInstanceOf(InferenceBindingValueError);
    expect(requests).toEqual([]);
  });

  it('defines aliases and fusions at the app scope only', async () => {
    const admin = await service({ authorize: true });
    await admin.setAlias({
      name: 'byo',
      alias: {
        candidates: [
          {
            provider: 'openai',
            model: 'gpt',
            baseUrl: 'https://gw.test/v1',
            apiKeyEnv: 'GW_KEY',
          },
          { alias: 'local' },
        ],
      },
    });
    const aliases = await admin.listInferenceAliases();
    expect(aliases.map((alias) => [alias.name, alias.source])).toEqual([
      ['byo', 'app'],
      ['frontier', 'config'],
      ['local', 'config'],
    ]);

    // A nested reference to an alias nobody defines adds a config issue.
    await expect(
      admin.setAlias({
        name: 'broken',
        alias: { candidates: [{ alias: 'missing' }] },
      }),
    ).rejects.toBeInstanceOf(InferenceSettingsConfigError);
    // A tier bound to an unknown alias is refused the same way.
    await expect(
      admin.setTierOverride({
        tier: 'good',
        scopeType: 'app',
        scopeId: APP,
        target: { alias: 'missing' },
      }),
    ).rejects.toBeInstanceOf(InferenceSettingsConfigError);

    const overrides = (admin as unknown as { writes: { setValue: Function } })
      .writes;
    await expect(
      overrides.setValue('alias:byo', 'tenant', tenantId, {
        candidates: [{ provider: 'openai', model: 'x' }],
      }),
    ).rejects.toThrow(/app scope only/);
  });

  it('lists fusions from the registry, config and app rows', async () => {
    (config as { fusions?: unknown }).fusions = {
      'review-pair': { mode: 'pair', seats: [] },
    };
    const admin = await service({
      authorize: true,
      registry: [{ key: 'draft-handoff', description: 'Draft then review' }],
    });
    // #4800: a structurally invalid definition is refused on write.
    await expect(
      admin.setFusion({
        name: 'ab-test',
        definition: { mode: 'pair', seats: [] },
      }),
    ).rejects.toBeInstanceOf(InferenceSettingsConfigError);
    await admin.setFusion({ name: 'ab-test', definition: VALID_PAIR });
    await expect(
      admin.setFusion({
        name: 'leaky',
        definition: { mode: 'single', seats: [{ apiKey: 'sk-secret-value' }] },
      }),
    ).rejects.toBeInstanceOf(InferenceBindingValueError);
    const fusions = await admin.listInferenceFusions();
    expect(
      fusions.map((fusion) => [fusion.name, fusion.source, fusion.editable]),
    ).toEqual([
      ['ab-test', 'app', true],
      ['draft-handoff', 'registry', false],
      ['review-pair', 'config', false],
    ]);
    expect((await admin.getEffectiveConfig())?.fusions?.['ab-test']).toEqual(
      VALID_PAIR,
    );
    // The list carries what the executor would refuse (#4800): the config
    // entry is malformed and no seat prompt of the app row is registered.
    const byName = new Map(fusions.map((fusion) => [fusion.name, fusion]));
    expect(byName.get('review-pair')?.issues?.map((i) => i.code)).toContain(
      'fusion-invalid',
    );
    expect(byName.get('ab-test')?.issues?.map((i) => i.code)).toEqual([
      'fusion-prompt-unknown',
      'fusion-prompt-unknown',
      'fusion-prompt-unknown',
    ]);
  });

  it('lists defineFusion() registrations by default (#4753 registry)', async () => {
    const registry = globalThis as {
      __smrtPromptRegistry?: Map<string, unknown>;
    };
    const previous = registry.__smrtPromptRegistry;
    registry.__smrtPromptRegistry = new Map([['p.draft', { key: 'p.draft' }]]);
    try {
      defineFusion({
        key: 'solo',
        mode: 'single',
        description: 'One seat',
        seats: [{ prompt: 'p.draft', target: 'good' }],
      });
      const admin = await service({ authorize: true });
      const fusions = await admin.listInferenceFusions();
      expect(fusions).toEqual([
        expect.objectContaining({
          name: 'solo',
          source: 'registry',
          description: 'One seat',
          editable: false,
          definition: expect.objectContaining({ key: 'solo', mode: 'single' }),
        }),
      ]);
    } finally {
      clearFusions();
      registry.__smrtPromptRegistry = previous;
    }
  });

  it('reports auto default tier per scope', async () => {
    config.defaultTier = 'cheap';
    const admin = await service({ authorize: true });
    await admin.setDefaultTierOverride({
      scopeType: 'app',
      scopeId: APP,
      tier: 'great',
    });
    await admin.setTenantAllowList({
      binding: 'default-tier',
      allowList: ['tier:good'],
    });
    await admin.setDefaultTierOverride({
      scopeType: 'tenant',
      scopeId: tenantId,
      tier: 'good',
    });
    expect(await admin.getDefaultTierSetting({ tenantId })).toMatchObject({
      effectiveTier: 'good',
      supplyingLevel: 'tenant',
      configTier: 'cheap',
      appTier: 'great',
      tenantTier: 'good',
      appRevertTier: 'cheap',
      inheritedTier: 'great',
      tenantAllowList: ['tier:good'],
    });
  });

  it('rejects scopes the layered read never consults, before authorizing', async () => {
    const admin = await service({ authorize: true });
    for (const [scopeType, scopeId] of [
      ['app', tenantId],
      ['tenant', APP],
      ['tenant', ' padded '],
      ['tenant', ''],
      ['global', APP],
    ] as const) {
      await expect(
        admin.setTierOverride({
          tier: 'good',
          scopeType: scopeType as 'app',
          scopeId,
          target: { model: 'x' },
        }),
      ).rejects.toBeInstanceOf(InvalidInferenceScopeError);
    }
    expect(requests).toEqual([]);
  });

  it('lists provider options from presets and the SDK', async () => {
    const admin = await service();
    const options = admin.listProviderOptions();
    expect(options.find((option) => option.id === 'openrouter')).toMatchObject({
      kind: 'preset',
      requiresApiKey: true,
    });
    expect(options.find((option) => option.id === 'lemonade')).toMatchObject({
      kind: 'preset',
      local: true,
    });
    expect(options.find((option) => option.id === 'openai')).toMatchObject({
      kind: 'provider',
      requiresApiKey: true,
    });
    expect(
      options.find((option) => option.id === 'litellm')?.needsBaseUrl,
    ).toBe(true);
  });

  it('runs the doctor over the effective config', async () => {
    const admin = await service({ authorize: true });
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'app',
      scopeId: APP,
      target: { alias: 'local' },
    });
    const report = await admin.doctor({ env: {} });
    expect(report.bindings.map((binding) => binding.binding)).toContain(
      'tier:good',
    );
  });

  it('never returns a configured literal key in any settings row', async () => {
    const SECRET = 'sk-config-literal-0123456789';
    config = {
      tiers: {
        good: {
          provider: 'openai',
          model: 'gpt-x',
          baseUrl: 'https://gw.test/v1',
          apiKey: SECRET,
        },
      },
      aliases: {
        gateway: {
          candidates: [
            {
              provider: 'openai',
              model: 'gpt-x',
              baseUrl: 'https://gw.test/v1',
              apiKey: SECRET,
            },
          ],
        },
      },
    };
    (config as { fusions?: unknown }).fusions = {
      pair: { mode: 'pair', seats: [{ target: { apiKey: SECRET } }] },
    };
    const admin = await service({
      authorize: true,
      registry: [{ key: 'reg', token: SECRET } as never],
    });
    const payload = JSON.stringify([
      await admin.listInferenceSettings({ tenantId }),
      await admin.listInferenceAliases(),
      await admin.listInferenceFusions(),
      await admin.getDefaultTierSetting({ tenantId }),
    ]);
    expect(payload).not.toContain(SECRET);
    const [good] = (await admin.listInferenceSettings()).filter(
      (row) => row.tier === 'good',
    );
    expect(good?.configTarget).toEqual({
      provider: 'openai',
      model: 'gpt-x',
      baseUrl: 'https://gw.test/v1',
    });
  });

  it('refuses to remove an alias or fusion a stored binding still names', async () => {
    const admin = await service({ authorize: true });
    await admin.setAlias({
      name: 'byo',
      alias: { candidates: [{ preset: 'lemonade', model: 'qwen' }] },
    });
    await admin.setAlias({
      name: 'outer',
      alias: { candidates: [{ alias: 'byo' }] },
    });
    await admin.setTenantAllowList({ binding: 'tier:good', allowList: ['*'] });
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { alias: 'byo' },
    });
    const refused = await admin
      .setAlias({ name: 'byo', alias: null })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(InferenceBindingInUseError);
    expect((refused as InferenceBindingInUseError).referrers).toEqual([
      'alias:outer',
    ]);
    expect((refused as InferenceBindingInUseError).tenantReferences).toBe(1);
    expect(String(refused)).not.toContain(tenantId);

    // A caller the authorizer refuses learns nothing: 403 before any scan.
    for (const denied of [
      await service(),
      await service({
        authorize: () => {
          throw new Error('boom');
        },
      }),
    ]) {
      await expect(
        denied.setAlias({ name: 'byo', alias: null }),
      ).rejects.toBeInstanceOf(InferenceOverrideAuthorizationError);
      await expect(
        denied.setFusion({ name: 'ab', definition: null }),
      ).rejects.toBeInstanceOf(InferenceOverrideAuthorizationError);
    }

    // A config alias of the same name keeps the references valid.
    await admin.setAlias({
      name: 'frontier',
      alias: { candidates: [{ preset: 'lemonade', model: 'big' }] },
    });
    await admin.setTierOverride({
      tier: 'best',
      scopeType: 'app',
      scopeId: APP,
      target: { alias: 'frontier' },
    });
    await admin.setAlias({ name: 'frontier', alias: null });

    await admin.setFusion({ name: 'ab', definition: VALID_PAIR });
    await admin.setTierOverride({
      tier: 'great',
      scopeType: 'app',
      scopeId: APP,
      target: { kind: 'fusion', fusion: 'ab' } as never,
    });
    await expect(
      admin.setFusion({ name: 'ab', definition: null }),
    ).rejects.toBeInstanceOf(InferenceBindingInUseError);
  });
});
