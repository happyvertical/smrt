/**
 * Provider keys on the Inference settings page, end to end below the route:
 * the secrets master key comes from the runtime's provider (no environment
 * variable; the local runtime's own create-once behaviour is tested in
 * app-runtime), a real `SecretService` seals the key, and a real user
 * resolver stores and returns it. Only the outbound provider call is absent.
 */
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ObjectRegistry, resolveInference } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  Secret,
  SecretAuditLog,
  SecretService,
  TenantKey,
} from '@happyvertical/smrt-secrets';
import { enableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUserInferenceResolver } from '../resolver.js';
import { inferenceKeyIsSet, saveInferenceKey } from '../settings/key-store.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';
const API_KEY = 'sk-test-roundtrip-0123456789';
const ENV_AMK = 'fe'.repeat(32);

const here = dirname(fileURLToPath(import.meta.url));
const secretsManifest = JSON.parse(
  readFileSync(resolve(here, '../../../secrets/dist/manifest.json'), 'utf8'),
);
const registrationManifest = {
  ...secretsManifest,
  objects: {
    Secret: secretsManifest.objects['@happyvertical/smrt-secrets:Secret'],
    SecretAuditLog:
      secretsManifest.objects['@happyvertical/smrt-secrets:SecretAuditLog'],
    TenantKey: secretsManifest.objects['@happyvertical/smrt-secrets:TenantKey'],
  },
};

describe('inference provider keys on a local runtime', () => {
  let db: DatabaseInterface;
  // A stand-in for `runtime.secretMasterKey()`: one key, created on first
  // call and the same after a "restart" (a second runtime over the same store).
  let storedKey: string | undefined;
  const output: string[] = [];

  function startRuntime() {
    return {
      secretMasterKey: async () => {
        storedKey ??= randomBytes(32).toString('hex');
        return storedKey;
      },
    };
  }

  const asAlice = <T>(run: () => Promise<T>) =>
    withTenant({ tenantId: TENANT, userId: ALICE }, run);

  beforeEach(async () => {
    delete process.env.SMRT_SECRET_MASTER_KEY;
    enableTenancy();
    for (const [name, ctor] of [
      ['Secret', Secret],
      ['SecretAuditLog', SecretAuditLog],
      ['TenantKey', TenantKey],
    ] as const) {
      ObjectRegistry.register(ctor, {
        name,
        packageName: '@happyvertical/smrt-secrets',
        _manifest: registrationManifest,
      });
    }
    db = await getTestDatabase();
    storedKey = undefined;
    output.length = 0;
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, 'write').mockImplementation(((chunk: unknown) => {
        output.push(String(chunk));
        return true;
      }) as never);
    }
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        output.push(args.map(String).join(' '));
      });
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

  it('saves a key with no environment variable, shows it as set, and the resolver uses it across a restart', async () => {
    const runtime = startRuntime();
    const masterKey = await runtime.secretMasterKey();
    const service = await SecretService.create({
      db,
      masterKeyProvider: () => runtime.secretMasterKey(),
    });
    const resolver = createUserInferenceResolver({ secrets: service });

    await asAlice(async () => {
      expect(await inferenceKeyIsSet(resolver)).toBe(false);
      await saveInferenceKey(resolver, { provider: 'openai', key: API_KEY });
      expect(await inferenceKeyIsSet(resolver)).toBe(true);
      expect(
        await resolveInference({ tier: 'great' }, { resolver }),
      ).toMatchObject({
        via: 'resolver',
        target: { apiKey: API_KEY, source: 'byo' },
      });
    });

    // The key is sealed at rest.
    const rows = await db.query('SELECT * FROM secrets');
    expect(JSON.stringify(rows.rows)).not.toContain(API_KEY);

    // A restarted process loads the same master key and reads the key back.
    const restarted = startRuntime();
    expect(await restarted.secretMasterKey()).toBe(masterKey);
    const reopened = createUserInferenceResolver({
      secrets: await SecretService.create({
        db,
        masterKeyProvider: () => restarted.secretMasterKey(),
      }),
    });
    await asAlice(async () => {
      expect(await inferenceKeyIsSet(reopened)).toBe(true);
      expect(
        await resolveInference({ tier: 'great' }, { resolver: reopened }),
      ).toMatchObject({ via: 'resolver', target: { apiKey: API_KEY } });
    });

    // Neither the key nor the master key reached any log or output.
    const written = output.join('\n');
    expect(written).not.toContain(API_KEY);
    expect(written).not.toContain(masterKey);
  });

  it('lets SMRT_SECRET_MASTER_KEY win and never creates a local key', async () => {
    process.env.SMRT_SECRET_MASTER_KEY = ENV_AMK;
    const runtime = startRuntime();
    const provider = vi.fn(() => runtime.secretMasterKey());
    const service = await SecretService.create({
      db,
      masterKeyProvider: provider,
    });
    const resolver = createUserInferenceResolver({ secrets: service });
    await asAlice(async () => {
      await saveInferenceKey(resolver, { provider: 'openai', key: API_KEY });
      expect(await inferenceKeyIsSet(resolver)).toBe(true);
    });
    expect(provider).not.toHaveBeenCalled();
    expect(storedKey).toBeUndefined();
  });

  it('refuses a key it cannot bind without echoing it, and a missing store shows not set', async () => {
    const runtime = startRuntime();
    const service = await SecretService.create({
      db,
      masterKeyProvider: () => runtime.secretMasterKey(),
    });
    const resolver = createUserInferenceResolver({ secrets: service });
    await asAlice(async () => {
      const failure = await saveInferenceKey(resolver, {
        provider: 'no-such-provider-xyz',
        key: API_KEY,
      }).then(
        () => null,
        (error: Error) => error,
      );
      expect(failure).not.toBeNull();
      expect(failure?.message).not.toContain(API_KEY);
      expect(await inferenceKeyIsSet(resolver)).toBe(false);
    });
    const broken = {
      resolveBindings: async () => {
        throw new Error(`cannot open the store for ${API_KEY}`);
      },
    };
    expect(await inferenceKeyIsSet(broken)).toBe(false);
  });
});
