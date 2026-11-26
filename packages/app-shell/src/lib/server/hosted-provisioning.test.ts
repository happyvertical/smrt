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
  subscribeToChangeSignals,
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
  MembershipCollection,
  MembershipStatus,
} from '@happyvertical/smrt-users';
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
  reconcileAllHostedTenants,
  reconcileHostedTenant,
  resetHostedProvisioning,
} from './hosted-provisioning.ts';

// A pass-through spy: the watcher really subscribes, and a test can see whether it did.
vi.mock('@happyvertical/smrt-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@happyvertical/smrt-core')>();
  return {
    ...actual,
    subscribeToChangeSignals: vi.fn(actual.subscribeToChangeSignals),
  };
});

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
    ).rejects.toMatchObject({ code: 'HOSTED_GATEWAY_NOT_CONFIGURED' });
  });

  it('refuses gateway variables set without a provider instead of ignoring them', async () => {
    await expect(
      install(new FakeAdmin(), {
        SMRT_INFERENCE_HOSTED_BASE_URL:
          GATEWAY_ENV.SMRT_INFERENCE_HOSTED_BASE_URL,
      }),
    ).rejects.toMatchObject({ code: 'HOSTED_GATEWAY_NOT_CONFIGURED' });
  });

  it('refuses to start without the secrets master key', async () => {
    vi.stubEnv('SMRT_SECRET_MASTER_KEY', '');
    await expect(install(new FakeAdmin())).rejects.toMatchObject({
      code: 'HOSTED_GATEWAY_NOT_CONFIGURED',
    });
    vi.stubEnv('SMRT_SECRET_MASTER_KEY', CLOUD_MASTER_KEY);
  });

  it('registers one listener however often it is installed', async () => {
    await install(new FakeAdmin());
    await install(new FakeAdmin());
    expect(getEntitlementChangeListeners()).toHaveLength(1);
  });
});

/** Add `userId` to the tenant with the same role the owner there holds. */
async function addMember(tenantId: string, ownerId: string, userId: string) {
  const memberships = await MembershipCollection.create({ db: h.db });
  const [owner] = await memberships.list({
    where: { tenantId, userId: ownerId },
    limit: 1,
  });
  const member = await memberships.create({
    tenantId,
    userId,
    roleId: String(owner.roleId),
    status: MembershipStatus.ACTIVE,
  });
  await member.save();
  return member;
}

const keyCount = (admin: FakeAdmin) => admin.keys.length;

describe('members joining and leaving an entitled tenant', () => {
  it('provisions a member who joins after the plan, and revokes one who is removed', async () => {
    const admin = new FakeAdmin();
    await install(admin);
    await setPlan(h.a.tenantId, 5_000_000);
    expect(keyCount(admin)).toBe(1);

    const carol = await h.newUser('carol@example.test');
    const membership = await addMember(h.a.tenantId, h.a.id, carol.id);
    await vi.waitFor(() => expect(keyCount(admin)).toBe(2));
    expect(await storedConfig(h.a.tenantId, carol.id)).toMatchObject({
      source: 'hosted',
    });

    // Deactivating the membership takes the key back.
    membership.status = MembershipStatus.INACTIVE;
    await membership.save();
    await vi.waitFor(() => expect(admin.deleted).toEqual(['key-2']));
    expect(await storedConfig(h.a.tenantId, carol.id)).toMatchObject({
      mode: 'off',
    });
    // The owner keeps theirs.
    expect(await storedConfig(h.a.tenantId, h.a.id)).toMatchObject({
      source: 'hosted',
    });
  });

  it('revokes a member whose membership row is deleted', async () => {
    const admin = new FakeAdmin();
    await install(admin);
    await setPlan(h.b.tenantId, 5_000_000);
    const dave = await h.newUser('dave@example.test');
    const membership = await addMember(h.b.tenantId, h.b.id, dave.id);
    await vi.waitFor(() => expect(keyCount(admin)).toBe(2));
    await membership.delete();
    await vi.waitFor(() => expect(admin.deleted).toHaveLength(1));
    expect(await storedConfig(h.b.tenantId, dave.id)).toMatchObject({
      mode: 'off',
    });
  });

  it('gives a joiner nothing while the tenant has no plan', async () => {
    const admin = new FakeAdmin();
    await install(admin);
    // Earlier tests left this tenant a plan: take it away first.
    await setPlan(h.a.tenantId, null);
    const erin = await h.newUser('erin@example.test');
    await addMember(h.a.tenantId, h.a.id, erin.id);
    // Let the member watcher run; nothing is entitled, so nothing is minted.
    await reconcileHostedTenant(h.a.tenantId);
    expect(keyCount(admin)).toBe(0);
    expect(await storedConfig(h.a.tenantId, erin.id)).toBeUndefined();
  });
});

