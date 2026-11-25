// Per-user attribution and per-user caps for hosted inference calls made
// outside the assistant (#5194): the calls an MCP tool, a background job or
// engine-side code makes through core's inference seam
// (`resolveInferenceTarget`: binding, hosted gate, usage recorder).
//
// Every MCP tool dispatch (`dispatchTool`) and every import-workflow step
// (`runAs` on the stored owner row) runs inside `runAs(principal)`, which
// enters the verified principal's tenant context; the gate and the usage
// recorder read the user from it. Real stores on SQLite (features,
// subscriptions, spend evaluator), the real hosted gate registered through
// core's seam; the provider is a fake resolver (no network).
//
// NOT exercised: PostgreSQL (the spend reader's tag matching), and the app
// worker: it has no inference binding or hosted gate, so no hosted call runs
// there (engine.md "Hosted inference").
import {
  config,
  type InferenceResolver,
  isInferenceUnavailableError,
  resolveInferenceTarget,
  setAiUsageUserResolver,
  setInferenceGate,
} from '@happyvertical/smrt-core';
import { FEATURE_INFERENCE_HOSTED } from '@happyvertical/smrt-features';
import {
  AI_HOSTED_SPEND_METRIC,
  AI_HOSTED_USER_SPEND_METRIC,
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
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
import { runAs } from './owner.ts';

const GATEWAY = 'https://gateway.example.test/v1';
const MODEL = 'gw-model';

let h: CloudHarness;
let tenantA: string;
let tenantB: string;
let seq = 0;

/** A tenant no earlier test subscribed or spent in. */
async function freshTenant(): Promise<string> {
  const user = await h.newUser(`attr-${seq++}@example.test`);
  const { ownerTenantFor } = await import('./accounts.ts');
  return ownerTenantFor(h.db, { id: user.id, name: `attr${seq}` });
}
let planCount = 0;

const hostedResolver: InferenceResolver = {
  resolve: () => ({
    tierResolved: 'good',
    via: 'resolver',
    mode: 'hosted',
    target: {
      provider: 'openai',
      model: MODEL,
      baseUrl: GATEWAY,
      apiKey: 'sk-hosted-virtual-key-0123456789',
      source: 'hosted',
    },
  }),
};

async function entitle(
  tenantId: string,
  limits: { tenant?: number; user?: number },
) {
  const plans = await SubscriptionPlanCollection.create({ db: h.db });
  const row = await plans.create({
    planKey: `attr-plan-${planCount++}`,
    name: 'Plan',
    tenantId: null,
  });
  row.setFeatureGrants([FEATURE_INFERENCE_HOSTED]);
  row.setThresholds([
    ...(limits.tenant !== undefined
      ? [
          {
            metricKey: AI_HOSTED_SPEND_METRIC,
            limit: limits.tenant,
            window: 'month' as const,
            enforcement: 'block' as const,
          },
        ]
      : []),
    ...(limits.user !== undefined
      ? [
          {
            metricKey: AI_HOSTED_USER_SPEND_METRIC,
            limit: limits.user,
            window: 'month' as const,
            enforcement: 'block' as const,
          },
        ]
      : []),
  ]);
  await row.save();
  await withTenant({ tenantId }, async () => {
    const subs = await TenantSubscriptionCollection.create({ db: h.db });
    const sub = await subs.create({
      tenantId,
      planId: String(row.id),
      status: 'active',
    });
    await sub.save();
  });
}

interface UsageRow {
  tenant_id: string | null;
  operation: string;
  tags: string | null;
  estimated_cost: number | null;
}

async function usageRows(): Promise<UsageRow[]> {
  const result = await h.db.query(
    'SELECT tenant_id, operation, tags, estimated_cost FROM _smrt_ai_usage ORDER BY created_at, id',
  );
  return result.rows as unknown as UsageRow[];
}

const tagsOf = (row: UsageRow): Record<string, string> =>
  row.tags ? (JSON.parse(row.tags) as Record<string, string>) : {};

/**
 * One hosted call the way an MCP tool, a job step or engine code makes it:
 * bind the tier (the gate runs here), then the client reports its usage. The
 * call is for `tenantId` (the billed tenant), whatever the ambient scope.
 */
async function hostedCall(tenantId: string, tokens = 1_000_000) {
  const resolved = await resolveInferenceTarget({
    tier: 'good',
    resolver: hostedResolver,
    className: 'AttributionProbe',
    tenantId,
    usage: { db: h.db, className: 'AttributionProbe', tenantId },
  });
  const onUsage = resolved.options?.onUsage as
    | ((event: unknown) => Promise<void>)
    | undefined;
  await onUsage?.({
    provider: 'openai',
    model: MODEL,
    operation: 'chat',
    usage: { promptTokens: tokens, completionTokens: 0, totalTokens: tokens },
    duration: 1,
  });
}

const as = (id: string, tenantId = tenantA) => ({ id, tenantId });

beforeAll(async () => {
  h = await openCloudShell();
  configureShell({
    profile: async () => 'cloud' as const,
    db: async () => h.db,
    dataRoot: async () => h.dir,
    secretMasterKey: async () => CLOUD_MASTER_KEY,
  });
});
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  tenantA = await freshTenant();
  tenantB = await freshTenant();
  resetHostedInference();
  config.reset();
  // $0.001 per 1K tokens, so $1 per 1M: one `hostedCall` spends 1_000_000 micros.
  config({
    usage: {
      costRates: { [`openai:${MODEL}`]: { input: 0.001, output: 0.001 } },
    },
  } as never);
});
afterEach(async () => {
  setInferenceGate(undefined);
  setAiUsageUserResolver(undefined);
  resetHostedInference();
  config.reset();
  await h.db.query('DELETE FROM _smrt_ai_usage');
});

