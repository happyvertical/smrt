/**
 * Hosted inference provisioning (#4759) against a real SecretService and
 * runOnce(), with a fake gateway admin client (no network).
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type {
  AIAdminProject,
  AIVirtualKey,
  CreateAIProjectOptions,
  CreateAIVirtualKeyOptions,
} from '@happyvertical/ai';
import {
  INFERENCE_TIERS,
  inferenceUsageTags,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
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
import {
  createHostedInferenceEntitlementListener,
  createHostedInferenceProvisioner,
  createHostedInferenceReconciler,
  type HostedGatewayAdmin,
  type HostedGatewayConfig,
  HostedInferenceError,
  hostedGatewayConfigFromEnv,
  hostedInferenceStateSecretName,
  provisionHostedInference,
  revokeHostedInference,
  toGatewayBudget,
} from '../hosted.js';
import {
  createUserInferenceResolver,
  inferenceProviderConfigSecretName,
  parseInferenceProviderConfig,
} from '../resolver.js';

const TEST_AMK =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ALICE = '33333333-3333-4333-8333-333333333333';
const BOB = '44444444-4444-4444-8444-444444444444';
const ADMIN_SECRET = 'sk-litellm-master-DO-NOT-LEAK';
const KEY_MARK = 'sk-hosted-virtual-key';

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

const GATEWAY: HostedGatewayConfig = {
  provider: 'litellm',
  baseUrl: 'https://llm.example.test/v1',
  adminApiKey: ADMIN_SECRET,
  model: 'gpt-good',
  tiers: { cheap: 'gpt-cheap', best: 'gpt-best' },
};

class FakeAdmin implements HostedGatewayAdmin {
  projects: CreateAIProjectOptions[] = [];
  keys: CreateAIVirtualKeyOptions[] = [];
  updates: Array<{ id: string; options: unknown }> = [];
  deleted: string[] = [];
  live = new Set<string>();
  failCreateKey: Error | undefined;

  async createProject(
    options: CreateAIProjectOptions,
  ): Promise<AIAdminProject> {
    this.projects.push(options);
    return { id: options.id ?? 'p', name: options.name, provider: 'litellm' };
  }

  async createVirtualKey(
    options: CreateAIVirtualKeyOptions,
  ): Promise<AIVirtualKey> {
    if (this.failCreateKey) throw this.failCreateKey;
    this.keys.push(options);
    const id = `key-id-${this.keys.length}`;
    this.live.add(id);
    return {
      id,
      name: options.name,
      key: `${KEY_MARK}-${this.keys.length}`,
      provider: 'litellm',
    };
  }

  async updateVirtualKey(id: string, options: unknown): Promise<AIVirtualKey> {
    this.updates.push({ id, options });
    return { id, provider: 'litellm' };
  }

  async deleteVirtualKey(id: string): Promise<boolean> {
    this.deleted.push(id);
    return this.live.delete(id);
  }
}

/** The admin surface as `@happyvertical/ai` 0.111 ships it (no update/delete). */
class CreateOnlyAdmin implements HostedGatewayAdmin {
  inner = new FakeAdmin();
  createProject(options: CreateAIProjectOptions) {
    return this.inner.createProject(options);
  }
  createVirtualKey(options: CreateAIVirtualKeyOptions) {
    return this.inner.createVirtualKey(options);
  }
}

