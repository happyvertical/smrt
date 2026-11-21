// Hosted key provisioning and the entitlement listener in the cloud profile
// (#5194), on SQLite with the real stores: smrt-subscriptions' plans and
// `trackEntitlementChange`, smrt-users' memberships, smrt-secrets, the real
// provisioner and the shell's own gate. Only the gateway admin client is a
// fake (no network). NOT exercised: PostgreSQL (the per-tenant advisory lock
// and its pool of at least three connections).
import type {
  AIAdminProject,
  AIVirtualKey,
  CreateAIProjectOptions,
  CreateAIVirtualKeyOptions,
} from '@happyvertical/ai';
import {
  setAiUsageUserResolver,
  setInferenceGate,
} from '@happyvertical/smrt-core';
import {
  type HostedGatewayAdmin,
  resetHostedGatewayConfig,
} from '@happyvertical/smrt-inference/node';
import { inferenceProviderConfigSecretName } from '@happyvertical/smrt-inference/resolver';
import { SecretService } from '@happyvertical/smrt-secrets';
import {
  getEntitlementChangeListeners,
  SubscriptionPlanCollection,
  SubscriptionResolver,
  TenantSubscriptionCollection,
  trackEntitlementChange,
} from '@happyvertical/smrt-subscriptions';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  CLOUD_MASTER_KEY,
  type CloudHarness,
  openCloudShell,
} from './cloud-test-support.ts';
import { configureShell } from './host.ts';
import {
  installHostedInferenceGate,
  resetHostedInference,
} from './hosted-inference.ts';
import {
  installHostedProvisioning,
  resetHostedProvisioning,
} from './hosted-provisioning.ts';

const GATEWAY_ENV = {
  SMRT_INFERENCE_HOSTED_PROVIDER: 'litellm',
  SMRT_INFERENCE_HOSTED_BASE_URL: 'https://gateway.example.test/v1',
  SMRT_INFERENCE_HOSTED_ADMIN_URL: 'https://admin.example.test',
  SMRT_INFERENCE_HOSTED_ADMIN_KEY: 'admin-key',
};

class FakeAdmin implements HostedGatewayAdmin {
  keys: CreateAIVirtualKeyOptions[] = [];
  deleted: string[] = [];
  private projects: AIAdminProject[] = [];

  async createProject(o: CreateAIProjectOptions): Promise<AIAdminProject> {
    const project: AIAdminProject = {
      id: o.id ?? 'p',
      name: o.name,
      ...(o.tenantId ? { tenantId: o.tenantId } : {}),
      provider: 'litellm',
    };
    this.projects.push(project);
    return project;
  }
  async listProjects(filter: { tenantId?: string } = {}) {
    return this.projects.filter(
      (p) => filter.tenantId === undefined || p.tenantId === filter.tenantId,
    );
  }
  async createVirtualKey(o: CreateAIVirtualKeyOptions): Promise<AIVirtualKey> {
    this.keys.push(o);
    return {
      id: `key-${this.keys.length}`,
      name: o.name,
      key: `sk-hosted-virtual-key-${this.keys.length}`,
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
}

let h: CloudHarness;

function useProfile(profile: 'local' | 'cloud') {
  configureShell({
    profile: async () => profile,
    db: async () => h.db,
    dataRoot: async () => h.dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
  });
}

/** Grant (or take away) the plan that carries `inference.hosted`. */
async function setPlan(tenantId: string, limitMicros: number | null) {
  const resolver = await SubscriptionResolver.create({ db: h.db });
  // The billing writer's webhook runs in the tenant it changes.
  return withTenant({ tenantId }, () =>
    trackEntitlementChange({ tenantId, resolver }, async () => {
      await withTenant({ tenantId }, async () => {
        const subs = await TenantSubscriptionCollection.create({ db: h.db });
        for (const sub of await subs.list({ limit: 50 })) {
          sub.status = 'canceled';
          await sub.save();
        }
        if (limitMicros === null) return;
        const plans = await SubscriptionPlanCollection.create({ db: h.db });
        const plan = await plans.create({
          planKey: `hosted-${limitMicros}`,
          name: 'Plan',
          tenantId: null,
        });
        plan.setFeatureGrants([
          {
            featureKey: 'inference.hosted',
            metadata: { budget: { limitMicros } },
          },
        ]);
        await plan.save();
        const sub = await subs.create({
          tenantId,
          planId: String(plan.id),
          status: 'active',
        });
        await sub.save();
      });
    }),
  );
}

const storedConfig = (tenantId: string, userId: string) =>
  withTenant({ tenantId }, async () => {
    const secrets = await SecretService.create({ db: h.db });
    return secrets.retrieve(inferenceProviderConfigSecretName({ userId })).then(
      (s) => JSON.parse(s.value) as { source?: string; mode?: string },
      () => undefined,
    );
  });

beforeAll(async () => {
  // The deployment's master key is the environment's (SecretService reads it).
  vi.stubEnv('SMRT_SECRET_MASTER_KEY', CLOUD_MASTER_KEY);
  resetHostedGatewayConfig();
  h = await openCloudShell();
});
afterAll(async () => {
  await h.close();
  vi.unstubAllEnvs();
  resetHostedGatewayConfig();
});
beforeEach(() => resetHostedInference());
afterEach(() => {
  resetHostedProvisioning();
  setInferenceGate(undefined);
  setAiUsageUserResolver(undefined);
  resetHostedInference();
  useProfile('cloud');
});

const install = async (
  admin: FakeAdmin,
  env: Record<string, string> = GATEWAY_ENV,
) => {
  await installHostedInferenceGate({ db: async () => h.db });
  return installHostedProvisioning({ db: async () => h.db, admin, env });
};

describe('hosted provisioning', () => {
  it('a plan that gains inference.hosted gives the tenant members a hosted key; losing it revokes it', async () => {
    const admin = new FakeAdmin();
    expect(await install(admin)).toBe(true);
    const gained = await setPlan(h.a.tenantId, 5_000_000);
    expect(gained.failures).toEqual([]);
    expect(admin.keys).toHaveLength(1);
    expect(await storedConfig(h.a.tenantId, h.a.id)).toMatchObject({
      source: 'hosted',
    });
    // The other tenant is untouched.
    expect(await storedConfig(h.b.tenantId, h.b.id)).toBeUndefined();

    const lost = await setPlan(h.a.tenantId, null);
    expect(lost.failures).toEqual([]);
    expect(admin.deleted).toEqual(['key-1']);
    expect(await storedConfig(h.a.tenantId, h.a.id)).toMatchObject({
      mode: 'off',
    });
  });

  it('does nothing without a configured gateway', async () => {
    const admin = new FakeAdmin();
    expect(await install(admin, {})).toBe(false);
    expect(getEntitlementChangeListeners()).toEqual([]);
  });

  it('does nothing on the local profile (the desktop)', async () => {
    useProfile('local');
    const db = vi.fn();
    expect(
      await installHostedProvisioning({
        db,
        admin: new FakeAdmin(),
        env: GATEWAY_ENV,
      }),
    ).toBe(false);
    expect(db).not.toHaveBeenCalled();
    expect(getEntitlementChangeListeners()).toEqual([]);
  });

  it('refuses an incomplete gateway configuration, so the server does not start', async () => {
    await expect(
      install(new FakeAdmin(), {
        SMRT_INFERENCE_HOSTED_PROVIDER: 'litellm',
      }),
    ).rejects.toThrow();
  });

  it('registers one listener however often it is installed', async () => {
    await install(new FakeAdmin());
    await install(new FakeAdmin());
    expect(getEntitlementChangeListeners()).toHaveLength(1);
  });
});
