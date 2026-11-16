/**
 * A prompt's reasoning effort (#5005): a named, validated `ai.effort`, sent as
 * `reasoning: { effort }`. Params never carry it, so a tenant override cannot
 * widen it beyond the validated set. Precedence: the caller's own `reasoning`
 * over the prompt's effort over the tier binding's `params.reasoning` (core's
 * merge, covered in core's class-inference-tiers test) over the provider.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPromptCache } from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import { resolvePrompt } from './prompt-resolver.js';
import { promptMessageOptions } from './utils.js';

const EDITABLE = { template: true, profile: true, model: true, params: true };

describe('prompt reasoning effort', () => {
  let db: DatabaseInterface;
  let overrides: PromptOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
    setConfig({ packages: { prompts: {} } });
    db = await getTestDatabase({ classes: ['PromptOverride'] });
    overrides = await PromptOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearPromptCache();
    PromptRegistry.clear();
    clearCache();
    resetTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('sends the declared effort as reasoning.effort', async () => {
    definePrompt({
      key: 'effort.declared',
      template: 'T',
      ai: { profile: 'best', effort: 'xhigh' },
    });
    const resolved = await resolvePrompt('effort.declared');
    expect(resolved.ai.effort).toBe('xhigh');
    expect(promptMessageOptions(resolved.ai)).toMatchObject({
      tier: 'best',
      reasoning: { effort: 'xhigh' },
    });
    // A call site that holds its client still sends the effort.
    expect(
      promptMessageOptions(resolved.ai, { routeTier: false }),
    ).toMatchObject({ reasoning: { effort: 'xhigh' } });
  });

  it('sends no reasoning when the prompt declares no effort', async () => {
    definePrompt({
      key: 'effort.none',
      template: 'T',
      ai: { profile: 'good' },
    });
    const resolved = await resolvePrompt('effort.none');
    expect(promptMessageOptions(resolved.ai)).not.toHaveProperty('reasoning');
  });

  it('refuses an effort outside the validated set', () => {
    expect(() =>
      definePrompt({
        key: 'effort.invalid',
        template: 'T',
        ai: { effort: 'extreme' as never },
      }),
    ).toThrow(/ai\.effort must be one of low, medium, high, xhigh, max/);
  });

  it('lets config and a runtime override set a validated effort', async () => {
    definePrompt({
      key: 'effort.layers',
      template: 'T',
      ai: { profile: 'best', effort: 'low' },
    });
    setConfig({
      packages: {
        prompts: { prompts: { 'effort.layers': { effort: 'high' } } },
      },
    });
    expect((await resolvePrompt('effort.layers')).ai.effort).toBe('high');
    const runtime = await resolvePrompt('effort.layers', {
      override: { ai: { effort: 'max' } },
    });
    expect(runtime.ai.effort).toBe('max');
    await expect(
      resolvePrompt('effort.layers', {
        override: { effort: 'unbounded' as never },
      }),
    ).rejects.toThrow(/ai\.effort must be one of/);
  });

  it('never takes effort or reasoning from params, so a tenant override cannot widen it', async () => {
    definePrompt({
      key: 'effort.params',
      template: 'T',
      ai: {
        effort: 'medium',
        params: { effort: 'max', reasoning: { effort: 'max' }, topP: 0.5 },
      },
      editable: EDITABLE,
    });
    await overrides.create({
      key: 'effort.params',
      tenantId: null,
      params: { effort: 'unbounded', reasoning: { effort: 'unbounded' } },
    });
    const resolved = await resolvePrompt('effort.params', { db });
    expect(resolved.ai.params).toEqual({ topP: 0.5 });
    expect(resolved.ai.effort).toBe('medium');
    expect(promptMessageOptions(resolved.ai).reasoning).toEqual({
      effort: 'medium',
    });
  });

  it("lets the caller's own reasoning win over the prompt's effort", async () => {
    definePrompt({
      key: 'effort.caller',
      template: 'T',
      ai: { effort: 'low' },
    });
    const resolved = await resolvePrompt('effort.caller');
    const options = {
      ...promptMessageOptions(resolved.ai),
      reasoning: { effort: 'high' as const },
    };
    expect(options.reasoning).toEqual({ effort: 'high' });
  });
});
