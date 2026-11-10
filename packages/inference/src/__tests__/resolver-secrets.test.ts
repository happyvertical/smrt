/**
 * The per-user resolver against a real `SecretService` (#4756): writes go
 * through `store()` with `context = tenantId` and a user-qualified name,
 * reads through `retrieve()` (audited), and two users of one tenant never
 * see each other's config.
 */
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createUserInferenceResolver,
  INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
  inferenceProviderConfigSecretName,
} from '../resolver.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';
const ALICE_KEY = 'sk-alice-secret';

const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const secretsManifest = JSON.parse(
  readFileSync(
    resolve(FIXTURE_DIR, '../../../secrets/dist/manifest.json'),
    'utf8',
  ),
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

describe('createUserInferenceResolver over SecretService', () => {
  let db: DatabaseInterface;

  beforeEach(async () => {
    enableTenancy();
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;
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
  });

  afterEach(() => {
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

  it('stores per user under the tenant and reads back only the own config', async () => {
    const resolver = createUserInferenceResolver({ db });
    const config = {
      preset: 'openrouter',
      model: 'anthropic/claude-x',
      apiKey: ALICE_KEY,
    };
    await withTenant({ tenantId: TENANT, userId: ALICE }, () =>
      resolver.write('user', config),
    );

    const secrets = await SecretService.create({ db });
    const row = await withTenant({ tenantId: TENANT }, async () =>
      (await secrets.list()).find(
        (secret) =>
          secret.name === inferenceProviderConfigSecretName({ userId: ALICE }),
      ),
    );
    expect(row).toMatchObject({
      category: INFERENCE_PROVIDER_CONFIG_SECRET_TYPE,
      context: TENANT,
    });
    expect(row?.encryptedValue).not.toContain(ALICE_KEY);

    const alice = await withTenant({ tenantId: TENANT, userId: ALICE }, () =>
      resolveInference({ tier: 'great' }, { resolver }),
    );
    expect(alice).toMatchObject({
      via: 'resolver',
      target: {
        baseUrl: 'https://openrouter.ai/api/v1',
        apiKey: ALICE_KEY,
        source: 'byo',
      },
    });

    const bob = await withTenant({ tenantId: TENANT, userId: BOB }, () =>
      resolveInference({ tier: 'great' }, { resolver }),
    );
    expect(bob.via).toBe('default');
    expect(JSON.stringify(bob)).not.toContain(ALICE_KEY);

    const audit = await withTenant({ tenantId: TENANT }, () =>
      secrets.getAuditLogs(),
    );
    expect(
      audit.some(
        (entry: { action?: string; userId?: string | null }) =>
          entry.action === 'read' && entry.userId === ALICE,
      ),
    ).toBe(true);
  });
});
