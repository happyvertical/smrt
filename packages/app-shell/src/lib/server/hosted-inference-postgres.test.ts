// The hosted gate's own SQL on PostgreSQL (#5194): plan and subscription reads
// under the required tenancy interceptor, the kill switch's override rows and
// the spend reader's JSON tag matching on `_smrt_ai_usage`. Part of the
// registered `test:postgres` suite: always on an in-process PGlite, and on the
// real server too when `SMRT_TEST_POSTGRES_URL` is set (CI's "Registered
// PostgreSQL Suites" lane).
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AiUsagePersistenceHandler,
  getInferenceGate,
  ObjectRegistry,
  setAiUsageUserResolver,
  setInferenceGate,
} from '@happyvertical/smrt-core';
import { createSchemaManager } from '@happyvertical/smrt-core/schema';
import {
  FEATURE_INFERENCE_HOSTED,
  KillSwitchService,
} from '@happyvertical/smrt-features';
import {
  AI_HOSTED_SPEND_METRIC,
  SubscriptionPlanCollection,
  TenantSubscriptionCollection,
} from '@happyvertical/smrt-subscriptions';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { getDatabase } from '@happyvertical/sql';
import { importPGlite } from '@happyvertical/sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureShell, resetShell } from './host.ts';
import {
  assertHostedInferenceEntitled,
  installHostedInferenceGate,
  resetHostedInference,
} from './hosted-inference.ts';
import { hostedOnlyTables } from './schema.ts';

const serverUrl = process.env.SMRT_TEST_POSTGRES_URL;
const backends = ['pglite', ...(serverUrl ? ['postgres'] : [])] as const;

type Db = Awaited<ReturnType<typeof getDatabase>>;

describe.each(backends)('hosted inference gate (%s)', (backend) => {
  let db: Db;
  let close: () => Promise<void>;
  const dir = mkdtempSync(join(tmpdir(), 'hosted-pg-'));
  const free = randomUUID();
  const pro = randomUUID();
  const capped = randomUUID();

  const request = (tenantId: string) => ({
    tierRequested: 'good' as const,
    tier: 'good' as const,
    target: { provider: 'openai', source: 'hosted' as const },
    tenantId,
    userId: null,
  });

  async function subscribe(tenantId: string, planId: string) {
    await withTenant({ tenantId }, async () => {
      const subs = await TenantSubscriptionCollection.create({ db });
      const sub = await subs.create({ tenantId, planId, status: 'active' });
      await sub.save();
    });
  }

  async function plan(key: string, capMicros?: number) {
    const plans = await SubscriptionPlanCollection.create({ db });
    const row = await plans.create({ planKey: key, name: key, tenantId: null });
    row.setFeatureGrants([FEATURE_INFERENCE_HOSTED]);
    if (capMicros !== undefined)
      row.setThresholds([
        {
          metricKey: AI_HOSTED_SPEND_METRIC,
          limit: capMicros,
          window: 'month',
          enforcement: 'block',
        },
      ]);
    await row.save();
    return String(row.id);
  }

  beforeAll(async () => {
    if (backend === 'postgres') {
      db = await getDatabase({
        type: 'postgres',
        url: serverUrl,
        max: 2,
        cache: false,
      } as never);
      close = async () => undefined;
    } else {
      const { PGlite } = await importPGlite();
      const client = await PGlite.create();
      db = await getDatabase({ type: 'pglite', client } as never);
      close = async () => {
        await client.close();
      };
    }
    // The deployed database is migrated by `smrt db:migrate`; the equivalent
    // here is the schema manager over the tables this gate reads.
    const schemas = Object.values(ObjectRegistry.getAllSchemasAsDefinitions());
    const wanted = hostedOnlyTables();
    for (const schema of schemas)
      if (wanted.has(schema.tableName) || schema.tableName === '_smrt_ai_usage')
        await createSchemaManager(db).ensureTable(schema);
    enableTenancy();
    configureShell({
      profile: async () => 'cloud' as const,
      db: async () => db,
      dataRoot: async () => dir,
      secretMasterKey: async () => 'ef'.repeat(32),
    });
  });
  afterAll(async () => {
    setInferenceGate(undefined);
    setAiUsageUserResolver(undefined);
    resetHostedInference();
    await resetShell();
    disableTenancy();
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('blocks a tenant with no plan, allows an entitled one with no ambient tenant, blocks one over its cap', async () => {
    const gate = await installHostedInferenceGate({ db: async () => db });
    expect(getInferenceGate()).toBe(gate);
    await subscribe(pro, await plan(`pro-${pro}`, 50_000_000));
    await subscribe(capped, await plan(`capped-${capped}`, 1_000_000));
    await new AiUsagePersistenceHandler(db).handle({
      provider: 'openai',
      model: 'm',
      operation: 'chat',
      usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      duration: 1,
      timestamp: new Date(),
      tags: { source: 'hosted' },
      className: 'AppShellAssistant',
      tenantId: capped,
      estimatedCost: 2,
    });
    await expect(gate?.check(request(free))).resolves.toMatchObject({
      action: 'block',
      details: { policy: 'subscription' },
    });
    await expect(gate?.check(request(pro))).resolves.toEqual({
      action: 'allow',
    });
    await expect(gate?.check(request(capped))).resolves.toMatchObject({
      action: 'block',
      details: { policy: 'tenant-cap', cap: 1_000_000, spend: 2_000_000 },
    });
    await expect(assertHostedInferenceEntitled(pro)).resolves.toBeUndefined();
    await expect(assertHostedInferenceEntitled(free)).rejects.toMatchObject({
      entitlement: { policy: 'subscription' },
    });
  });

  it('the global kill switch pauses every tenant', async () => {
    const gate = await installHostedInferenceGate({ db: async () => db });
    const switches = new KillSwitchService({ db });
    await switches.set('inference.hosted.enabled', { enabled: false });
    await expect(gate?.check(request(pro))).resolves.toMatchObject({
      action: 'block',
      details: { policy: 'kill-switch', disabledBy: 'global' },
    });
    await switches.set('inference.hosted.enabled', { enabled: true });
    await expect(gate?.check(request(pro))).resolves.toEqual({
      action: 'allow',
    });
  });
});
