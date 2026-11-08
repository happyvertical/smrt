/**
 * Tier names as reserved prompt profile names (#4750): a profile that is a
 * tier (or `auto`) resolves through the core inference seam unless
 * `PromptPackageConfig.profiles` defines the same name.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  config,
  getTestDatabase,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPromptCache } from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import { resolvePrompt } from './prompt-resolver.js';

const EDITABLE = { template: true, profile: true, model: true, params: true };

function usePromptConfig(prompts: Record<string, unknown> = {}) {
  setConfig({
    packages: {
      prompts: {
        profiles: { deep: { provider: 'openai', model: 'gpt-4o' } },
        ...prompts,
      },
    },
  });
}

describe('prompt tier profiles', () => {
  beforeEach(() => {
    setupTestTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
    config.reset();
    setInferenceResolver(undefined);
    usePromptConfig();
  });

  afterEach(() => {
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
    config.reset();
    setInferenceResolver(undefined);
    resetTenancy();
  });

  it('resolves an unconfigured tier to the configured client', async () => {
    definePrompt({
      key: 'tiers.plain',
      template: 'Hi',
      ai: { profile: 'good' },
    });
    const { ai } = await resolvePrompt('tiers.plain', { tenantId: null });
    expect(ai).toMatchObject({
      profile: 'good',
      tier: 'good',
      tierResolved: 'good',
      inferenceVia: 'default',
    });
    expect(ai.provider).toBeUndefined();
    expect(ai.model).toBeUndefined();
  });

  it('binds auto through config; prompt params and models win over the target', async () => {
    config({
      inference: {
        defaultTier: 'cheap',
        tiers: {
          cheap: {
            provider: 'anthropic',
            model: 'haiku',
            params: { temperature: 0.1, topP: 0.5 },
          },
        },
      },
    });
    usePromptConfig({ allowedModels: ['gpt-4o'] });
    definePrompt({
      key: 'tiers.auto',
      template: 'Hi',
      ai: { profile: 'auto', params: { topP: 0.9 } },
    });
    const { ai } = await resolvePrompt('tiers.auto', { tenantId: null });
    expect(ai).toMatchObject({
      tier: 'auto',
      tierResolved: 'cheap',
      inferenceVia: 'config',
      provider: 'anthropic',
      // A binding is app config, so allowedModels does not reject it.
      model: 'haiku',
      temperature: 0.1,
      topP: 0.9,
      params: { temperature: 0.1, topP: 0.9 },
    });
  });

  it('lets an explicit same-named profile win over the tier', async () => {
    usePromptConfig({
      profiles: { good: { provider: 'openai', model: 'gpt-4o-mini' } },
    });
    definePrompt({
      key: 'tiers.shadow',
      template: 'Hi',
      ai: { profile: 'good' },
    });
    const { ai } = await resolvePrompt('tiers.shadow', { tenantId: null });
    expect(ai.provider).toBe('openai');
    expect(ai.model).toBe('gpt-4o-mini');
    expect(ai.tier).toBeUndefined();
  });

  it('passes the prompt key and tenant to the resolver', async () => {
    const seen: unknown[] = [];
    setInferenceResolver({
      resolve(request) {
        seen.push(request);
        return undefined;
      },
    });
    definePrompt({ key: 'tiers.ctx', template: 'Hi', ai: { profile: 'best' } });
    await resolvePrompt('tiers.ctx', { tenantId: 'tenant-a' });
    expect(seen).toEqual([
      { tier: 'best', tenantId: 'tenant-a', promptKey: 'tiers.ctx' },
    ]);
  });

  it('keeps allowedProfileNames authoritative for tier names', async () => {
    usePromptConfig({ allowedProfileNames: ['deep'] });
    definePrompt({
      key: 'tiers.denied',
      template: 'Hi',
      ai: { profile: 'cheap' },
    });
    await expect(
      resolvePrompt('tiers.denied', { tenantId: null }),
    ).rejects.toThrow('not in the allowed profile list');
  });

  it('accepts a stored tier profile override but still rejects unknown names', async () => {
    const db = await getTestDatabase({ classes: ['PromptOverride'] });
    try {
      const overrides = await PromptOverrideCollection.create({ db });
      definePrompt({
        key: 'tiers.stored',
        template: 'Hi',
        ai: { profile: 'deep' },
        editable: EDITABLE,
      });
      await overrides.create({ key: 'tiers.stored', profile: 'great' });
      const { ai } = await resolvePrompt('tiers.stored', {
        db,
        tenantId: null,
      });
      expect(ai.tier).toBe('great');
      expect(ai.provider).toBeUndefined();
      await expect(
        overrides.create({ key: 'tiers.stored', profile: 'fast' }),
      ).rejects.toThrow('is not configured');
    } finally {
      await (db as { close?: () => Promise<void> }).close?.();
    }
  });
});
