import { randomUUID } from 'node:crypto';
import {
  generateDDLForEngine,
  getTestDatabase,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import {
  generateSchemaDiff,
  getSQLFromDiff,
} from '@happyvertical/smrt-core/migrations';
import { isPostgresAvailable } from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { dropLegacyPlanKeyIndex } from '../../scripts/plan-key.js';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';

const { getDatabase } =
  await vi.importActual<typeof import('@happyvertical/sql')>(
    '@happyvertical/sql',
  );

async function upgrade(db: DatabaseInterface, engine: 'sqlite' | 'postgres') {
  const schema = ObjectRegistry.getSchema(SubscriptionPlan.name);
  if (!schema) throw new Error('missing plan schema');
  // Reconstruct the prior plan table: global key and no #3829 columns.
  await db.query('DROP TABLE IF EXISTS "_smrt_subscription_plans"');
  const legacy = structuredClone(schema);
  for (const key of [
    'pricing_mode',
    'minimum_amount',
    'suggested_amount',
    'provider_price_id',
    'provider_product_id',
  ])
    delete legacy.columns[key];
  const ddl = generateDDLForEngine(legacy, engine);
  await db.query(ddl.createTable);
  await db.query(
    'CREATE UNIQUE INDEX "_smrt_subscription_plans_plan_key_idx" ON "_smrt_subscription_plans" ("plan_key")',
  );
  const id = '11111111-1111-4111-8111-111111111111';
  const tenant = '22222222-2222-4222-8222-222222222222';
  await db.query(
    `INSERT INTO "_smrt_subscription_plans" (id, slug, context, tenant_id, plan_key, name) VALUES ('${id}', 'membership', '', '${tenant}', 'membership', 'Existing co-op')`,
  );
  const schemas = await ObjectRegistry.getAllSchemasAsDefinitions();
  const selected = Object.fromEntries(
    Object.entries(schemas).filter(
      ([, value]) => value.tableName === '_smrt_subscription_plans',
    ),
  );
  expect(Object.keys(selected)).toHaveLength(1);
  const diff = await generateSchemaDiff(db, selected, { engineHint: engine });
  expect(getSQLFromDiff(diff).join(' ')).toContain('pricing_mode');
  for (const sql of getSQLFromDiff(diff)) await db.query(sql);
  await dropLegacyPlanKeyIndex(db);
  await dropLegacyPlanKeyIndex(db);
  const plans = await SubscriptionPlanCollection.create({ db });
  const original = await plans.get(id);
  expect(original?.name).toBe('Existing co-op');
  expect(original?.pricingMode).toBe('fixed');
  await plans.create({
    tenantId: '33333333-3333-4333-8333-333333333333',
    planKey: 'membership',
    name: 'Other co-op',
  });
  await plans.create({
    tenantId: tenant,
    planKey: 'membership',
    name: 'Updated original',
  });
  expect(await plans.list({ where: { planKey: 'membership' } })).toHaveLength(
    2,
  );
  expect((await plans.get(id))?.name).toBe('Updated original');
  await plans.create({ planKey: 'global', name: 'Global' });
  await plans.create({ planKey: 'global', name: 'Updated global' });
  expect(
    await plans.list({ where: { tenantId: null, planKey: 'global' } }),
  ).toHaveLength(1);
  await getTestDatabase({ db, classes: ['TenantSubscription'] });
  const subscriptions = await TenantSubscriptionCollection.create({ db });
  const selectedPlan = await plans.create({
    tenantId: tenant,
    planKey: 'worker',
    name: 'Worker membership',
    pricingMode: 'pay_what_you_can',
    minimumAmount: 500,
    features: JSON.stringify(['worker:vote']),
  });
  await plans.create({
    tenantId: '33333333-3333-4333-8333-333333333333',
    planKey: 'worker',
    name: 'Different co-op',
    features: JSON.stringify(['other:admin']),
  });
  await expect(
    subscriptions.create({
      tenantId: tenant,
      subscriberKind: 'external',
      subscriberExternalId: 'member:alex',
      planId: String(selectedPlan.id),
      agreedAmount: 499,
    }),
  ).rejects.toThrow();
  const member = await subscriptions.create({
    tenantId: tenant,
    subscriberKind: 'external',
    subscriberExternalId: 'member:alex',
    planId: String(selectedPlan.id),
    agreedAmount: 750,
    status: 'active',
  });
  expect(member.agreedAmount).toBe(750);
  const resolver = new SubscriptionResolver({
    plans,
    subscriptions,
    usage: {
      async summarize() {
        throw new Error('No thresholds require usage');
      },
    },
  });
  const resolution = await resolver.resolveEntitlements({
    kind: 'external',
    tenantId: tenant,
    externalId: 'member:alex',
  });
  expect(resolution.allowed).toBe(true);
  expect(resolution.featureKeys).toEqual(['worker:vote']);
  expect(
    (
      await resolver.resolveEntitlements({
        kind: 'external',
        tenantId: '33333333-3333-4333-8333-333333333333',
        externalId: 'member:alex',
      })
    ).allowed,
  ).toBe(false);
}

describe('plan-key upgrade (#3829)', () => {
  it('preserves SQLite records and replaces global uniqueness with tenant identity', async () => {
    const db = await getDatabase({ type: 'sqlite', url: ':memory:' });
    try {
      await upgrade(db, 'sqlite');
    } finally {
      await db.close?.();
    }
  });
  it.skipIf(!isPostgresAvailable())(
    'preserves PostgreSQL records and enforces scoped/null-equal identity',
    async () => {
      const baseUrl = process.env.DATABASE_URL;
      if (!baseUrl) throw new Error('DATABASE_URL required');
      const admin = await getDatabase({ type: 'postgres', url: baseUrl });
      const databaseName = `upgrade_3829_${randomUUID().replaceAll('-', '')}`;
      await admin.query(`CREATE DATABASE "${databaseName}"`);
      const url = new URL(baseUrl);
      url.pathname = `/${databaseName}`;
      const db = await getDatabase({ type: 'postgres', url: url.toString() });
      try {
        await upgrade(db, 'postgres');
      } finally {
        await db.close?.();
        await admin.query(`DROP DATABASE "${databaseName}" WITH (FORCE)`);
        await admin.close?.();
      }
    },
  );
});
