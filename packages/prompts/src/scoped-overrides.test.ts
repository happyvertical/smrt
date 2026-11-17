/**
 * Scoped ambient prompt overrides (#5065): `withPromptOverrides()` makes an
 * unmodified call path (no `override` argument) resolve a draft template.
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { resetTenancy, setupTestTenancy } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPromptCache } from './cache.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import { resolvePrompt, withPromptOverrides } from './prompt-resolver.js';
import { promptTemplateHash } from './utils.js';

const STORE_KEY = Symbol.for('smrt.prompts.scopedOverrides');

function enable(extra: Record<string, unknown> = {}) {
  clearCache();
  setConfig({
    packages: { prompts: { allowScopedOverrides: true, ...extra } },
  });
}

/** An unmodified call site: it knows nothing about overrides. */
async function realCallSite(key: string) {
  await Promise.resolve();
  return resolvePrompt(key);
}

describe('withPromptOverrides', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    setupTestTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    enable();
    db = await getTestDatabase({ classes: ['PromptOverride'] });
    definePrompt({
      key: 'arena.a',
      template: 'base A',
      ai: { profile: 'good' },
    });
    definePrompt({ key: 'arena.b', template: 'base B' });
  });

  afterEach(async () => {
    clearPromptCache();
    PromptRegistry.clear();
    clearCache();
    resetTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  it('resolves the draft on an unmodified call path, tagged runtime', async () => {
    const hash = await promptTemplateHash('draft A');
    const resolved = await withPromptOverrides(
      { 'arena.a': { template: 'draft A' } },
      () => realCallSite('arena.a'),
    );
    expect(resolved.template).toBe('draft A');
    expect(resolved.ai.usageTags.promptLayer).toBe('runtime');
    expect(resolved.ai.usageTags.templateHash).toBe(hash);
  });

  it('only affects the listed keys', async () => {
    const other = await withPromptOverrides(
      { 'arena.a': { template: 'draft A' } },
      () => realCallSite('arena.b'),
    );
    expect(other.template).toBe('base B');
    expect(other.ai.usageTags.promptLayer).toBe('default');
  });

  it('does not leak between concurrent scopes', async () => {
    const run = (draft: string, delay: number) =>
      withPromptOverrides({ 'arena.a': { template: draft } }, async () => {
        await new Promise((r) => setTimeout(r, delay));
        const first = await resolvePrompt('arena.a');
        await new Promise((r) => setTimeout(r, delay));
        const second = await resolvePrompt('arena.a');
        return [first.template, second.template];
      });
    const [x, y] = await Promise.all([run('draft X', 5), run('draft Y', 1)]);
    expect(x).toEqual(['draft X', 'draft X']);
    expect(y).toEqual(['draft Y', 'draft Y']);
  });

  it('leaves the cache and later resolves on the base template', async () => {
    const baseHash = (await resolvePrompt('arena.a')).ai.usageTags.templateHash;
    await withPromptOverrides({ 'arena.a': { template: 'draft A' } }, () =>
      realCallSite('arena.a'),
    );
    const after = await resolvePrompt('arena.a');
    expect(after.template).toBe('base A');
    expect(after.ai.usageTags.templateHash).toBe(baseHash);
    expect(after.ai.usageTags.promptLayer).toBe('default');
  });

  it('lets an explicit override beat the ambient layer field by field', async () => {
    const resolved = await withPromptOverrides(
      {
        'arena.a': {
          template: 'ambient',
          model: 'm-ambient',
          params: { a: 1 },
        },
      },
      () =>
        resolvePrompt('arena.a', {
          override: { template: 'explicit', params: { b: 2 } },
        }),
    );
    expect(resolved.template).toBe('explicit');
    expect(resolved.ai.model).toBe('m-ambient');
    expect(resolved.ai.params).toMatchObject({ a: 1, b: 2 });
  });

  it('nests: inner wins per key, outer keys stay visible', async () => {
    await withPromptOverrides(
      {
        'arena.a': { template: 'outer A' },
        'arena.b': { template: 'outer B' },
      },
      async () => {
        await withPromptOverrides(
          { 'arena.a': { template: 'inner A' } },
          async () => {
            expect((await resolvePrompt('arena.a')).template).toBe('inner A');
            expect((await resolvePrompt('arena.b')).template).toBe('outer B');
          },
        );
        expect((await resolvePrompt('arena.a')).template).toBe('outer A');
      },
    );
  });

  it('throws when the host has not opted in', () => {
    clearCache();
    setConfig({ packages: { prompts: {} } });
    expect(() =>
      withPromptOverrides({ 'arena.a': { template: 'x' } }, () => 1),
    ).toThrow(/allowScopedOverrides/);
  });

  it('applies allowedProfileNames and allowedModels to the ambient layer', async () => {
    enable({ allowedProfileNames: ['good'], allowedModels: ['ok-model'] });
    await expect(
      withPromptOverrides({ 'arena.a': { profile: 'cheap' } }, () =>
        resolvePrompt('arena.a'),
      ),
    ).rejects.toThrow();
    await expect(
      withPromptOverrides(
        { 'arena.a': { profile: 'good', model: 'bad-model' } },
        () => resolvePrompt('arena.a'),
      ),
    ).rejects.toThrow();
  });

  it('validates effort when the scope opens', () => {
    expect(() =>
      withPromptOverrides(
        { 'arena.a': { effort: 'ludicrous' as never } },
        () => 1,
      ),
    ).toThrow();
    expect(
      withPromptOverrides({ 'arena.a': { effort: 'high' } }, () => 1),
    ).toBe(1);
  });

  it('throws when async context does not propagate across await', () => {
    const slot = globalThis as Record<symbol, unknown>;
    const saved = slot[STORE_KEY];
    // What createAsyncContext() returns where there is no async-local state.
    slot[STORE_KEY] = {
      propagatesAcrossAwait: false,
      run: (_store: unknown, callback: () => unknown) => callback(),
      getStore: () => undefined,
    };
    try {
      const fn = vi.fn();
      expect(() =>
        withPromptOverrides({ 'arena.a': { template: 'x' } }, fn),
      ).toThrow(/survives await/);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      slot[STORE_KEY] = saved;
    }
  });
});