describe('hosted inference provisioning (#4759)', () => {
  let db: DatabaseInterface;
  let secrets: SecretService;
  let admin: FakeAdmin;

  const read = (name: string) =>
    withTenant({ tenantId: TENANT }, async () =>
      secrets.retrieve(name).then(
        (secret) => secret.value,
        () => undefined,
      ),
    );
  const userConfig = async (userId: string) => {
    const value = await read(inferenceProviderConfigSecretName({ userId }));
    return value === undefined ? undefined : JSON.parse(value);
  };
  const provisioner = (
    overrides: { admin?: HostedGatewayAdmin; nonce?: () => string } = {},
  ) =>
    createHostedInferenceProvisioner({
      db,
      secrets,
      gateway: GATEWAY,
      admin: overrides.admin ?? admin,
      nonce: overrides.nonce ?? (() => 'x'),
    });
  const writeByo = (userId: string) =>
    withTenant({ tenantId: TENANT }, () =>
      secrets.store(
        inferenceProviderConfigSecretName({ userId }),
        JSON.stringify({
          provider: 'openai',
          baseUrl: 'https://api.openai.com/v1',
          apiKey: 'sk-byo-alice',
          model: 'gpt-own',
        }),
        { category: 'inference.provider-config' },
      ),
    );

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
    secrets = await SecretService.create({ db });
    admin = new FakeAdmin();
  });

  afterEach(() => {
    delete process.env.SMRT_SECRET_MASTER_KEY;
    vi.restoreAllMocks();
  });

  it('mints a per-user key in one tenant project and stores it as the hosted config', async () => {
    const result = await provisionHostedInference({
      db,
      secrets,
      gateway: GATEWAY,
      admin,
      nonce: () => 'x',
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 5_000_000 },
    });
    expect(result).toMatchObject({
      status: 'active',
      created: true,
      generation: 0,
      projectId: `smrt-${TENANT}-x`,
      keyId: 'key-id-1',
      keyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
      budget: { limitMicros: 5_000_000, window: 'month' },
    });
    expect(admin.projects).toHaveLength(1);
    expect(admin.keys[0]).toMatchObject({
      name: `smrt-${TENANT}-${ALICE}-g0-x`,
      projectId: `smrt-${TENANT}-x`,
      tenantId: TENANT,
      userId: ALICE,
      budget: { maxLimit: 5, resetDuration: '30d' },
      models: ['gpt-good', 'gpt-cheap', 'gpt-best'],
    });

    const stored = parseInferenceProviderConfig(await userConfig(ALICE));
    expect(stored).toMatchObject({
      source: 'hosted',
      mode: 'hosted',
      provider: 'litellm',
      baseUrl: GATEWAY.baseUrl,
      apiKey: `${KEY_MARK}-1`,
      model: 'gpt-good',
      gatewayKeyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
    });
    expect(stored.tiers?.best?.model).toBe('gpt-best');

    // A second user of the tenant reuses the project.
    await provisioner().provision({
      tenantId: TENANT,
      userId: BOB,
      budget: { limitMicros: 5_000_000 },
    });
    expect(admin.projects).toHaveLength(1);
    expect(admin.keys).toHaveLength(2);
  });

  it('binds hosted tiers with source and alias tags, never the key', async () => {
    await provisioner().provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    const resolver = createUserInferenceResolver({ db });
    const resolution = await withTenant(
      { tenantId: TENANT, userId: ALICE },
      async () =>
        resolver.resolve(
          { tier: 'cheap' },
          {
            config: {},
            resolveFromConfig: () => ({
              tierResolved: 'cheap',
              target: {},
              via: 'config',
            }),
          },
        ),
    );
    expect(resolution).toMatchObject({
      mode: 'hosted',
      target: {
        provider: 'litellm',
        model: 'gpt-cheap',
        source: 'hosted',
        usageTags: { gatewayKeyAlias: `smrt-${TENANT}-${ALICE}-g0-x` },
      },
    });
    const tags = inferenceUsageTags('cheap', resolution as never);
    expect(tags).toEqual({
      gatewayKeyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
      tierRequested: 'cheap',
      tierResolved: 'cheap',
      source: 'hosted',
    });
    expect(JSON.stringify(tags)).not.toContain(KEY_MARK);
    const bindings = await withTenant({ tenantId: TENANT, userId: ALICE }, () =>
      resolver.resolveBindings(),
    );
    expect(JSON.stringify(bindings)).not.toContain(KEY_MARK);
    expect(bindings.user).toMatchObject({
      gatewayKeyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
    });
  });

  it('is idempotent per user, including concurrent deliveries', async () => {
    const p = provisioner();
    const budget = { limitMicros: 2_000_000 };
    const [a, b] = await Promise.all([
      p.provision({ tenantId: TENANT, userId: ALICE, budget }),
      p.provision({ tenantId: TENANT, userId: ALICE, budget }),
    ]);
    expect(admin.keys).toHaveLength(1);
    expect(a.keyAlias).toBe(b.keyAlias);
    const again = await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget,
    });
    expect(again).toMatchObject({ created: false, keyId: 'key-id-1' });
    expect(admin.keys).toHaveLength(1);
    expect(admin.updates).toHaveLength(0);
  });

  it('syncs the gateway budget when the plan budget changes', async () => {
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 2_000_000 },
    });
    const synced = await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 9_500_000, window: 'week' },
    });
    expect(synced).toMatchObject({
      created: false,
      budgetSync: 'updated',
      budget: { limitMicros: 9_500_000, window: 'week' },
    });
    expect(admin.updates).toEqual([
      {
        id: 'key-id-1',
        options: { budget: { maxLimit: 9.5, resetDuration: '7d' } },
      },
    ]);
    await expect(
      p.syncBudget({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 9_500_000, window: 'week' },
      }),
    ).resolves.toMatchObject({ sync: 'unchanged' });
  });

  it('reports budget sync as unsupported without the SDK update call', async () => {
    const createOnly = new CreateOnlyAdmin();
    const p = provisioner({ admin: createOnly });
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 2_000_000 },
    });
    const result = await p.syncBudget({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 3_000_000 },
    });
    expect(result).toMatchObject({
      sync: 'unsupported',
      budget: { limitMicros: 2_000_000 },
    });
  });

  it('revoke restores the prior BYO config and a re-provision mints a new key', async () => {
    await writeByo(ALICE);
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    expect((await userConfig(ALICE)).source).toBe('hosted');

    const revoked = await p.revoke({
      tenantId: TENANT,
      userId: ALICE,
      reason: 'downgrade',
    });
    expect(revoked).toMatchObject({
      revoked: true,
      gateway: 'revoked',
      restored: 'prior',
      status: 'revoked',
      generation: 1,
    });
    expect(admin.deleted).toEqual(['key-id-1']);
    expect(await userConfig(ALICE)).toMatchObject({
      provider: 'openai',
      apiKey: 'sk-byo-alice',
      model: 'gpt-own',
    });
    expect((await userConfig(ALICE)).source).toBeUndefined();

    // Revoking again is a no-op.
    await expect(
      p.revoke({ tenantId: TENANT, userId: ALICE }),
    ).resolves.toMatchObject({ revoked: false, gateway: 'none' });

    const again = await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    expect(again).toMatchObject({
      created: true,
      generation: 1,
      keyAlias: `smrt-${TENANT}-${ALICE}-g1-x`,
    });
    expect(admin.keys).toHaveLength(2);
    // The prior BYO config is kept again for the next revoke.
    await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect((await userConfig(ALICE)).apiKey).toBe('sk-byo-alice');
  });

  it('revoke without a prior config sets mode off', async () => {
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: BOB,
      budget: { limitMicros: 1_000_000 },
    });
    const revoked = await revokeHostedInference({
      db,
      secrets,
      gateway: GATEWAY,
      admin,
      nonce: () => 'x',
      tenantId: TENANT,
      userId: BOB,
    });
    expect(revoked.restored).toBe('off');
    expect(await userConfig(BOB)).toEqual({ mode: 'off' });
  });

  it('revoke still removes the key locally when the SDK cannot delete it, and audits that', async () => {
    const createOnly = new CreateOnlyAdmin();
    const p = provisioner({ admin: createOnly });
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    const revoked = await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect(revoked).toMatchObject({
      gateway: 'unsupported',
      restored: 'off',
      pendingGatewayRevocations: [
        expect.objectContaining({ keyId: 'key-id-1', reason: 'unsupported' }),
      ],
    });
    expect(JSON.stringify(await userConfig(ALICE))).not.toContain(KEY_MARK);

    const logs = await withTenant({ tenantId: TENANT }, () =>
      secrets.getAuditLogs({
        secretName: hostedInferenceStateSecretName(ALICE),
      }),
    );
    const revokeEntry = logs.find(
      (log) => log.details?.operation === 'inference.hosted.revoke',
    );
    expect(revokeEntry?.details).toMatchObject({
      gateway: 'unsupported',
      manualGatewayRevocation: true,
      keyId: 'key-id-1',
      keyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
    });
  });

  it('keeps a config the user replaced and retires the stale key on re-provision', async () => {
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    await writeByo(ALICE); // the user switched back to their own key
    const again = await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    expect(again).toMatchObject({ created: true, generation: 1 });
    expect(admin.deleted).toEqual(['key-id-1']);
    const revoked = await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect(revoked.restored).toBe('prior');
    expect((await userConfig(ALICE)).apiKey).toBe('sk-byo-alice');
  });

  it('leaves nothing behind when the gateway refuses the key', async () => {
    admin.failCreateKey = Object.assign(
      new Error(`401 invalid master key ${ADMIN_SECRET}`),
      { code: 'AUTH_ERROR' },
    );
    const error = await provisioner()
      .provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HostedInferenceError);
    expect((error as HostedInferenceError).code).toBe('HOSTED_GATEWAY_FAILED');
    expect(JSON.stringify(error)).not.toContain(ADMIN_SECRET);
    expect(String((error as Error).message)).not.toContain(ADMIN_SECRET);
    expect(await userConfig(ALICE)).toBeUndefined();
    await expect(
      provisioner().status({ tenantId: TENANT, userId: ALICE }),
    ).resolves.toMatchObject({ status: 'none' });

    // A retry after the gateway recovers runs again (the claim rolled back).
    admin.failCreateKey = undefined;
    await expect(
      provisioner().provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('rolls the state back and discards the key when storing the binding fails', async () => {
    await writeByo(ALICE);
    const configName = inferenceProviderConfigSecretName({ userId: ALICE });
    let failNext = true;
    const flaky = {
      retrieve: (name: string) => secrets.retrieve(name),
      list: (options?: { category?: string }) => secrets.list(options),
      delete: (
        name: string,
        options?: { auditDetails?: Record<string, unknown> },
      ) => secrets.delete(name, options),
      store: (
        name: string,
        value: string,
        options?: Parameters<SecretService['store']>[2],
      ) => {
        if (name === configName && failNext) {
          failNext = false;
          return Promise.reject(new Error('disk full'));
        }
        return secrets.store(name, value, options);
      },
    };
    const p = createHostedInferenceProvisioner({
      db,
      secrets: flaky,
      gateway: GATEWAY,
      admin,
      nonce: () => 'x',
    });
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).rejects.toThrow('disk full');
    expect(admin.deleted).toEqual(['key-id-1']);
    expect((await userConfig(ALICE)).apiKey).toBe('sk-byo-alice');
    await expect(
      p.status({ tenantId: TENANT, userId: ALICE }),
    ).resolves.toMatchObject({ status: 'none' });

    // The retry provisions and still keeps the BYO config as the prior.
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).resolves.toMatchObject({ created: true });
    await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect((await userConfig(ALICE)).apiKey).toBe('sk-byo-alice');
  });

  it('refuses to report a replayed grant whose state was removed out of band', async () => {
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    await withTenant({ tenantId: TENANT }, async () => {
      await secrets.delete(hostedInferenceStateSecretName(ALICE));
      await secrets.delete(
        inferenceProviderConfigSecretName({ userId: ALICE }),
      );
    });
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).rejects.toMatchObject({ code: 'HOSTED_STATE_INVALID' });
    expect(admin.keys).toHaveLength(1);
  });

  it('a downgrade ends local use even when the gateway delete fails, and a retry finishes it', async () => {
    await writeByo(ALICE);
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    const realDelete = admin.deleteVirtualKey.bind(admin);
    admin.deleteVirtualKey = async () => {
      throw Object.assign(new Error('401'), { code: 'AUTH_ERROR' });
    };
    const revoked = await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect(revoked).toMatchObject({
      revoked: true,
      gateway: 'failed',
      restored: 'prior',
      pendingGatewayRevocations: [
        {
          keyId: 'key-id-1',
          reason: 'failed',
          keyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
        },
      ],
    });
    expect((await userConfig(ALICE)).apiKey).toBe('sk-byo-alice');

    admin.deleteVirtualKey = realDelete;
    const retried = await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect(retried).toMatchObject({ revoked: false, gateway: 'none' });
    expect(retried.pendingGatewayRevocations).toBeUndefined();
    expect(admin.deleted).toContain('key-id-1');
  });

  it('records the key a failed provision leaves on a create-only SDK and retries under a new alias', async () => {
    const createOnly = new CreateOnlyAdmin();
    const configName = inferenceProviderConfigSecretName({ userId: ALICE });
    let failNext = true;
    const flaky = {
      retrieve: (name: string) => secrets.retrieve(name),
      list: (options?: { category?: string }) => secrets.list(options),
      delete: (
        name: string,
        options?: { auditDetails?: Record<string, unknown> },
      ) => secrets.delete(name, options),
      store: (
        name: string,
        value: string,
        options?: Parameters<SecretService['store']>[2],
      ) => {
        if (name === configName && failNext) {
          failNext = false;
          return Promise.reject(new Error('disk full'));
        }
        return secrets.store(name, value, options);
      },
    };
    let n = 0;
    const p = createHostedInferenceProvisioner({
      db,
      secrets: flaky,
      gateway: GATEWAY,
      admin: createOnly,
      nonce: () => `n${++n}`,
    });
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).rejects.toThrow('disk full');
    const after = await p.status({ tenantId: TENANT, userId: ALICE });
    expect(after.pendingGatewayRevocations).toEqual([
      expect.objectContaining({ keyId: 'key-id-1', reason: 'orphaned' }),
    ]);
    const audit = await withTenant({ tenantId: TENANT }, () =>
      secrets.getAuditLogs({
        secretName: hostedInferenceStateSecretName(ALICE),
      }),
    );
    expect(
      audit.some(
        (entry) =>
          entry.details?.operation === 'inference.hosted.provision-rollback' &&
          entry.details?.manualGatewayRevocation === true &&
          entry.details?.keyId === 'key-id-1',
      ),
    ).toBe(true);

    const ok = await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    expect(ok.created).toBe(true);
    const aliases = createOnly.inner.keys.map((key) => key.name);
    expect(new Set(aliases).size).toBe(2);
    expect(ok.pendingGatewayRevocations).toHaveLength(1);
  });

  it('serializes a downgrade behind an in-flight provision', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = admin.createVirtualKey.bind(admin);
    admin.createVirtualKey = async (options) => {
      await gate;
      return create(options);
    };
    const p = provisioner();
    const provisioning = p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const revoking = p.revoke({ tenantId: TENANT, userId: ALICE });
    release();
    await provisioning;
    const revoked = await revoking;
    expect(revoked).toMatchObject({ revoked: true, status: 'revoked' });
    expect(await userConfig(ALICE)).toEqual({ mode: 'off' });
  });

  it('a delayed budget sync never resurrects a revoked grant', async () => {
    const p = provisioner();
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const update = admin.updateVirtualKey.bind(admin);
    admin.updateVirtualKey = async (id, options) => {
      await gate;
      return update(id, options);
    };
    const syncing = p.syncBudget({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 2_000_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const revoking = p.revoke({ tenantId: TENANT, userId: ALICE });
    release();
    await syncing;
    await revoking;
    await expect(
      p.status({ tenantId: TENANT, userId: ALICE }),
    ).resolves.toMatchObject({ status: 'revoked', generation: 1 });
  });

  it('reconciles a lost reaction from the current entitlement snapshot', async () => {
    const p = provisioner();
    const reconcile = createHostedInferenceReconciler({
      provisioner: p,
      users: async () => [ALICE, BOB],
    });
    const entitled = {
      grants: [
        {
          featureKey: 'inference.hosted',
          metadata: { budget: { limitMicros: 2_000_000 } },
        },
      ],
    };
    // A lost upgrade: reconcile provisions everyone, twice is a no-op.
    await reconcile(TENANT, entitled);
    await reconcile(TENANT, entitled);
    expect(admin.keys).toHaveLength(2);
    expect(await p.listActive(TENANT)).toEqual([ALICE, BOB].sort());
    // A lost budget change.
    await reconcile(TENANT, {
      grants: [
        {
          featureKey: 'inference.hosted',
          metadata: { budget: { limitMicros: 3_000_000 } },
        },
      ],
    });
    expect(admin.updates).toHaveLength(2);
    // A lost downgrade.
    const result = await reconcile(TENANT, { grants: [] });
    expect(result.revoked).toHaveLength(2);
    expect(await p.listActive(TENANT)).toEqual([]);
  });

  it('a tenant downgrade waits for an in-flight provision and revokes it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const create = admin.createVirtualKey.bind(admin);
    admin.createVirtualKey = async (options) => {
      await gate;
      return create(options);
    };
    const p = provisioner();
    const provisioning = p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const listener = createHostedInferenceEntitlementListener({
      provisioner: p,
      users: async () => [],
    });
    const downgrade = listener({
      tenantId: TENANT,
      gained: [],
      lost: ['inference.hosted'],
      changed: [],
      after: { grants: [] },
    });
    release();
    await provisioning;
    await downgrade;
    expect(await p.listActive(TENANT)).toEqual([]);
    expect(await userConfig(ALICE)).toEqual({ mode: 'off' });
  });

  it('runs one lifecycle operation at a time per process, across tenants', async () => {
    const OTHER = '22222222-2222-4222-8222-222222222222';
    let running = 0;
    let peak = 0;
    const create = admin.createVirtualKey.bind(admin);
    admin.createVirtualKey = async (options) => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 15));
      running -= 1;
      return create(options);
    };
    const p = provisioner();
    await Promise.all([
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
      p.provision({
        tenantId: OTHER,
        userId: BOB,
        budget: { limitMicros: 1_000_000 },
      }),
    ]);
    expect(admin.keys).toHaveLength(2);
    expect(peak).toBe(1);
  });

  it('reconcile leaves a member who chose their own key alone', async () => {
    const p = provisioner();
    const reconcile = createHostedInferenceReconciler({
      provisioner: p,
      users: async () => [ALICE],
    });
    const entitled = {
      grants: [
        {
          featureKey: 'inference.hosted',
          metadata: { budget: { limitMicros: 2_000_000 } },
        },
      ],
    };
    await reconcile(TENANT, entitled);
    await writeByo(ALICE); // the member saves their own key in settings
    const first = await reconcile(TENANT, entitled);
    expect(first.revoked).toHaveLength(1);
    expect(first.provisioned).toHaveLength(0);
    await reconcile(TENANT, entitled);
    expect(admin.keys).toHaveLength(1);
    expect((await userConfig(ALICE)).apiKey).toBe('sk-byo-alice');
    await expect(
      p.status({ tenantId: TENANT, userId: ALICE }),
    ).resolves.toMatchObject({ status: 'revoked' });

    // An explicit provision opts them back in.
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 2_000_000 },
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('reconcile retries owed deletions for an active grant too', async () => {
    const createOnly = new CreateOnlyAdmin();
    const p = provisioner({ admin: createOnly });
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    await writeByo(ALICE);
    // Explicit re-provision retires the replaced key; the SDK cannot delete it.
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    const owed = await p.status({ tenantId: TENANT, userId: ALICE });
    expect(owed.pendingGatewayRevocations).toHaveLength(1);

    // The SDK gains delete: a reconcile while still entitled finishes it.
    const upgraded = provisioner({ admin });
    admin.live.add('key-id-1');
    const result = await upgraded.reconcileTenant(TENANT, {
      entitled: true,
      budget: { limitMicros: 1_000_000 },
    });
    expect(result.pending).toEqual([]);
    expect(admin.deleted).toContain('key-id-1');
    const after = await p.status({ tenantId: TENANT, userId: ALICE });
    expect(after.status).toBe('active');
    expect(after.pendingGatewayRevocations).toBeUndefined();
  });

  it('refuses to mint a key for a tenant the host reports not entitled', async () => {
    const p = createHostedInferenceProvisioner({
      db,
      secrets,
      gateway: GATEWAY,
      admin,
      nonce: () => 'x',
      entitled: async () => false,
    });
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).rejects.toMatchObject({ code: 'HOSTED_NOT_ENTITLED' });
    expect(admin.keys).toHaveLength(0);
  });

  it('a hung gateway delete never holds a downgrade: local access ends, the key is owed', async () => {
    const p = createHostedInferenceProvisioner({
      db,
      secrets,
      gateway: { ...GATEWAY, adminTimeoutMs: 50 },
      admin,
      nonce: () => 'x',
    });
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    admin.deleteVirtualKey = () => new Promise<boolean>(() => {});
    const revoked = await p.revoke({ tenantId: TENANT, userId: ALICE });
    expect(revoked).toMatchObject({
      gateway: 'failed',
      restored: 'off',
      pendingGatewayRevocations: [
        expect.objectContaining({ keyId: 'key-id-1', reason: 'failed' }),
      ],
    });
    expect(await userConfig(ALICE)).toEqual({ mode: 'off' });
    // The next operation is not blocked behind the hung call.
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: BOB,
        budget: { limitMicros: 1_000_000 },
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it('a timed-out key creation records the alias as owed and leaves no grant', async () => {
    const p = createHostedInferenceProvisioner({
      db,
      secrets,
      gateway: { ...GATEWAY, adminTimeoutMs: 50 },
      admin,
      nonce: () => 'x',
    });
    admin.createVirtualKey = () => new Promise<AIVirtualKey>(() => {});
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    ).rejects.toMatchObject({
      code: 'HOSTED_GATEWAY_FAILED',
      details: expect.objectContaining({
        gatewayCode: 'HOSTED_GATEWAY_TIMEOUT',
      }),
    });
    const after = await p.status({ tenantId: TENANT, userId: ALICE });
    expect(after.status).toBe('revoked');
    expect(after.pendingGatewayRevocations).toEqual([
      expect.objectContaining({
        keyId: null,
        keyAlias: `smrt-${TENANT}-${ALICE}-g0-x`,
        reason: 'orphaned',
      }),
    ]);
    expect(await userConfig(ALICE)).toBeUndefined();
  });

  it('reconcile trusts the current entitlement over a stale entitled target', async () => {
    let entitled = true;
    const p = createHostedInferenceProvisioner({
      db,
      secrets,
      gateway: GATEWAY,
      admin,
      nonce: () => 'x',
      entitled: async () => entitled,
    });
    await p.provision({
      tenantId: TENANT,
      userId: ALICE,
      budget: { limitMicros: 1_000_000 },
    });
    entitled = false; // downgraded since the snapshot was taken
    const result = await p.reconcileTenant(TENANT, {
      entitled: true,
      budget: { limitMicros: 1_000_000 },
      users: [ALICE, BOB],
    });
    expect(result.revoked).toHaveLength(1);
    expect(result.provisioned).toHaveLength(0);
    expect(await p.listActive(TENANT)).toEqual([]);
    expect(admin.keys).toHaveLength(1);
  });

  it('never puts key material in results, audit rows, claims or logs', async () => {
    await writeByo(ALICE);
    const logs = [
      vi.spyOn(console, 'log'),
      vi.spyOn(console, 'info'),
      vi.spyOn(console, 'warn'),
      vi.spyOn(console, 'error'),
      vi.spyOn(console, 'debug'),
    ];
    const p = provisioner();
    const outputs: unknown[] = [];
    outputs.push(
      await p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1_000_000 },
      }),
    );
    outputs.push(
      await p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 4_000_000 },
      }),
    );
    outputs.push(await p.status({ tenantId: TENANT, userId: ALICE }));
    outputs.push(await p.listActive(TENANT));
    outputs.push(await p.revoke({ tenantId: TENANT, userId: ALICE }));

    const audit = await withTenant({ tenantId: TENANT }, () =>
      secrets.getAuditLogs({}),
    );
    const claims = await db.query('SELECT * FROM _smrt_run_once_claims');
    const state = await read(hostedInferenceStateSecretName(ALICE));
    const haystack = JSON.stringify({
      outputs,
      audit: audit.map((entry) => ({
        name: entry.secretName,
        details: entry.details,
      })),
      claims: claims.rows,
      state,
      logs: logs.flatMap((spy) => spy.mock.calls),
    });
    expect(haystack).not.toContain(KEY_MARK);
    expect(haystack).not.toContain(ADMIN_SECRET);
    expect(haystack).toContain('inference.hosted.provision');
  });

  it('validates ids and budgets before touching the gateway', async () => {
    const p = provisioner();
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: ALICE,
        budget: { limitMicros: 1.5 },
      }),
    ).rejects.toMatchObject({ code: 'HOSTED_INFERENCE_INVALID' });
    await expect(
      p.provision({ tenantId: '', userId: ALICE, budget: { limitMicros: 1 } }),
    ).rejects.toMatchObject({ code: 'HOSTED_INFERENCE_INVALID' });
    await expect(
      p.provision({
        tenantId: TENANT,
        userId: 'a b',
        budget: { limitMicros: 1 },
      }),
    ).rejects.toMatchObject({ code: 'HOSTED_INFERENCE_INVALID' });
    expect(admin.keys).toHaveLength(0);
  });

  it('entitlement listener provisions on gain, syncs on change, revokes on loss', async () => {
    const p = provisioner();
    const listener = createHostedInferenceEntitlementListener({
      provisioner: p,
      users: async () => [ALICE, BOB],
    });
    const grant = (limitMicros: number) => ({
      grants: [
        {
          featureKey: 'inference.hosted',
          metadata: { budget: { limitMicros } },
        },
      ],
    });
    await listener({
      tenantId: TENANT,
      gained: ['inference.hosted'],
      lost: [],
      changed: [],
      after: grant(3_000_000),
    });
    expect(await p.listActive(TENANT)).toEqual([ALICE, BOB].sort());
    expect(admin.keys.map((key) => key.budget)).toEqual([
      toGatewayBudget({ limitMicros: 3_000_000, window: 'month' }),
      toGatewayBudget({ limitMicros: 3_000_000, window: 'month' }),
    ]);

    await listener({
      tenantId: TENANT,
      gained: [],
      lost: [],
      changed: ['inference.hosted'],
      after: grant(6_000_000),
    });
    expect(admin.updates).toHaveLength(2);

    await listener({
      tenantId: TENANT,
      gained: [],
      lost: ['inference.hosted'],
      changed: [],
      after: { grants: [] },
    });
    expect(await p.listActive(TENANT)).toEqual([]);
    expect(admin.deleted).toHaveLength(2);
  });

  it('entitlement listener refuses a grant without a budget', async () => {
    const listener = createHostedInferenceEntitlementListener({
      provisioner: provisioner(),
      users: async () => [ALICE],
    });
    await expect(
      listener({
        tenantId: TENANT,
        gained: ['inference.hosted'],
        lost: [],
        changed: [],
        after: { grants: [{ featureKey: 'inference.hosted' }] },
      }),
    ).rejects.toMatchObject({ code: 'HOSTED_INFERENCE_INVALID' });
    expect(admin.keys).toHaveLength(0);
  });
});

