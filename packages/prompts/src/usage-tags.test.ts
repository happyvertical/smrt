/**
 * Prompt-run observability tags (#4751).
 *
 * `resolvePrompt()` attaches `promptKey`, `promptLayer` and `templateHash` to
 * `ai.usageTags`; `promptMessageOptions()` forwards them to `ai.message()`,
 * where the AI SDK merges them into the usage event that lands in
 * `_smrt_ai_usage`.
 */
import { createHash } from 'node:crypto';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clearPromptCache } from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import { resolvePrompt } from './prompt-resolver.js';
import type { ResolvedPromptAI } from './types.js';
import { promptMessageOptions, promptTemplateHash } from './utils.js';

function shortHash(template: string): string {
  return createHash('sha256').update(template).digest('hex').slice(0, 12);
}

const EDITABLE = { template: true, profile: true, model: true, params: true };

describe('prompt usage tags (#4751)', () => {
  let db: DatabaseInterface;
  let overrides: PromptOverrideCollection;

  beforeEach(async () => {
    setupTestTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
    setConfig({
      packages: {
        prompts: {
          profiles: { deep: { provider: 'openai', model: 'gpt-4o' } },
        },
      },
    });
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

  it('hashes the effective template as 12 hex chars of SHA-256', async () => {
    expect(await promptTemplateHash('Hello {name}')).toBe(
      shortHash('Hello {name}'),
    );
    expect(await promptTemplateHash('')).toBe(shortHash(''));
  });

  it('tags a code-default resolution with the default layer', async () => {
    definePrompt({ key: 'tags.default', template: 'Code {name}' });

    const resolved = await resolvePrompt('tags.default', {
      variables: { name: 'Ada' },
    });

    expect(resolved.ai.usageTags).toEqual({
      promptKey: 'tags.default',
      promptLayer: 'default',
      templateHash: shortHash('Code {name}'),
    });
  });

  it('reports the highest layer that supplied the template, not the highest layer present', async () => {
    definePrompt({
      key: 'tags.layers',
      template: 'Code',
      ai: { profile: 'deep' },
      editable: EDITABLE,
    });
    setConfig({
      packages: {
        prompts: {
          profiles: { deep: { provider: 'openai', model: 'gpt-4o' } },
          prompts: { 'tags.layers': { template: 'Config' } },
        },
      },
    });

    expect(
      (await resolvePrompt('tags.layers', { db })).ai.usageTags.promptLayer,
    ).toBe('config');

    await overrides.create({
      key: 'tags.layers',
      tenantId: null,
      template: 'App',
    });
    // A tenant row that only changes params does not supply the template.
    await overrides.create({
      key: 'tags.layers',
      tenantId: 'tenant-a',
      params: { temperature: 0.3 },
    });
    clearPromptCache();

    const app = await resolvePrompt('tags.layers', {
      db,
      tenantId: 'tenant-a',
    });
    expect(app.ai.usageTags.promptLayer).toBe('app');
    expect(app.ai.usageTags.templateHash).toBe(shortHash('App'));

    await overrides.create({
      key: 'tags.layers',
      tenantId: 'tenant-b',
      template: 'Tenant',
    });
    clearPromptCache();
    const tenant = await resolvePrompt('tags.layers', {
      db,
      tenantId: 'tenant-b',
    });
    expect(tenant.ai.usageTags.promptLayer).toBe('tenant');
    expect(tenant.ai.usageTags.templateHash).toBe(shortHash('Tenant'));

    const runtime = await resolvePrompt('tags.layers', {
      db,
      tenantId: 'tenant-b',
      override: { template: 'Runtime' },
    });
    expect(runtime.ai.usageTags.promptLayer).toBe('runtime');
    expect(runtime.ai.usageTags.templateHash).toBe(shortHash('Runtime'));

    // A runtime override without a template keeps the stored layer.
    const paramsOnly = await resolvePrompt('tags.layers', {
      db,
      tenantId: 'tenant-b',
      override: { maxTokens: 10 },
    });
    expect(paramsOnly.ai.usageTags.promptLayer).toBe('tenant');
  });

  it('serves the cached layer on a cache hit', async () => {
    definePrompt({ key: 'tags.cache', template: 'Code', editable: EDITABLE });
    await overrides.create({
      key: 'tags.cache',
      tenantId: null,
      template: 'App',
    });

    const first = await resolvePrompt('tags.cache', { db });
    const second = await resolvePrompt('tags.cache', { db });
    expect(first.ai.usageTags).toEqual(second.ai.usageTags);
    expect(second.ai.usageTags.promptLayer).toBe('app');
  });

  it('promptMessageOptions emits the three tags with the call options', async () => {
    definePrompt({
      key: 'tags.forward',
      template: 'Forward',
      ai: { profile: 'deep', temperature: 0.2, params: { maxTokens: 50 } },
    });

    const resolved = await resolvePrompt('tags.forward');
    const options = promptMessageOptions(resolved.ai);

    expect(options).toMatchObject({
      model: 'gpt-4o',
      temperature: 0.2,
      maxTokens: 50,
      usageTags: {
        promptKey: 'tags.forward',
        promptLayer: 'default',
        templateHash: shortHash('Forward'),
      },
    });
  });

  it("merges the caller's usageTags over the resolution's, and the resolution's over params", () => {
    const ai: ResolvedPromptAI = {
      params: {
        usageTags: { promptKey: 'spoofed', source: 'params' },
      },
      usageTags: {
        promptKey: 'tags.merge',
        promptLayer: 'tenant',
        templateHash: 'abcdefabcdef',
      },
    };

    expect(
      promptMessageOptions(ai, {
        usageTags: { runId: 'run-1', promptLayer: 'caller' },
      }).usageTags,
    ).toEqual({
      promptKey: 'tags.merge',
      promptLayer: 'caller',
      templateHash: 'abcdefabcdef',
      source: 'params',
      runId: 'run-1',
    });
  });

  it('drops reserved tags from params-carried usageTags', () => {
    const options = promptMessageOptions({
      params: {
        usageTags: {
          runId: 'victim-run',
          tierRequested: 'best',
          tierResolved: 'best',
          substitutions: '[]',
          fusionKey: 'forged',
          promptLayer: 'forged',
          source: 'params',
        },
      },
    });
    expect(options.usageTags).toEqual({ source: 'params' });

    // Reserved-only params tags leave no usageTags at all, never the raw map.
    expect(
      promptMessageOptions({
        params: { usageTags: { runId: 'victim-run' } },
      }),
    ).toEqual({});
  });

  it('forwards tier and promptKey for a tier profile unless routeTier is false', async () => {
    definePrompt({
      key: 'tags.tier',
      template: 'Tiered',
      ai: { profile: 'great' },
    });

    const resolved = await resolvePrompt('tags.tier');
    expect(promptMessageOptions(resolved.ai)).toMatchObject({
      tier: 'great',
      promptKey: 'tags.tier',
      usageTags: { promptKey: 'tags.tier', promptLayer: 'default' },
    });

    const direct = promptMessageOptions(resolved.ai, { routeTier: false });
    expect(direct).not.toHaveProperty('tier');
    expect(direct).not.toHaveProperty('promptKey');
    expect(direct.usageTags?.promptKey).toBe('tags.tier');
  });

  it('never takes tier routing keys from params', async () => {
    definePrompt({
      key: 'tags.params-tier',
      template: 'P',
      ai: { params: { tier: 'best', latency: 'interactive', promptKey: 'x' } },
      editable: EDITABLE,
    });
    await overrides.create({
      key: 'tags.params-tier',
      tenantId: null,
      params: { tier: 'great', promptKey: 'injected', topP: 0.5 },
    });

    const resolved = await resolvePrompt('tags.params-tier', { db });
    expect(resolved.ai.params).toEqual({ topP: 0.5 });
    expect(resolved.ai.tier).toBeUndefined();

    for (const routeTier of [true, false]) {
      const options = promptMessageOptions(
        { params: { tier: 'great', latency: 'interactive', promptKey: 'p' } },
        { routeTier },
      );
      expect(options).not.toHaveProperty('tier');
      expect(options).not.toHaveProperty('latency');
      expect(options).not.toHaveProperty('promptKey');
    }
  });

  it('omits usageTags for a hand-built AI object with none', () => {
    expect(promptMessageOptions({ params: {} })).toEqual({});
  });
});
