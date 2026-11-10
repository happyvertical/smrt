/**
 * Hosted AI spend cap on PostgreSQL (#4760): the `_smrt_ai_usage` spend
 * query (tag `LIKE ... ESCAPE`, timestamp window, REAL cost to integer
 * micro-dollars), plan caps through `resolvePlanThresholds()`, and the
 * kill-switch rows, through the hosted gate.
 */
import { randomUUID } from 'node:crypto';
import {
  AiUsagePersistenceHandler,
  getTestDatabase,
  SmrtClass,
} from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { describe, expect, it, vi } from 'vitest';
import { KillSwitchService } from '../../../features/src/index.js';
import {
  createHostedInferenceGate,
  setHostedInferenceEnabled,
} from '../../../inference/src/gate.js';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import {
  AI_HOSTED_SPEND_METRIC,
  AI_HOSTED_USER_SPEND_METRIC,
  createHostedAiSpendReader,
  HostedAiSpendEvaluator,
} from '../services/hosted-ai-spend.js';

const { getDatabase } =
  await vi.importActual<typeof import('@happyvertical/sql')>(
    '@happyvertical/sql',
  );

type Db = Awaited<ReturnType<typeof getDatabase>>;

async function withDatabase(
  name: string,
  run: (db: Db) => Promise<void>,
): Promise<void> {
  const baseUrl = process.env.DATABASE_URL;
  if (!baseUrl) throw new Error('DATABASE_URL required');
  const admin = await getDatabase({ type: 'postgres', url: baseUrl });
  const databaseName = `${name}_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE "${databaseName}"`);
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  const db = await getDatabase({ type: 'postgres', url: url.toString() });
  try {
    await run(db);
  } finally {
    await db.close?.();
    await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
    await admin.close?.();
  }
}

describe('hosted AI spend gate on PostgreSQL (#4760)', () => {
  it.skipIf(!isPostgresAvailable())(
    'meters hosted spend, enforces the per-user cap and the kill switch',
    async () => {
      await withDatabase('hosted_spend_4760', async (db) => {
        const host = new SmrtClass({ db });
        await (host as unknown as { initialize(): Promise<void> }).initialize();
        await getTestDatabase({
          db,
          classes: [
            'FeatureOverride',
            'SubscriptionPlan',
            'SubscriptionPlanVersion',
            'TenantSubscription',
          ],
        });
        const tenantId = randomUUID();
        const userId = randomUUID();
        const handler = new AiUsagePersistenceHandler(db);
        const row = (cost: number, tags: Record<string, string>, op = 'chat') =>
          handler.handle({
            provider: 'openai',
            model: 'hosted-model',
            operation: op,
            usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
            duration: 1,
            timestamp: new Date(),
            tags,
            className: 'Doc',
            tenantId,
            estimatedCost: cost,
          });
        await row(0.75, { source: 'hosted', userId });
        await row(0.5, { source: 'hosted', userId: `${userId}0` });
        await row(4, { source: 'byo', userId });
        await row(4, { source: 'hosted', userId }, 'blocked');
        await row(0.001, { source: 'hosted', userId: 'u_1' });

        const now = new Date();
        const window = {
          start: new Date(now.getTime() - 3_600_000),
          end: new Date(now.getTime() + 3_600_000),
        };
        const reader = createHostedAiSpendReader(db);
        await expect(
          reader.summarize({ tenantId, window }),
        ).resolves.toMatchObject({ spend: 1_251_000 });
        await expect(
          reader.summarize({ tenantId, userId, window }),
        ).resolves.toMatchObject({ spend: 750_000 });
        await expect(
          reader.summarize({ tenantId, userId: 'u%1', window }),
        ).resolves.toMatchObject({ spend: 0 });
        // The rolling lift runs as one window-function query on PostgreSQL.
        await expect(
          reader.liftsAt?.({
            tenantId,
            userId,
            window,
            cap: 700_000,
            windowMs: 1_000,
          }),
        ).resolves.toBeInstanceOf(Date);

        const plans = await SubscriptionPlanCollection.create({ db });
        const plan = await plans.create({
          planKey: 'pro',
          name: 'Pro',
          tenantId: null,
        });
        plan.setThresholds([
          {
            metricKey: AI_HOSTED_SPEND_METRIC,
            limit: 50_000_000,
            window: 'month',
            enforcement: 'block',
          },
          {
            metricKey: AI_HOSTED_USER_SPEND_METRIC,
            limit: 700_000,
            window: 'day',
            enforcement: 'block',
          },
        ]);
        await plan.save();
        const subscriptions = await TenantSubscriptionCollection.create({ db });
        const subscription = await subscriptions.create({
          tenantId,
          planId: String(plan.id),
          status: 'active',
        });
        await subscription.save();

        const switches = new KillSwitchService({ db });
        const gate = createHostedInferenceGate({
          killSwitch: switches,
          spend: await HostedAiSpendEvaluator.create({ db }),
          principal: () => ({ tenantId, userId }),
        });
        const request = {
          tierRequested: 'good' as const,
          tier: 'good' as const,
          target: { provider: 'openai', source: 'hosted' as const },
          tenantId,
        };
        await expect(gate.check(request)).resolves.toMatchObject({
          action: 'block',
          details: { policy: 'user-cap', cap: 700_000, spend: 750_000 },
        });

        await setHostedInferenceEnabled(switches, { enabled: false });
        await expect(gate.check(request)).resolves.toEqual({
          action: 'block',
          details: { policy: 'kill-switch', disabledBy: 'global' },
        });
        await setHostedInferenceEnabled(switches, { enabled: true });
        await expect(gate.check(request)).resolves.toMatchObject({
          details: { policy: 'user-cap' },
        });
        host.destroy();
      });
    },
  );
});