describe('hosted gateway config from the environment', () => {
  it('is off without a provider and names missing fields, never values', () => {
    expect(hostedGatewayConfigFromEnv({})).toBeUndefined();
    let error: unknown;
    try {
      hostedGatewayConfigFromEnv({
        SMRT_INFERENCE_HOSTED_PROVIDER: 'litellm',
        SMRT_INFERENCE_HOSTED_BASE_URL: 'https://user:pw@gw.example.test/v1',
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(HostedInferenceError);
    expect((error as HostedInferenceError).code).toBe(
      'HOSTED_GATEWAY_NOT_CONFIGURED',
    );
    expect(String((error as Error).message)).toContain('adminApiKey');
    expect(String((error as Error).message)).not.toContain('pw@');
  });

  it('reads provider, endpoints, credentials and tier models', () => {
    const config = hostedGatewayConfigFromEnv({
      SMRT_INFERENCE_HOSTED_PROVIDER: 'Bifrost',
      SMRT_INFERENCE_HOSTED_BASE_URL: 'https://gw.example.test/v1',
      SMRT_INFERENCE_HOSTED_ADMIN_URL: 'https://gw.example.test',
      SMRT_INFERENCE_HOSTED_ADMIN_USER: 'admin',
      SMRT_INFERENCE_HOSTED_ADMIN_PASSWORD: 'pw',
      SMRT_INFERENCE_HOSTED_MODEL: 'openai/gpt-good',
      SMRT_INFERENCE_HOSTED_GREAT_MODEL: 'anthropic/claude-great',
      SMRT_INFERENCE_HOSTED_MODELS: 'openai/gpt-good, anthropic/claude-great',
      SMRT_INFERENCE_HOSTED_ADMIN_TIMEOUT_MS: '5000',
    });
    expect(config).toEqual({
      provider: 'bifrost',
      baseUrl: 'https://gw.example.test/v1',
      adminUrl: 'https://gw.example.test',
      adminUser: 'admin',
      adminPassword: 'pw',
      model: 'openai/gpt-good',
      tiers: { great: 'anthropic/claude-great' },
      models: ['openai/gpt-good', 'anthropic/claude-great'],
      adminTimeoutMs: 5000,
    });
    expect(INFERENCE_TIERS).toContain('great');
  });
});
