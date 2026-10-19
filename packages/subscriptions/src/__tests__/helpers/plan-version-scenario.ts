/**
 * Engine-independent #4032 scenario: a worker co-op's membership tiers are
 * amended, renewed and canceled while another co-op reuses the same plan
 * key. Run against SQLite (plan-versions.test.ts) and PostgreSQL
 * (plan-versions.optional.test.ts). The fixture deliberately uses no
 * outlet/article/advertising concept.
 */
import {
  disableTenancy,
  enableTenancy,
  withSystemContext,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect } from 'vitest';
import { SubscriptionPlanCollection } from '../../collections/SubscriptionPlanCollection.js';
import { SubscriptionPlanVersionCollection } from '../../collections/SubscriptionPlanVersionCollection.js';
import { TenantSubscriptionCollection } from '../../collections/TenantSubscriptionCollection.js';
import { migrateSubscriptionPlanVersions } from '../../migrations/planVersions.js';
import { SubscriptionResolver } from '../../services/subscription-resolver.js';
import type { Subscriber } from '../../types.js';

export const NORTH = '0a000000-0000-4000-8000-000000000001';
export const SOUTH = '0a000000-0000-4000-8000-000000000002';
const DAY = 24 * 60 * 60 * 1000;

const member = (tenantId: string, externalId: string): Subscriber => ({
  kind: 'external',
  tenantId,
  externalId,
});