describe('scheduled repair reconcile', () => {
  it('repairs every entitled tenant, and a second pass changes nothing', async () => {
    const admin = new FakeAdmin();
    // The timer is off: the repair is called directly, as the timer would.
    await installHostedInferenceGate({ db: async () => h.db });
    await installHostedProvisioning({
      db: async () => h.db,
      admin,
      env: GATEWAY_ENV,
      reconcileIntervalMs: 0,
    });
    await setPlan(h.a.tenantId, 5_000_000);
    await setPlan(h.b.tenantId, 5_000_000);
    const before = keyCount(admin);

    // A lost reaction: the member joins while nothing is watching, so no
    // signal reaches the watcher and only the repair pass can find them.
    resetHostedProvisioning();
    const fay = await h.newUser('fay@example.test');
    await addMember(h.a.tenantId, h.a.id, fay.id);
    await installHostedProvisioning({
      db: async () => h.db,
      admin,
      env: GATEWAY_ENV,
      reconcileIntervalMs: 0,
    });
    expect(await storedConfig(h.a.tenantId, fay.id)).toBeUndefined();
    const first = await reconcileAllHostedTenants();
    expect(first?.failures).toEqual([]);
    expect(first?.provisioned).toBeGreaterThanOrEqual(1);
    expect(first?.failures).toEqual([]);
    expect(await storedConfig(h.a.tenantId, fay.id)).toMatchObject({
      source: 'hosted',
    });

    const keys = keyCount(admin);
    const deleted = admin.deleted.length;
    expect(keys).toBeGreaterThanOrEqual(before);
    const second = await reconcileAllHostedTenants();
    expect(second).toMatchObject({
      provisioned: 0,
      revoked: 0,
      removed: 0,
      failures: [],
    });
    expect(keyCount(admin)).toBe(keys);
    expect(admin.deleted).toHaveLength(deleted);
  });

  it('revokes keys of a tenant that lost its plan without the listener firing', async () => {
    const admin = new FakeAdmin();
    await installHostedInferenceGate({ db: async () => h.db });
    await installHostedProvisioning({
      db: async () => h.db,
      admin,
      env: GATEWAY_ENV,
      reconcileIntervalMs: 0,
    });
    await setPlan(h.a.tenantId, 5_000_000);
    // Cancel the subscription directly, bypassing trackEntitlementChange.
    await withTenant({ tenantId: h.a.tenantId }, async () => {
      const subs = await TenantSubscriptionCollection.create({ db: h.db });
      for (const sub of await subs.list({ limit: 50 })) {
        sub.status = 'canceled';
        await sub.save();
      }
    });
    const pass = await reconcileAllHostedTenants();
    expect(pass?.revoked).toBeGreaterThanOrEqual(1);
    expect(await storedConfig(h.a.tenantId, h.a.id)).toMatchObject({
      mode: 'off',
    });
  });

  it('makes no call and no query without a gateway or off the cloud', async () => {
    const admin = new FakeAdmin();
    await installHostedInferenceGate({ db: async () => h.db });
    vi.mocked(subscribeToChangeSignals).mockClear();
    expect(
      await installHostedProvisioning({
        db: async () => h.db,
        admin,
        env: {},
      }),
    ).toBe(false);
    expect(await reconcileAllHostedTenants()).toBeUndefined();
    expect(await reconcileHostedTenant(h.a.tenantId)).toBeUndefined();
    // No change-signal subscription was added for the repair or the members.
    expect(subscribeToChangeSignals).not.toHaveBeenCalled();
    useProfile('local');
    expect(
      await installHostedProvisioning({
        db: async () => h.db,
        admin,
        env: GATEWAY_ENV,
      }),
    ).toBe(false);
    expect(await reconcileAllHostedTenants()).toBeUndefined();
    expect(subscribeToChangeSignals).not.toHaveBeenCalled();
    expect(keyCount(admin)).toBe(0);
  });

  it('the armed timer runs the repair, and stopping it runs nothing', async () => {
    const admin = new FakeAdmin();
    await installHostedInferenceGate({ db: async () => h.db });
    const installTimer = () =>
      installHostedProvisioning({
        db: async () => h.db,
        admin,
        env: GATEWAY_ENV,
        reconcileIntervalMs: 50,
      });
    await installTimer();
    await setPlan(h.b.tenantId, 5_000_000);
    // Joins while nothing watches, so only the timer's pass can repair it.
    resetHostedProvisioning();
    const gus = await h.newUser('gus@example.test');
    await addMember(h.b.tenantId, h.b.id, gus.id);
    await installTimer();
    // The timer is real here and short: it must fire without any signal.
    await vi.waitFor(
      async () =>
        expect(await storedConfig(h.b.tenantId, gus.id)).toMatchObject({
          source: 'hosted',
        }),
      { timeout: 5000 },
    );
    // Stopped: a later joiner is not repaired by the timer.
    resetHostedProvisioning();
    // A pass already running finishes its tenant, then stops.
    await new Promise((r) => setTimeout(r, 150));
    const hal = await h.newUser('hal@example.test');
    await addMember(h.b.tenantId, h.b.id, hal.id);
    await new Promise((r) => setTimeout(r, 200));
    expect(await storedConfig(h.b.tenantId, hal.id)).toBeUndefined();
  });
});
