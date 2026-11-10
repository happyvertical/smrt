import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import { describe, expect, it, vi } from 'vitest';
import {
  FEATURE_INFERENCE_HOSTED,
  FeatureResolver,
} from '../../../features/src/index.js';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import {
  isMissingSubscriptionTableError,
  SubscriptionFeatureSource,
} from '../services/subscription-feature-source.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';

const { getDatabase } =
  await vi.importActual<typeof import('@happyvertical/sql')>(
    '@happyvertical/sql',
  );

async function withDatabase(
  name: string,
  run: (db: Awaited<ReturnType<typeof getDatabase>>) => Promise<void>,
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

describe('SubscriptionFeatureSource on PostgreSQL (#4761)', () => {
  it.skipIf(!isPostgresAvailable())(
    'reports no grants when the subscription tables do not exist',
    async () => {
      await withDatabase('feature_grants_no_tables_4761', async (db) => {
        await getTestDatabase({
          db,
          classes: ['FeatureDefinition', 'FeatureOverride'],
        });
        const raw = await SubscriptionResolver.create({ db });
        const failure = await raw
          .resolveFeatureGrants({ kind: 'tenant', tenantId: randomUUID() })
          .catch((caught: unknown) => caught);
        expect(isMissingSubscriptionTableError(failure)).toBe(true);

        const source = await SubscriptionFeatureSource.create({ db });
        const tenantId = randomUUID();
        await expect(source.getGrants(tenantId)).resolves.toBeNull();
        const features = new FeatureResolver(
          { db },
          { tenantHierarchyLoader: async () => null },
        );
        await expect(
          features.isEnabled(FEATURE_INFERENCE_HOSTED, {
            tenantId,
            grantSource: source,
          }),
        ).resolves.toBe(false);
      });
    },
  );

  it.skipIf(!isPostgresAvailable())(
    'resolves a persisted plan grant for the subscribed tenant',
    async () => {
      await withDatabase('feature_grants_4761', async (db) => {
        await getTestDatabase({
          db,
          classes: [
            'FeatureDefinition',
            'FeatureOverride',
            'SubscriptionPlan',
            'SubscriptionPlanVersion',
            'TenantSubscription',
            'TenantUsageMetric',
          ],
        });
        const plans = await SubscriptionPlanCollection.create({ db });
        const plan = await plans.create({
          planKey: 'cloud',
          name: 'Cloud',
          tenantId: null,
        });
        plan.setFeatureGrants([FEATURE_INFERENCE_HOSTED]);
        await plan.save();
        const tenantId = randomUUID();
        const subscriptions = await TenantSubscriptionCollection.create({ db });
        const subscription = await subscriptions.create({
          tenantId,
          planId: String(plan.id),
          status: 'active',
        });
        await subscription.save();

        const source = await SubscriptionFeatureSource.create({ db });
        const features = new FeatureResolver(
          { db },
          { tenantHierarchyLoader: async () => null },
        );
        await expect(
          features.isEnabled(FEATURE_INFERENCE_HOSTED, {
            tenantId,
            grantSource: source,
          }),
        ).resolves.toBe(true);
        await expect(
          features.isEnabled(FEATURE_INFERENCE_HOSTED, {
            tenantId: randomUUID(),
            grantSource: source,
          }),
        ).resolves.toBe(false);
        await expect(
          source.findGrantingPlan(FEATURE_INFERENCE_HOSTED, null),
        ).resolves.toMatchObject({ planKey: 'cloud', name: 'Cloud' });
      });
    },
  );
});