const install = () => installHostedInferenceGate({ db: async () => h.db });

describe('per-user attribution (MCP tools, jobs, engine-side calls)', () => {
  it('meters a call by user A to A and to the tenant', async () => {
    await install();
    await entitle(tenantA, { tenant: 50_000_000, user: 5_000_000 });
    await runAs(as('user-a'), () => hostedCall(tenantA));
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(tenantA);
    expect(tagsOf(rows[0] as UsageRow)).toMatchObject({
      userId: 'user-a',
      source: 'hosted',
    });
  });

  it('blocks A over their cap while user B of the same tenant still works', async () => {
    await install();
    await entitle(tenantA, { tenant: 50_000_000, user: 1_500_000 });
    // A spends 2 calls (2_000_000 micros) past the 1_500_000 user cap.
    await runAs(as('user-a'), () => hostedCall(tenantA));
    await runAs(as('user-a'), () => hostedCall(tenantA));
    const blocked = await runAs(as('user-a'), () => hostedCall(tenantA)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isInferenceUnavailableError(blocked)).toBe(true);
    expect(blocked).toMatchObject({
      reason: 'entitlement',
      entitlement: { policy: 'user-cap', cap: 1_500_000 },
    });
    // The block wrote an audit row for A, no spend.
    const audit = (await usageRows()).filter((r) => r.operation === 'blocked');
    expect(audit).toHaveLength(1);
    // B has spent nothing: the same call goes through, metered to B.
    await runAs(as('user-b'), () => hostedCall(tenantA));
    const last = (await usageRows()).at(-1) as UsageRow;
    expect(tagsOf(last)).toMatchObject({ userId: 'user-b' });
  });

  it('meters a tenant-only call (a scheduled job) to the tenant, with no user', async () => {
    await install();
    await entitle(tenantA, { tenant: 50_000_000, user: 1_000 });
    // No ambient principal at all: the call names its tenant only. The tiny
    // per-user cap does not apply because there is no user.
    await hostedCall(tenantA);
    await hostedCall(tenantA);
    const rows = await usageRows();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.tenant_id).toBe(tenantA);
      expect(tagsOf(row).userId).toBeUndefined();
    }
  });

  it('never meters a user against a tenant they do not act in', async () => {
    await install();
    await entitle(tenantB, { tenant: 50_000_000, user: 5_000_000 });
    // A principal of tenant A is the ambient scope; the call bills tenant B
    // (a shared client or a job of B): the row carries no user of A.
    await runAs(as('user-a', tenantA), () => hostedCall(tenantB));
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tenant_id).toBe(tenantB);
    expect(tagsOf(rows[0] as UsageRow).userId).toBeUndefined();
  });
});

describe('no gate registered in cloud', () => {
  it('refuses a hosted call with no gate, as no spend', async () => {
    // Cloud startup opted in; the gate is then missing (never built, or
    // cleared). Core's default would run the call unchecked.
    await install();
    setInferenceGate(undefined);
    const error = await runAs(as('user-a'), () => hostedCall(tenantA)).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(isInferenceUnavailableError(error)).toBe(true);
    expect(error).toMatchObject({
      reason: 'entitlement',
      entitlement: { policy: 'gate-error' },
    });
    const rows = await usageRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation).toBe('blocked');
  });

  it('a failed startup leaves the process closed, not open', async () => {
    const failing = installHostedInferenceGate({
      db: async () => h.db,
      deps: {
        killSwitch: {
          read: async () => {
            throw new Error('no such table');
          },
        },
        spend: { evaluate: async () => ({}) as never },
        entitled: async () => false,
      },
    });
    await expect(failing).rejects.toThrow(/no such table/);
    await expect(hostedCall(tenantA)).rejects.toMatchObject({
      entitlement: { policy: 'gate-error' },
    });
  });
});
