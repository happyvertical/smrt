/**
 * Hosted provisioning on PostgreSQL (#4759): SecretService, runOnce() and
 * the per-tenant advisory lock against a real server. Runs under
 * `pnpm test:postgres` (DATABASE_URL); skipped otherwise.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AIAdminProject,
  AIVirtualKey,
  CreateAIProjectOptions,
  CreateAIVirtualKeyOptions,
} from '@happyvertical/ai';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import {
  Secret,
  SecretAuditLog,
  SecretService,
  TenantKey,
} from '@happyvertical/smrt-secrets';
import { enableTenancy, withTenant } from '@happyvertical/smrt-tenancy';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createHostedInferenceProvisioner,
  type HostedGatewayAdmin,
} from '../hosted.js';
import { inferenceProviderConfigSecretName } from '../resolver.js';

const { getDatabase } =
  await vi.importActual<typeof import('@happyvertical/sql')>(
    '@happyvertical/sql',
  );

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';

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

class FakeAdmin implements HostedGatewayAdmin {
  keys: CreateAIVirtualKeyOptions[] = [];
  deleted: string[] = [];
  async createProject(
    options: CreateAIProjectOptions,
  ): Promise<AIAdminProject> {
    return { id: options.id ?? 'p', name: options.name, provider: 'litellm' };
  }
  async createVirtualKey(
    options: CreateAIVirtualKeyOptions,
  ): Promise<AIVirtualKey> {
    this.keys.push(options);
    return {
      id: `key-id-${this.keys.length}`,
      key: `sk-hosted-${this.keys.length}`,
      provider: 'litellm',
    };
  }
  async updateVirtualKey(id: string): Promise<AIVirtualKey> {
    return { id, provider: 'litellm' };
  }
  async deleteVirtualKey(id: string): Promise<boolean> {
    this.deleted.push(id);
    return true;
  }
  async listProjects(): Promise<AIAdminProject[]> {
    return [];
  }
}

async function withDatabase(
  run: (
    db: Awaited<ReturnType<typeof getDatabase>>,
    url: string,
  ) => Promise<void>,
): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL required');
  const admin = await getDatabase({ type: 'postgres', url: baseUrl });
  const name = `hosted_4759_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${name}`;
  const db = await getDatabase({ type: 'postgres', url: url.toString() });
  try {
    await run(db, url.toString());
  } finally {
    await db.close?.();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.close?.();
  }
}

describe('hosted provisioning on PostgreSQL (#4759)', () => {
  afterEach(() => {
    delete process.env.SMRT_SECRET_MASTER_KEY;
  });

  it.skipIf(!isPostgresAvailable())(
    'provisions, waits on another process holding the tenant lock, and revokes',
    async () => {
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
      await withDatabase(async (db, url) => {
        await getTestDatabase({
          db,
          classes: ['Secret', 'SecretAuditLog', 'TenantKey'],
        });
        const secrets = await SecretService.create({ db });
        const admin = new FakeAdmin();
        const p = createHostedInferenceProvisioner({
          db,
          secrets,
          admin,
          gateway: {
            provider: 'litellm',
            baseUrl: 'https://llm.example.test/v1',
            adminApiKey: 'sk-master',
            model: 'gpt-good',
          },
        });

        // Another process holds the tenant's lifecycle lock (another pooled
        // connection; getDatabase() shares the pool, so it is not closed here).
        const other = await getDatabase({ type: 'postgres', url });
        let releaseOther!: () => void;
        const otherDone = new Promise<void>((done) => {
          releaseOther = done;
        });
        let otherLocked!: () => void;
        const lockedSignal = new Promise<void>((done) => {
          otherLocked = done;
        });
        const holder = other.transaction?.(async (tx) => {
          await tx.query(
            'SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))',
            JSON.stringify(['smrt.inference.hosted', TENANT]),
          );
          otherLocked();
          await otherDone;
        });
        await lockedSignal;
        const provisioning = p.provision({
          tenantId: TENANT,
          userId: ALICE,
          budget: { limitMicros: 1_000_000 },
        });
        await new Promise((done) => setTimeout(done, 300));
        expect(admin.keys).toHaveLength(0);
        releaseOther();
        await holder;
        await expect(provisioning).resolves.toMatchObject({ created: true });

        const config = await withTenant({ tenantId: TENANT }, () =>
          secrets.retrieve(
            inferenceProviderConfigSecretName({ userId: ALICE }),
          ),
        );
        expect(JSON.parse(config.value)).toMatchObject({
          source: 'hosted',
          mode: 'hosted',
        });

        // Concurrent duplicate deliveries: still one key.
        await Promise.all([
          p.provision({
            tenantId: TENANT,
            userId: ALICE,
            budget: { limitMicros: 1_000_000 },
          }),
          p.provision({
            tenantId: TENANT,
            userId: ALICE,
            budget: { limitMicros: 1_000_000 },
          }),
        ]);
        expect(admin.keys).toHaveLength(1);

        await expect(
          p.revoke({ tenantId: TENANT, userId: ALICE }),
        ).resolves.toMatchObject({ revoked: true, gateway: 'revoked' });
        const claims = await db.query(
          'SELECT result FROM _smrt_run_once_claims',
        );
        expect(JSON.stringify(claims.rows)).not.toContain('sk-hosted-');
      });
    },
  );
});
