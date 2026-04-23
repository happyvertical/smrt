import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearPromptCache, getPromptCacheTtlMs } from './cache.js';
import { PromptOverrideCollection } from './collections/PromptOverrideCollection.js';
import { definePrompt, PromptRegistry } from './prompt-registry.js';
import { resolvePrompt } from './prompt-resolver.js';

describe('@happyvertical/smrt-prompts', () => {
  let db: DatabaseInterface;
  let overrides: PromptOverrideCollection;
  let tempDbPaths: string[];

  beforeEach(async () => {
    setupTestTenancy();
    PromptRegistry.clear();
    clearPromptCache();
    clearCache();
    tempDbPaths = [];

    setConfig({
      packages: {
        prompts: {
          profiles: {
            deep: { provider: 'openai', model: 'gpt-4o' },
            fast: { provider: 'anthropic', model: 'claude-3-5-haiku' },
          },
          allowedModels: ['gpt-4o', 'claude-3-5-haiku', 'claude-3-7-sonnet'],
        },
      },
    });

    db = await getTestDatabase({
      classes: ['PromptOverride'],
    });
    overrides = await PromptOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearPromptCache();
    PromptRegistry.clear();
    clearCache();
    resetTenancy();
    vi.useRealTimers();

    if (typeof (db as any)?.close === 'function') {
      await (db as any).close();
    }

    await Promise.all(
      tempDbPaths.map((path) => rm(path, { force: true }).catch(() => {})),
    );
  });

  it('resolves prompts with code, config, app, tenant, and runtime precedence', async () => {
    definePrompt({
      key: 'test.precedence',
      template: 'Code {name}',
      ai: {
        profile: 'deep',
        temperature: 0.2,
      },
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });

    setConfig({
      packages: {
        prompts: {
          profiles: {
            deep: { provider: 'openai', model: 'gpt-4o' },
            fast: { provider: 'anthropic', model: 'claude-3-5-haiku' },
          },
          allowedModels: ['gpt-4o', 'claude-3-5-haiku', 'claude-3-7-sonnet'],
          prompts: {
            'test.precedence': {
              template: 'Config {name}',
              ai: {
                profile: 'fast',
                temperature: 0.4,
              },
            },
          },
        },
      },
    });

    await overrides.create({
      key: 'test.precedence',
      tenantId: null,
      model: 'claude-3-7-sonnet',
      params: { maxTokens: 500 },
    });

    await overrides.create({
      key: 'test.precedence',
      tenantId: 'tenant-a',
      template: 'Tenant {name}',
      params: { temperature: 0.7 },
    });

    const resolved = await resolvePrompt('test.precedence', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
      override: {
        template: 'Runtime {name}',
        maxTokens: 900,
      },
    });

    expect(resolved.text).toBe('Runtime Will');
    expect(resolved.ai.profile).toBe('fast');
    expect(resolved.ai.provider).toBe('anthropic');
    expect(resolved.ai.model).toBe('claude-3-7-sonnet');
    expect(resolved.ai.temperature).toBe(0.7);
    expect(resolved.ai.maxTokens).toBe(900);
  });

  it('supports model-only tenant overrides and invalidates cached app-layer entries for every tenant', async () => {
    definePrompt({
      key: 'test.fanout',
      template: 'Code {name}',
      ai: {
        profile: 'deep',
      },
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });

    const firstTenant = await resolvePrompt('test.fanout', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'A' },
    });
    const secondTenant = await resolvePrompt('test.fanout', {
      db,
      tenantId: 'tenant-b',
      variables: { name: 'B' },
    });

    expect(firstTenant.text).toBe('Code A');
    expect(secondTenant.text).toBe('Code B');

    await overrides.create({
      key: 'test.fanout',
      tenantId: null,
      template: 'App {name}',
      profile: 'fast',
    });

    const afterAppWriteTenantA = await resolvePrompt('test.fanout', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'A' },
    });
    const afterAppWriteTenantB = await resolvePrompt('test.fanout', {
      db,
      tenantId: 'tenant-b',
      variables: { name: 'B' },
    });

    expect(afterAppWriteTenantA.text).toBe('App A');
    expect(afterAppWriteTenantB.text).toBe('App B');
    expect(afterAppWriteTenantA.ai.provider).toBe('anthropic');

    await overrides.create({
      key: 'test.fanout',
      tenantId: 'tenant-a',
      model: 'claude-3-7-sonnet',
    });

    const tenantSpecific = await resolvePrompt('test.fanout', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'A' },
    });
    expect(tenantSpecific.ai.model).toBe('claude-3-7-sonnet');

    const tenantOverride = await overrides.getTenantOverride(
      'test.fanout',
      'tenant-a',
    );
    await tenantOverride?.delete();

    const afterDelete = await resolvePrompt('test.fanout', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'A' },
    });
    expect(afterDelete.ai.model).toBe('claude-3-5-haiku');
  });

  it('invalidates the previous cache identity when an override changes key or tenant scope', async () => {
    definePrompt({
      key: 'test.migrate.source',
      template: 'Source {name}',
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });
    definePrompt({
      key: 'test.migrate.target',
      template: 'Target {name}',
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });

    const override = await overrides.create({
      key: 'test.migrate.source',
      tenantId: null,
      template: 'App Source {name}',
    });

    const cached = await resolvePrompt('test.migrate.source', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
    });
    expect(cached.text).toBe('App Source Will');

    override.key = 'test.migrate.target';
    override.tenantId = 'tenant-a';
    override.template = 'Tenant Target {name}';
    await override.save();

    const sourceAfterMove = await resolvePrompt('test.migrate.source', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
    });
    const targetAfterMove = await resolvePrompt('test.migrate.target', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
    });

    expect(sourceAfterMove.text).toBe('Source Will');
    expect(targetAfterMove.text).toBe('Tenant Target Will');
  });

  it('invalidates cache entries when callers resolve through a database config object', async () => {
    definePrompt({
      key: 'test.config.cache',
      template: 'Code {name}',
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });

    const dbPath = join(
      tmpdir(),
      `smrt-prompts-cache-${Date.now()}-${crypto.randomUUID()}.db`,
    );
    tempDbPaths.push(dbPath);
    const dbConfig = { type: 'sqlite' as const, url: dbPath };
    const schemaDb = await getTestDatabase({
      ...dbConfig,
      classes: ['PromptOverride'],
    });
    if (typeof (schemaDb as any).close === 'function') {
      await (schemaDb as any).close();
    }

    const configOverrides = await PromptOverrideCollection.create({
      db: dbConfig,
    });

    try {
      const initial = await resolvePrompt('test.config.cache', {
        db: dbConfig,
        tenantId: 'tenant-a',
        variables: { name: 'Will' },
      });
      expect(initial.text).toBe('Code Will');

      await configOverrides.create({
        key: 'test.config.cache',
        tenantId: null,
        template: 'App {name}',
      });

      const afterWrite = await resolvePrompt('test.config.cache', {
        db: dbConfig,
        tenantId: 'tenant-a',
        variables: { name: 'Will' },
      });
      expect(afterWrite.text).toBe('App Will');
    } finally {
      if (typeof (configOverrides.db as any).close === 'function') {
        await (configOverrides.db as any).close();
      }
    }
  });

  it('expires stale cache entries after the ttl when storage changes without invalidation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

    definePrompt({
      key: 'test.ttl',
      template: 'Code {name}',
    });

    const initial = await resolvePrompt('test.ttl', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
    });
    expect(initial.text).toBe('Code Will');

    await (db as any).upsert('_smrt_prompt_overrides', ['key', 'context'], {
      id: crypto.randomUUID(),
      slug: 'test-ttl-app',
      context: '__app__',
      created_at: new Date(),
      updated_at: new Date(),
      key: 'test.ttl',
      tenant_id: null,
      template: 'DB {name}',
      profile: null,
      model: null,
      params: null,
    });

    const cached = await resolvePrompt('test.ttl', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
    });
    expect(cached.text).toBe('Code Will');

    vi.advanceTimersByTime(getPromptCacheTtlMs() + 1);

    const refreshed = await resolvePrompt('test.ttl', {
      db,
      tenantId: 'tenant-a',
      variables: { name: 'Will' },
    });
    expect(refreshed.text).toBe('DB Will');
  });

  it('renders missing interpolation variables as empty strings without breaking the template', async () => {
    definePrompt({
      key: 'test.interpolate',
      template: 'Hello {name}! Missing:{missing}',
    });

    const resolved = await resolvePrompt('test.interpolate', {
      variables: { name: 'Will' },
    });

    expect(resolved.text).toBe('Hello Will! Missing:');
  });

  it('rejects invalid stored overrides at write-time', async () => {
    definePrompt({
      key: 'test.locked',
      template: 'Locked',
      editable: {
        template: false,
        profile: false,
        model: true,
        params: false,
      },
    });

    await expect(
      overrides.create({
        key: 'missing.prompt',
        template: 'Oops',
      }),
    ).rejects.toThrow('Unknown prompt key');

    await expect(
      overrides.create({
        key: 'test.locked',
        template: 'Override',
      }),
    ).rejects.toThrow('does not allow template overrides');

    await expect(
      overrides.create({
        key: 'test.locked',
        profile: 'unknown',
      }),
    ).rejects.toThrow('does not allow profile overrides');

    await expect(
      overrides.create({
        key: 'test.locked',
        model: 'claude-3-7-sonnet',
      }),
    ).rejects.toThrow('require an effective prompt profile');

    definePrompt({
      key: 'test.mutable',
      template: 'Mutable',
      ai: {
        profile: 'deep',
      },
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });

    await expect(
      overrides.create({
        key: 'test.mutable',
        profile: 'unknown',
      }),
    ).rejects.toThrow('is not configured');

    await expect(
      overrides.create({
        key: 'test.mutable',
        model: 'not-allowed',
      }),
    ).rejects.toThrow('is not in the allowed model list');
  });

  it('keeps app-level overrides visible through normal CRUD inside a tenant context', async () => {
    definePrompt({
      key: 'test.crud.scope',
      template: 'Scoped',
      editable: {
        template: true,
        profile: true,
        model: true,
        params: true,
      },
    });

    const appOverride = await overrides.create({
      key: 'test.crud.scope',
      tenantId: null,
      template: 'App override',
    });
    await overrides.create({
      key: 'test.crud.scope',
      tenantId: 'tenant-a',
      template: 'Tenant override',
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const visible = await overrides.list({
        where: { key: 'test.crud.scope' },
        orderBy: 'createdAt ASC',
      });

      expect(visible.map((item) => item.tenantId)).toEqual([null, 'tenant-a']);

      const loadedAppOverride = await overrides.get({
        id: appOverride.id as string,
      });
      expect(loadedAppOverride?.tenantId).toBeNull();
    });
  });
});
