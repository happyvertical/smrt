import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ObjectRegistry, smrt } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  Secret,
  SecretAuditLog,
  SecretService,
  TenantKey,
} from '@happyvertical/smrt-secrets';
import { enableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import { Tenant, TenantCollection } from '@happyvertical/smrt-users';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Agent } from './agent.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));
const secretsManifest = JSON.parse(
  readFileSync(
    resolve(FIXTURE_DIR, '../../secrets/dist/manifest.json'),
    'utf8',
  ),
);
const usersManifest = JSON.parse(
  readFileSync(resolve(FIXTURE_DIR, '../../users/dist/manifest.json'), 'utf8'),
);
const secretsRegistrationManifest = {
  ...secretsManifest,
  objects: {
    Secret: secretsManifest.objects['@happyvertical/smrt-secrets:Secret'],
    SecretAuditLog:
      secretsManifest.objects['@happyvertical/smrt-secrets:SecretAuditLog'],
    TenantKey: secretsManifest.objects['@happyvertical/smrt-secrets:TenantKey'],
  },
};
const usersRegistrationManifest = {
  ...usersManifest,
  objects: {
    Tenant: usersManifest.objects['@happyvertical/smrt-users:Tenant'],
  },
};

@smrt()
class GeminiSecretAgent extends Agent {
  protected config = {
    ai: {
      type: 'gemini',
      defaultModel: 'gemini-flash-latest',
      apiKeySecretFallback: 'ancestors' as const,
    },
  };

  async run(): Promise<void> {}
}

@smrt()
class NoAncestorFallbackAgent extends Agent {
  protected config = {
    ai: {
      type: 'gemini',
      defaultModel: 'gemini-flash-latest',
      apiKeySecretFallback: 'none' as const,
    },
  };

  async run(): Promise<void> {}
}

describe('agent AI secret resolution', () => {
  let db: DatabaseInterface;
  let secrets: SecretService;
  let tenants: TenantCollection;

  beforeEach(async () => {
    enableTenancy();
    process.env.SMRT_SECRET_MASTER_KEY = TEST_AMK;

    ObjectRegistry.register(Secret, {
      name: 'Secret',
      packageName: '@happyvertical/smrt-secrets',
      _manifest: secretsRegistrationManifest,
    });
    ObjectRegistry.register(SecretAuditLog, {
      name: 'SecretAuditLog',
      packageName: '@happyvertical/smrt-secrets',
      _manifest: secretsRegistrationManifest,
    });
    ObjectRegistry.register(TenantKey, {
      name: 'TenantKey',
      packageName: '@happyvertical/smrt-secrets',
      _manifest: secretsRegistrationManifest,
    });
    ObjectRegistry.register(Tenant, {
      name: 'Tenant',
      packageName: '@happyvertical/smrt-users',
      _manifest: usersRegistrationManifest,
    });
    db = await getTestDatabase();
    secrets = await SecretService.create({ db });
    tenants = await TenantCollection.create({ db });
  });

  afterEach(() => {
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

  async function createTenantHierarchy() {
    const root = await tenants.create({
      name: 'Anytown Network',
      slug: 'anytown',
    });
    await root.save();

    const child = await tenants.create({
      name: 'Bentley Alberta',
      slug: 'bentleyalberta',
      parentTenantId: root.id,
      hierarchyLevel: 1,
      hierarchyPath: root.id,
    });
    await child.save();

    return { root, child };
  }

  it('resolves the default provider secret from the current tenant', async () => {
    const { child } = await createTenantHierarchy();

    await withTenant({ tenantId: child.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'tenant-specific-key');

      const agent = new GeminiSecretAgent({ db });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBe('tenant-specific-key');
    });
  });

  it('falls back to ancestor tenant secrets by default', async () => {
    const { root, child } = await createTenantHierarchy();

    await withTenant({ tenantId: root.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'network-key');
    });

    await withTenant({ tenantId: child.id! }, async () => {
      const agent = new GeminiSecretAgent({ db });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBe('network-key');
    });
  });

  it('respects explicit api keys over tenant secrets', async () => {
    const { root, child } = await createTenantHierarchy();

    await withTenant({ tenantId: root.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'network-key');
    });

    await withTenant({ tenantId: child.id! }, async () => {
      const agent = new GeminiSecretAgent({
        db,
        ai: {
          type: 'gemini',
          apiKey: 'explicit-key',
          apiKeySecretFallback: 'ancestors',
        },
      });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBe('explicit-key');
    });
  });

  it('can opt out of ancestor fallback', async () => {
    const { root, child } = await createTenantHierarchy();

    await withTenant({ tenantId: root.id! }, async () => {
      await secrets.store('GEMINI_API_KEY', 'network-key');
    });

    await withTenant({ tenantId: child.id! }, async () => {
      const agent = new NoAncestorFallbackAgent({ db });
      await agent.initialize();

      expect(
        (agent.options.ai as { apiKey?: string } | undefined)?.apiKey,
      ).toBeUndefined();
    });
  });
});
