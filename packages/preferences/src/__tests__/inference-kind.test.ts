/**
 * The smrt-inference `inference` kind (#4754) through this package's real
 * store: registration, tiers, permissions and key refusal. Lives here, not
 * in smrt-inference, because smrt-cli depends on smrt-inference and reaches
 * this package, so the reverse dev dependency would be a workspace cycle.
 */
import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  CUSTOMIZE_INFERENCE_PERMISSION,
  createInferencePreferences,
  INFERENCE_PERMISSION_DEFINITIONS,
  inferencePreferenceKind,
  PERSONALIZE_INFERENCE_PERMISSION,
} from '@happyvertical/smrt-inference/server';
import {
  resetTenancy,
  setupTestTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { registerPermissionDefinitions } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreferenceStore, registerPreferenceKind } from '../index.js';

describe('inference preference kind round trip', () => {
  let db: DatabaseInterface;
  let disposeKind: (() => void) | undefined;
  let disposePermissions: (() => void) | undefined;
  const tenantId = randomUUID();
  const alice = randomUUID();

  beforeEach(async () => {
    setupTestTenancy();
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['UiPreferenceRecord'],
    });
    disposePermissions = registerPermissionDefinitions([
      ...INFERENCE_PERMISSION_DEFINITIONS,
    ]);
    disposeKind = registerPreferenceKind(inferencePreferenceKind);
  });

  afterEach(async () => {
    disposeKind?.();
    disposePermissions?.();
    resetTenancy();
    await (db as { close?: () => Promise<void> }).close?.();
  });

  const as = <T>(permissions: string[], fn: () => Promise<T>) =>
    withTenant(
      { tenantId, userId: alice, permissions: new Set(permissions) },
      fn,
    );

  it('stores tenant defaults and user choices and reads them merged', async () => {
    const prefs = createInferencePreferences(createPreferenceStore({ db }));
    await as(
      [CUSTOMIZE_INFERENCE_PERMISSION, PERSONALIZE_INFERENCE_PERMISSION],
      async () => {
        const tenant = await prefs.write(
          { mode: 'hosted', defaultTier: 'good' },
          { scope: 'tenant', revision: null },
        );
        expect(tenant.ok).toBe(true);
        const user = await prefs.write(
          { mode: 'byo', provider: 'openrouter', model: 'qwen/qwen3' },
          { revision: null },
        );
        expect(user.ok).toBe(true);

        const read = await prefs.read();
        expect(read.tenant).toEqual({ mode: 'hosted', defaultTier: 'good' });
        expect(read.user).toEqual({
          mode: 'byo',
          provider: 'openrouter',
          model: 'qwen/qwen3',
        });
        expect(read.choices).toEqual({
          mode: 'byo',
          provider: 'openrouter',
          model: 'qwen/qwen3',
          defaultTier: 'good',
        });
        expect(read.canCustomize).toEqual({ tenant: true, user: true });

        // A key never becomes a preference.
        const leak = await prefs.write(
          { mode: 'byo', apiKey: 'sk-secret-value' } as never,
          { revision: read.revisions.user },
        );
        expect(leak.ok).toBe(false);

        const reset = await prefs.reset({ revision: read.revisions.user });
        expect(reset.ok).toBe(true);
        expect((await prefs.read()).choices).toEqual({
          mode: 'hosted',
          defaultTier: 'good',
        });
      },
    );
  });

  it('needs the personalize permission for a user choice', async () => {
    const prefs = createInferencePreferences(createPreferenceStore({ db }));
    const result = await as([], () =>
      prefs.write({ mode: 'local' }, { revision: null }),
    );
    expect(result).toMatchObject({ ok: false, reason: 'not_allowed' });
  });
});
