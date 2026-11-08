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
import { promptMessageOptions } from './utils.js';

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

  it('marks a tier profile for call-time binding without eager provider/model', async () => {
    config({
      inference: {
        tiers: { good: { provider: 'anthropic', model: 'haiku' } },
      },
    });
    definePrompt({
      key: 'tiers.plain',
      template: 'Hi',
      ai: { profile: 'good', params: { topP: 0.9 } },
    });
    const { ai } = await resolvePrompt('tiers.plain', { tenantId: null });
    expect(ai).toMatchObject({
      profile: 'good',
      tier: 'good',
      promptKey: 'tiers.plain',
      params: { topP: 0.9 },
    });
    // The binding is applied once by the object call, never copied here.
    expect(ai.provider).toBeUndefined();
    expect(ai.model).toBeUndefined();
  });

  it('accepts auto and keeps an explicit prompt model under allowedModels', async () => {
    usePromptConfig({ allowedModels: ['gpt-4o'] });
    definePrompt({
      key: 'tiers.auto',
      template: 'Hi',
      ai: { profile: 'auto', model: 'gpt-4o' },
    });
    const { ai } = await resolvePrompt('tiers.auto', { tenantId: null });
    expect(ai).toMatchObject({ tier: 'auto', model: 'gpt-4o' });
    await expect(
      resolvePrompt('tiers.auto', {
        tenantId: null,
        override: { model: 'not-allowed' },
      }),
    ).rejects.toThrow('not in the allowed model list');
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

  it('never calls the resolver while resolving a prompt', async () => {
    const seen: unknown[] = [];
    setInferenceResolver({
      resolve(request) {
        seen.push(request);
        return undefined;
      },
    });
    definePrompt({ key: 'tiers.ctx', template: 'Hi', ai: { profile: 'best' } });
    await resolvePrompt('tiers.ctx', { tenantId: 'tenant-a' });
    expect(seen).toEqual([]);
  });

  it('applies allowedProfileNames to chosen tiers, not to a code-default tier (#4755)', async () => {
    usePromptConfig({ allowedProfileNames: ['deep'] });
    definePrompt({
      key: 'tiers.denied',
      template: 'Hi',
      ai: { profile: 'cheap' },
      editable: EDITABLE,
    });
    // The framework's own declaration never breaks an app's allow-list.
    const { ai } = await resolvePrompt('tiers.denied', { tenantId: null });
    expect(ai.tier).toBe('cheap');
    // A tier selected by an override layer is still a choice the list governs,
    // including one that re-selects the code default's own tier.
    for (const profile of ['best', 'cheap']) {
      await expect(
        resolvePrompt('tiers.denied', {
          tenantId: null,
          override: { profile },
        }),
      ).rejects.toThrow('not in the allowed profile list');
    }
    clearPromptCache();
    clearCache();
    usePromptConfig({
      allowedProfileNames: ['deep'],
      prompts: { 'tiers.denied': { profile: 'cheap' } },
    });
    await expect(
      resolvePrompt('tiers.denied', { tenantId: null }),
    ).rejects.toThrow('not in the allowed profile list');
  });

  it('forwards tier, promptKey and a valid latency; params cannot carry them', async () => {
    definePrompt({
      key: 'tiers.options',
      template: 'Hi',
      ai: {
        profile: 'good',
        latency: 'interactive',
        params: { tier: 'best', promptKey: 'spoofed' },
      },
    });
    const { ai } = await resolvePrompt('tiers.options', { tenantId: null });
    expect(ai.params).not.toHaveProperty('tier');
    expect(ai.params).not.toHaveProperty('promptKey');
    expect(promptMessageOptions(ai)).toMatchObject({
      tier: 'good',
      promptKey: 'tiers.options',
      latency: 'interactive',
    });

    definePrompt({
      key: 'tiers.badLatency',
      template: 'Hi',
      ai: { latency: 'soon' as never },
    });
    const bad = await resolvePrompt('tiers.badLatency', { tenantId: null });
    const options = promptMessageOptions(bad.ai);
    expect(options).not.toHaveProperty('latency');
    expect(options).not.toHaveProperty('tier');
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

  it('carries the code default ai.minimumTier with the tier, never from params', async () => {
    definePrompt({
      key: 'tiers.floor',
      template: 'Hi',
      ai: { profile: 'great', minimumTier: 'good' },
    });
    const { ai } = await resolvePrompt('tiers.floor', {
      tenantId: null,
      // A runtime (or tenant) layer cannot lower the floor through params.
      override: { params: { minimumTier: 'cheap' } },
    });
    expect(ai.minimumTier).toBe('good');
    expect(ai.params).not.toHaveProperty('minimumTier');
    expect(promptMessageOptions(ai)).toMatchObject({
      tier: 'great',
      promptKey: 'tiers.floor',
      minimumTier: 'good',
    });
  });

  it('drops minimumTier when the effective profile is not a tier', async () => {
    definePrompt({
      key: 'tiers.floor-profile',
      template: 'Hi',
      ai: { profile: 'great', minimumTier: 'good' },
    });
    const { ai } = await resolvePrompt('tiers.floor-profile', {
      tenantId: null,
      override: { profile: 'deep' },
    });
    expect(ai.tier).toBeUndefined();
    expect(promptMessageOptions(ai)).not.toHaveProperty('minimumTier');
  });

  it('rejects an unknown minimumTier at definition', () => {
    expect(() =>
      definePrompt({
        key: 'tiers.bad-floor',
        template: 'Hi',
        ai: { profile: 'great', minimumTier: 'fast' as never },
      }),
    ).toThrow('ai.minimumTier must be one of');
  });
});