export async function runPlanVersionScenario(
  db: DatabaseInterface,
): Promise<void> {
  const plans = await SubscriptionPlanCollection.create({ db });
  const versions = await SubscriptionPlanVersionCollection.create({ db });
  const subscriptions = await TenantSubscriptionCollection.create({ db });
  const resolver = await SubscriptionResolver.create({ db });
  const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY);
  const periodStart = at(-10);
  const periodEnd = at(20);

  // --- Two co-ops reuse the plan key `member` with different grants. -----
  const north = await plans.create({
    tenantId: NORTH,
    planKey: 'member',
    name: 'Worker-owner',
    pricingMode: 'pay_what_you_can',
    minimumAmount: 500,
    suggestedAmount: 1500,
    features: JSON.stringify(['coop:vote', 'coop:shift-swap']),
    thresholds: JSON.stringify([
      {
        metricKey: 'coop.proposals',
        limit: 5,
        window: 'month',
        enforcement: 'block',
      },
    ]),
  });
  const south = await plans.create({
    tenantId: SOUTH,
    planKey: 'member',
    name: 'Bakery member',
    pricingMode: 'fixed',
    priceAmount: 2500,
    features: JSON.stringify(['coop:vote', 'coop:bulk-orders']),
  });
  const northV1 = await versions.findLatest(String(north.id), NORTH);
  const southV1 = await versions.findLatest(String(south.id), SOUTH);
  expect(northV1?.version).toBe(1);
  expect(southV1?.version).toBe(1);
  expect(northV1?.minimumAmount).toBe(500);
  expect(Number.isSafeInteger(northV1?.suggestedAmount)).toBe(true);
  expect(southV1?.priceAmount).toBe(2500);

  const alex = await subscriptions.create({
    tenantId: NORTH,
    subscriberKind: 'external',
    subscriberExternalId: 'member:alex',
    planId: String(north.id),
    status: 'active',
    agreedAmount: 900,
    startedAt: periodStart,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  expect(alex.planVersionId).toBe(northV1?.id);
  expect(alex.planVersionPinReason).toBe('period_start');
  const sam = await subscriptions.create({
    tenantId: SOUTH,
    subscriberKind: 'external',
    subscriberExternalId: 'member:alex',
    planId: String(south.id),
    status: 'active',
    startedAt: periodStart,
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  expect(sam.planVersionId).toBe(southV1?.id);

  // --- Amendment: North removes shift swaps and tightens proposals. -------
  north.setFeatureGrants(['coop:vote']);
  north.setThresholds([
    {
      metricKey: 'coop.proposals',
      limit: 2,
      window: 'month',
      enforcement: 'block',
    },
  ]);
  await north.save();
  const northV2 = await versions.findLatest(String(north.id), NORTH);
  expect(northV2?.version).toBe(2);
  // Re-saving unchanged terms publishes nothing.
  await north.save();
  expect((await versions.listForPlan(String(north.id))).length).toBe(2);

  // Alex's paid period keeps version 1, in full.
  const midPeriod = await resolver.resolveEntitlements(
    member(NORTH, 'member:alex'),
    { now: at(0) },
  );
  expect(midPeriod).toMatchObject({
    allowed: true,
    planVersion: 1,
    planVersionId: northV1?.id,
    featureKeys: ['coop:vote', 'coop:shift-swap'],
  });
  expect(midPeriod.thresholds[0]?.limit).toBe(5);

  // A member joining after the amendment gets version 2.
  const bea = await subscriptions.create({
    tenantId: NORTH,
    subscriberKind: 'external',
    subscriberExternalId: 'member:bea',
    planId: String(north.id),
    status: 'active',
    agreedAmount: 500,
    currentPeriodStart: new Date(),
    currentPeriodEnd: at(30),
  });
  expect(bea.planVersionId).toBe(northV2?.id);
  expect(
    (
      await resolver.resolveEntitlements(member(NORTH, 'member:bea'), {
        now: at(1),
      })
    ).featureKeys,
  ).toEqual(['coop:vote']);

  // The other co-op's same-key plan never saw North's amendment.
  expect(
    (
      await resolver.resolveEntitlements(member(SOUTH, 'member:alex'), {
        now: at(0),
      })
    ).featureKeys,
  ).toEqual(['coop:vote', 'coop:bulk-orders']);
  expect((await versions.listForPlan(String(south.id))).length).toBe(1);

  // A downgrade cannot be forced into the paid period by pinning directly.
  await expect(
    subscriptions.update(String(alex.id), {
      planVersionId: String(northV2?.id),
    }),
  ).rejects.toThrow();
  // Nor can a subscription pin another co-op's version of the same key.
  await expect(
    subscriptions.update(String(alex.id), {
      planVersionId: String(southV1?.id),
    }),
  ).rejects.toThrow();

  // --- Renewal moves to the version in force at the boundary. ------------
  const renewed = await subscriptions.update(String(alex.id), {
    currentPeriodStart: periodEnd,
    currentPeriodEnd: at(50),
  });
  expect(renewed?.planVersionId).toBe(northV2?.id);
  expect(renewed?.planVersionPinReason).toBe('renewal');
  expect(
    await resolver.resolveEntitlements(member(NORTH, 'member:alex'), {
      now: at(25),
    }),
  ).toMatchObject({ planVersion: 2, featureKeys: ['coop:vote'] });

  // --- Cancellation keeps the paid period, then resolves nothing. --------
  await subscriptions.update(String(bea.id), {
    status: 'canceled',
    canceledAt: new Date(),
  });
  expect(
    await resolver.resolveEntitlements(member(NORTH, 'member:bea'), {
      now: at(29),
    }),
  ).toMatchObject({
    status: 'canceled',
    allowed: true,
    featureKeys: ['coop:vote'],
  });
  expect(
    await resolver.resolveEntitlements(member(NORTH, 'member:bea'), {
      now: at(31),
    }),
  ).toMatchObject({ allowed: false, featureKeys: [] });

  // --- Tenancy: each co-op sees only its own versions. -------------------
  enableTenancy();
  try {
    await withTenant({ tenantId: NORTH }, async () => {
      const visible = await versions.list({ where: { planKey: 'member' } });
      expect(new Set(visible.map((version) => version.tenantId))).toEqual(
        new Set([NORTH]),
      );
      const scoped = await SubscriptionResolver.create({ db });
      expect(
        (
          await scoped.resolveEntitlements(member(NORTH, 'member:alex'), {
            now: at(25),
          })
        ).planVersion,
      ).toBe(2);
      // South's version is invisible from North and cannot be pinned.
      expect(await versions.get({ id: String(southV1?.id) })).toBeNull();
    });
  } finally {
    disableTenancy();
  }

  // --- Migration of pre-#4032 rows: version 1 = current terms. -----------
  const legacy = await plans.create({
    tenantId: NORTH,
    planKey: 'legacy-associate',
    name: 'Associate',
    features: JSON.stringify(['coop:newsletter']),
  });
  const legacyMember = await subscriptions.create({
    tenantId: NORTH,
    subscriberKind: 'external',
    subscriberExternalId: 'member:legacy',
    planId: String(legacy.id),
    status: 'active',
    currentPeriodStart: periodStart,
    currentPeriodEnd: periodEnd,
  });
  // Rewind both rows to their pre-versioning shape.
  await withSystemContext(async () => {
    await db.query(
      `UPDATE "_smrt_tenant_subscriptions" SET plan_version_id = NULL, plan_version_pin_reason = NULL WHERE id = '${legacyMember.id}'`,
    );
    await db.query(
      `DELETE FROM "_smrt_subscription_plan_versions" WHERE plan_id = '${legacy.id}'`,
    );
  });
  // Unmigrated: the live plan stays authoritative.
  expect(
    (
      await resolver.resolveEntitlements(member(NORTH, 'member:legacy'), {
        now: at(0),
      })
    ).featureKeys,
  ).toEqual(['coop:newsletter']);
  const report = await migrateSubscriptionPlanVersions(db);
  expect(report.plansVersioned).toBe(1);
  expect(report.subscriptionsPinned).toBe(1);
  expect(report.failed).toEqual([]);
  const migrated = await subscriptions.get(
    { id: String(legacyMember.id) },
    { cache: false },
  );
  expect(migrated?.planVersionPinReason).toBe('migration');
  const legacyV1 = await versions.findLatest(String(legacy.id), NORTH);
  expect(legacyV1?.version).toBe(1);
  expect(migrated?.planVersionId).toBe(legacyV1?.id);
  expect(legacyV1?.getFeatureKeys()).toEqual(['coop:newsletter']);
  // Idempotent.
  expect(await migrateSubscriptionPlanVersions(db)).toEqual({
    plansVersioned: 0,
    subscriptionsPinned: 0,
    failed: [],
  });
  expect(
    (
      await resolver.resolveEntitlements(member(NORTH, 'member:legacy'), {
        now: at(0),
      })
    ).planVersion,
  ).toBe(1);
}
