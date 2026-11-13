import { randomUUID } from 'node:crypto';
import {
  getTestDatabase,
  type InferenceConfig,
  type InferenceResolver,
  resolveInference,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  APP_INFERENCE_SCOPE_ID,
  createInferenceOverrideResolver,
  InferenceOverrideCollection,
  InferenceSettingsService,
} from '../server.js';

const APP = APP_INFERENCE_SCOPE_ID;

describe('createInferenceOverrideResolver', () => {
  let db: DatabaseInterface;
  let config: InferenceConfig;
  let admin: InferenceSettingsService;
  let tenantId: string;
  let resolver: InferenceResolver;

  beforeEach(async () => {
    db = await getTestDatabase({ classes: ['InferenceOverride'] });
    tenantId = randomUUID();
    config = {
      tiers: { great: { provider: 'anthropic', model: 'claude-config' } },
      aliases: {
        local: { candidates: [{ preset: 'lemonade', model: 'qwen' }] },
      },
    };
    admin = await InferenceSettingsService.create(
      { db },
      { config: () => config, authorize: () => true },
    );
    resolver = createInferenceOverrideResolver({ db: { db }, ttlMs: 60_000 });
  });

  afterEach(async () => {
    await (db as { close?: () => Promise<void> }).close?.();
  });

  const resolve = (
    tier: 'cheap' | 'good' | 'great' | 'best' | 'auto',
    tenant?: string,
  ) =>
    resolveInference({ tier, tenantId: tenant ?? null }, { resolver, config });

  it('changes nothing when the table is empty', async () => {
    expect(await resolve('great')).toEqual({
      tierResolved: 'great',
      target: { provider: 'anthropic', model: 'claude-config' },
      via: 'config',
    });
    expect(await resolve('cheap')).toEqual({
      tierResolved: 'cheap',
      target: {},
      via: 'default',
    });
  });

  it('reads its database options lazily, once, when given a function', async () => {
    let calls = 0;
    resolver = createInferenceOverrideResolver({
      db: () => {
        calls += 1;
        return { db };
      },
      ttlMs: 0,
    });
    expect(calls).toBe(0);
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'app',
      scopeId: APP,
      target: { provider: 'openai', model: 'gpt-lazy' },
    });
    expect((await resolve('good')).target).toEqual({
      provider: 'openai',
      model: 'gpt-lazy',
    });
    await resolve('good');
    expect(calls).toBe(1);
  });

  it('binds app rows, then allowed tenant rows', async () => {
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'app',
      scopeId: APP,
      target: { provider: 'openai', model: 'gpt-app' },
    });
    await admin.setTenantAllowList({
      binding: 'tier:good',
      allowList: ['alias:local'],
    });
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { alias: 'local' },
    });
    expect((await resolve('good')).target).toEqual({
      provider: 'openai',
      model: 'gpt-app',
    });
    expect(await resolve('good', tenantId)).toEqual({
      tierResolved: 'good',
      target: { alias: 'local' },
      via: 'resolver',
    });
  });

  it('expands app-defined aliases into inline candidates', async () => {
    await admin.setAlias({
      name: 'gateway',
      alias: {
        candidates: [
          {
            provider: 'openai',
            model: 'gpt-gw',
            baseUrl: 'https://gw.test/v1',
            apiKeyEnv: 'GW_KEY',
          },
          { alias: 'local' },
        ],
      },
    });
    await admin.setTierOverride({
      tier: 'best',
      scopeType: 'app',
      scopeId: APP,
      target: { alias: 'gateway' },
    });
    expect((await resolve('best')).target).toEqual({
      kind: 'candidates',
      candidates: [
        {
          provider: 'openai',
          model: 'gpt-gw',
          baseUrl: 'https://gw.test/v1',
          apiKeyEnv: 'GW_KEY',
        },
        // A config alias stays a reference the executor expands.
        { alias: 'local' },
      ],
    });
  });

  it('moves auto to a stored default tier', async () => {
    await admin.setDefaultTierOverride({
      scopeType: 'app',
      scopeId: APP,
      tier: 'great',
    });
    expect(await resolve('auto')).toEqual({
      tierResolved: 'great',
      target: { provider: 'anthropic', model: 'claude-config' },
      via: 'config',
    });
  });

  it('sees a write in this process immediately despite the TTL', async () => {
    expect((await resolve('cheap')).via).toBe('default');
    await admin.setTierOverride({
      tier: 'cheap',
      scopeType: 'app',
      scopeId: APP,
      target: { model: 'mini' },
    });
    expect(await resolve('cheap')).toEqual({
      tierResolved: 'cheap',
      target: { model: 'mini' },
      via: 'resolver',
    });
  });

  it('defers to a base resolver for unbound tiers', async () => {
    const base: InferenceResolver = {
      resolve: (request) => ({
        tierResolved: request.tier === 'auto' ? 'good' : request.tier,
        target: { model: 'from-base' },
        via: 'resolver',
      }),
    };
    resolver = createInferenceOverrideResolver({ db: { db }, base });
    expect((await resolve('cheap')).target).toEqual({ model: 'from-base' });
  });

  it('re-applies the tenant policy on every call, even with warm rows', async () => {
    let allowFrontier = true;
    resolver = createInferenceOverrideResolver({
      db: { db },
      ttlMs: 60_000,
      tenantTargetPolicy: ({ ref }) => allowFrontier || ref !== 'alias:local',
    });
    await admin.setTenantAllowList({ binding: 'tier:good', allowList: ['*'] });
    await admin.setTierOverride({
      tier: 'good',
      scopeType: 'tenant',
      scopeId: tenantId,
      target: { alias: 'local' },
    });
    expect((await resolve('good', tenantId)).target).toEqual({
      alias: 'local',
    });
    allowFrontier = false; // narrowed without any override write
    expect(await resolve('good', tenantId)).toEqual({
      tierResolved: 'good',
      target: {},
      via: 'default',
    });
  });

  it('fails only the tier whose chain dangles', async () => {
    const overrides = (await InferenceOverrideCollection.create({
      db,
    })) as InferenceOverrideCollection;
    // Written past the service (which would refuse it): a dangling alias.
    await overrides.setOverride('tier:cheap', 'app', APP, {
      target: { alias: 'ghost' },
    });
    await overrides.setOverride('tier:best', 'app', APP, {
      target: { model: 'ok' },
    });
    await expect(resolve('cheap')).rejects.toThrow(/ghost/);
    expect((await resolve('best')).target).toEqual({ model: 'ok' });
  });
});
