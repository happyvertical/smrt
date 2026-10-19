import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import { describe, expect, it } from 'vitest';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { SubscriptionPlanVersionCollection } from '../collections/SubscriptionPlanVersionCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';
import { SubscriptionPlanVersion } from '../models/SubscriptionPlanVersion.js';
import { TenantSubscription } from '../models/TenantSubscription.js';
import { isEntitlementUpgrade } from '../plan-terms.js';
import { SubscriptionResolver } from '../services/subscription-resolver.js';
import type { PlanTerms, PlanThreshold, Subscriber } from '../types.js';
import {
  NORTH,
  runPlanVersionScenario,
  SOUTH,
} from './helpers/plan-version-scenario.js';

const DAY = 24 * 60 * 60 * 1000;
const at = (offsetDays: number) => new Date(Date.now() + offsetDays * DAY);

async function fixture() {
  const plans = await SubscriptionPlanCollection.create({
    db: { type: 'sqlite', url: ':memory:' },
  });
  const versions = await SubscriptionPlanVersionCollection.create({
    db: plans.db,
  });
  const subscriptions = await TenantSubscriptionCollection.create({
    db: plans.db,
  });
  const resolver = await SubscriptionResolver.create({ db: plans.db });
  const plan = await plans.create({
    tenantId: NORTH,
    planKey: 'steward',
    name: 'Steward',
    priceAmount: 1200,
    features: JSON.stringify(['coop:vote', 'coop:minutes']),
  });
  const subscription = await subscriptions.create({
    tenantId: NORTH,
    subscriberKind: 'external',
    subscriberExternalId: 'member:rio',
    planId: String(plan.id),
    status: 'active',
    currentPeriodStart: at(-5),
    currentPeriodEnd: at(25),
  });
  return { plans, versions, subscriptions, resolver, plan, subscription };
}

function terms(features: string[], thresholds: PlanThreshold[] = []) {
  return {
    status: 'active',
    priceAmount: 0,
    currency: 'USD',
    billingInterval: 'month',
    pricingMode: 'free',
    minimumAmount: 0,
    suggestedAmount: 0,
    features: JSON.stringify(features),
    thresholds: JSON.stringify(thresholds),
  } satisfies PlanTerms;
}

async function rootCause(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (error) {
    let current: unknown = error;
    while (current instanceof Error && current.cause instanceof Error) {
      current = current.cause;
    }
    return current instanceof Error ? current.message : String(current);
  }
  return 'resolved';
}

const rio: Subscriber = {
  kind: 'external',
  tenantId: NORTH,
  externalId: 'member:rio',
};

describe('effective-dated plan versions (#4032)', () => {
  it('runs the worker co-op amendment/renewal/cancellation scenario on SQLite', async () => {
    const plans = await SubscriptionPlanCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    try {
      await runPlanVersionScenario(plans.db);
    } finally {
      await plans.db.close?.();
    }
  });

  it('defines an upgrade as taking no entitlement away', () => {
    const block = (limit: number): PlanThreshold => ({
      metricKey: 'coop.proposals',
      limit,
      window: 'month',
      enforcement: 'block',
    });
    const base = terms(['coop:vote'], [block(5)]);
    expect(
      isEntitlementUpgrade(base, terms(['coop:vote', 'x'], [block(9)])),
    ).toBe(true);
    expect(isEntitlementUpgrade(base, terms(['coop:vote'], []))).toBe(true);
    expect(isEntitlementUpgrade(base, terms([], [block(9)]))).toBe(false);
    expect(isEntitlementUpgrade(base, terms(['coop:vote'], [block(4)]))).toBe(
      false,
    );
    expect(
      isEntitlementUpgrade(
        base,
        terms(['coop:vote'], [block(5), { ...block(1), metricKey: 'new' }]),
      ),
    ).toBe(false);
    expect(
      isEntitlementUpgrade(base, {
        ...terms(['coop:vote'], [block(5)]),
        status: 'archived',
      }),
    ).toBe(false);
    expect(
      isEntitlementUpgrade(
        terms(['coop:vote'], [{ ...block(5), enforcement: 'warn' }]),
        terms(['coop:vote'], [block(5)]),
      ),
    ).toBe(false);
  });

  it('applies upgrades in-period, defers downgrades, and audits authorized replacements', async () => {
    const { plans, versions, subscriptions, resolver, plan, subscription } =
      await fixture();
    try {
      const v1 = await versions.findLatest(String(plan.id), NORTH);
      // An amendment that only adds is still deferred until asked for.
      plan.setFeatureGrants(['coop:vote', 'coop:minutes', 'coop:payroll']);
      const v2 = await plan.publishTerms();
      expect(v2.version).toBe(2);
      expect(
        (await subscriptions.get({ id: String(subscription.id) }))
          ?.planVersionId,
      ).toBe(v1?.id);
      await subscription.replacePlanVersion({
        policy: 'upgrade',
        reason: 'member requested payroll access',
      });
      expect(subscription).toMatchObject({
        planVersionId: v2.id,
        planVersionPinReason: 'upgrade',
        planVersionPinNote: 'member requested payroll access',
      });

      // A removal is refused in-period under the upgrade policy …
      plan.setFeatureGrants(['coop:vote']);
      const v3 = await plan.publishTerms();
      expect(
        await rootCause(() =>
          subscription.replacePlanVersion({ policy: 'upgrade' }),
        ),
      ).toMatch(/remove entitlements from a paid period/);
      // … and an authorized replacement needs a reason.
      expect(
        await rootCause(() =>
          subscription.replacePlanVersion({ policy: 'authorized' }),
        ),
      ).toMatch(/needs a reason/);
      const stored = await subscriptions.get(
        { id: String(subscription.id) },
        { cache: false },
      );
      expect(stored?.planVersionId).toBe(v2.id);
      await stored?.replacePlanVersion({
        policy: 'authorized',
        reason: 'refund issued, downgrade approved by treasurer',
      });
      expect(stored).toMatchObject({
        planVersionId: v3.id,
        planVersionPinReason: 'authorized',
      });
      expect(
        (await resolver.resolveEntitlements(rio, { now: at(1) })).featureKeys,
      ).toEqual(['coop:vote']);

      // Switching to a smaller plan mid-period is refused; a bigger one applies.
      const small = await plans.create({
        tenantId: NORTH,
        planKey: 'observer',
        name: 'Observer',
        features: JSON.stringify([]),
      });
      const big = await plans.create({
        tenantId: NORTH,
        planKey: 'board',
        name: 'Board',
        features: JSON.stringify(['coop:vote', 'coop:minutes', 'coop:sign']),
      });
      expect(
        await rootCause(() =>
          subscriptions.update(String(subscription.id), {
            planId: String(small.id),
          }),
        ),
      ).toMatch(/remove entitlements from a paid period/);
      const switched = await subscriptions.update(String(subscription.id), {
        planId: String(big.id),
      });
      expect(switched?.planVersionPinReason).toBe('upgrade');
      // The deferred downgrade lands with the renewal that carries it.
      const renewed = await subscriptions.update(String(subscription.id), {
        planId: String(small.id),
        currentPeriodStart: at(25),
        currentPeriodEnd: at(55),
      });
      expect(renewed?.planVersionPinReason).toBe('renewal');
      expect(
        (await resolver.resolveEntitlements(rio, { now: at(30) })).planKey,
      ).toBe('observer');
    } finally {
      await plans.db.close?.();
    }
  });

  it('cannot bypass the paid period by re-creating the subscriber row or forging the audit', async () => {
    const { plans, subscriptions, plan, subscription } = await fixture();
    try {
      const pinnedAt = subscription.planVersionPinnedAt;
      const observer = await plans.create({
        tenantId: NORTH,
        planKey: 'observer',
        name: 'Observer',
      });
      // create() on the same subscriber upserts onto the existing row.
      expect(
        await rootCause(() =>
          subscriptions.create({
            tenantId: NORTH,
            subscriberKind: 'external',
            subscriberExternalId: 'member:rio',
            planId: String(observer.id),
            status: 'active',
            currentPeriodStart: subscription.currentPeriodStart,
            currentPeriodEnd: subscription.currentPeriodEnd,
          }),
        ),
      ).toMatch(/remove entitlements from a paid period/);
      const forged = await subscriptions.update(String(subscription.id), {
        planVersionPinReason: 'authorized',
        planVersionPinNote: 'forged',
      });
      expect(forged).toMatchObject({
        planVersionPinReason: 'period_start',
        planVersionPinNote: '',
      });
      expect(forged?.planVersionPinnedAt?.getTime()).toBe(pinnedAt?.getTime());
      expect(
        (await subscriptions.get({ id: String(subscription.id) }))?.planId,
      ).toBe(plan.id);
    } finally {
      await plans.db.close?.();
    }
  });

  it('treats only a period starting at or after the paid end as a renewal', async () => {
    const { plans, versions, subscriptions, plan, subscription } =
      await fixture();
    try {
      const v1 = await versions.findLatest(String(plan.id), NORTH);
      const observer = await plans.create({
        tenantId: NORTH,
        planKey: 'observer',
        name: 'Observer',
      });
      plan.setFeatureGrants(['coop:vote']);
      const v2 = await plan.publishTerms();
      // Moving the start inside the paid period, forward or back, is not a
      // renewal and cannot carry a downgrade.
      for (const start of [at(1), at(-20)]) {
        expect(
          await rootCause(() =>
            subscriptions.update(String(subscription.id), {
              currentPeriodStart: start,
              planId: String(observer.id),
            }),
          ),
        ).toMatch(/remove entitlements from a paid period/);
      }
      const moved = await subscriptions.update(String(subscription.id), {
        currentPeriodStart: at(1),
      });
      expect(moved?.planVersionId).toBe(v1?.id);
      // A real renewal re-pins the boundary's version even when the caller
      // echoes the stale pin back …
      const stored = await subscriptions.get(
        { id: String(subscription.id) },
        { cache: false },
      );
      if (!stored) throw new Error('missing subscription');
      stored.currentPeriodStart = at(25);
      stored.currentPeriodEnd = at(55);
      stored.planVersionId = String(v1?.id);
      await stored.save();
      expect(stored).toMatchObject({
        planVersionId: v2.id,
        planVersionPinReason: 'renewal',
      });
      // … and only an authorized replacement grandfathers the old terms.
      await stored.replacePlanVersion({
        policy: 'authorized',
        reason: 'founding member keeps original terms',
        planVersionId: String(v1?.id),
      });
      expect(stored).toMatchObject({
        planVersionId: v1?.id,
        planVersionPinReason: 'authorized',
      });
      expect(v2.version).toBe(2);
      // A new subscription cannot name a version the boundary does not pick.
      expect(
        await rootCause(() =>
          subscriptions.create({
            tenantId: NORTH,
            subscriberKind: 'external',
            subscriberExternalId: 'member:new',
            planId: String(plan.id),
            planVersionId: String(v1?.id),
            status: 'active',
            currentPeriodStart: new Date(),
          }),
        ),
      ).toMatch(/pins the plan version in force at its start/);
    } finally {
      await plans.db.close?.();
    }
  });

  it('refuses a mid-period switch to a smaller unversioned legacy plan', async () => {
    const { plans, subscriptions, subscription } = await fixture();
    try {
      const legacy = await plans.create({
        tenantId: NORTH,
        planKey: 'legacy-observer',
        name: 'Legacy observer',
      });
      await plans.db.query(
        `DELETE FROM "_smrt_subscription_plan_versions" WHERE plan_id = '${legacy.id}'`,
      );
      expect(
        await rootCause(() =>
          subscriptions.update(String(subscription.id), {
            planId: String(legacy.id),
          }),
        ),
      ).toMatch(/remove entitlements from a paid period/);
    } finally {
      await plans.db.close?.();
    }
  });

  it('only keeps a paid period for a subscription canceled while entitled', async () => {
    const { plans, subscriptions, resolver, plan, subscription } =
      await fixture();
    try {
      const canceled = await subscriptions.update(String(subscription.id), {
        status: 'canceled',
        canceledAt: new Date(),
      });
      expect(canceled?.retainsPaidPeriod).toBe(true);
      expect(
        (await resolver.resolveEntitlements(rio, { now: at(10) })).allowed,
      ).toBe(true);
      for (const prior of ['incomplete', 'past_due', 'unpaid'] as const) {
        const row = await subscriptions.create({
          tenantId: NORTH,
          subscriberKind: 'external',
          subscriberExternalId: `member:${prior}`,
          planId: String(plan.id),
          status: prior,
          currentPeriodStart: at(-1),
          currentPeriodEnd: at(29),
        });
        const expired = await subscriptions.update(String(row.id), {
          status: 'canceled',
          canceledAt: new Date(),
        });
        expect(expired?.retainsPaidPeriod).toBe(false);
        expect(expired?.isEntitled(at(1))).toBe(false);
        // The flag is derived, never taken from the caller.
        const forged = await subscriptions.update(String(row.id), {
          retainsPaidPeriod: true,
        });
        expect(forged?.retainsPaidPeriod).toBe(false);
      }
      // Created already canceled: nothing to keep.
      const born = await subscriptions.create({
        tenantId: NORTH,
        subscriberKind: 'external',
        subscriberExternalId: 'member:born-canceled',
        planId: String(plan.id),
        status: 'canceled',
        retainsPaidPeriod: true,
        currentPeriodEnd: at(29),
      });
      expect(born.isEntitled(at(1))).toBe(false);
    } finally {
      await plans.db.close?.();
    }
  });

  it('resolves a pinned version of a legacy global plan under tenant context', async () => {
    const plans = await SubscriptionPlanCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const subscriptions = await TenantSubscriptionCollection.create({
      db: plans.db,
    });
    try {
      const global = await plans.create({
        planKey: 'network-supporter',
        name: 'Network supporter',
        features: JSON.stringify(['coop:directory']),
      });
      const member = await subscriptions.create({
        tenantId: NORTH,
        subscriberKind: 'external',
        subscriberExternalId: 'member:rio',
        planId: String(global.id),
        status: 'active',
        currentPeriodStart: at(-1),
        currentPeriodEnd: at(29),
      });
      expect(member.planVersionId).not.toBeNull();
      enableTenancy();
      try {
        await withTenant({ tenantId: NORTH }, async () => {
          const resolver = await SubscriptionResolver.create({ db: plans.db });
          expect(
            await resolver.resolveEntitlements(rio, { now: at(1) }),
          ).toMatchObject({
            allowed: true,
            planVersion: 1,
            featureKeys: ['coop:directory'],
          });
        });
      } finally {
        disableTenancy();
      }
    } finally {
      await plans.db.close?.();
    }
  });

  it('keeps an archived tier through the paid period and stops at renewal', async () => {
    const { plans, subscriptions, resolver, plan, subscription } =
      await fixture();
    try {
      plan.status = 'archived';
      await plan.save();
      expect(
        await resolver.resolveEntitlements(rio, { now: at(1) }),
      ).toMatchObject({ allowed: true, planVersion: 1 });
      await subscriptions.update(String(subscription.id), {
        currentPeriodStart: at(25),
        currentPeriodEnd: at(55),
      });
      expect(
        await resolver.resolveEntitlements(rio, { now: at(30) }),
      ).toMatchObject({ allowed: false, planVersion: 2, featureKeys: [] });
    } finally {
      await plans.db.close?.();
    }
  });

  it('pins renewals to a scheduled amendment only once it is in force', async () => {
    const { plans, subscriptions, plan, subscription } = await fixture();
    try {
      plan.priceAmount = 1500;
      plan.setFeatureGrants(['coop:vote']);
      const scheduled = await plan.publishTerms({ effectiveFrom: at(40) });
      // Versions are monotonic: nothing may start before the scheduled one.
      plan.priceAmount = 1300;
      expect(await rootCause(() => plan.save())).toMatch(
        /cannot start earlier/,
      );
      const first = await subscriptions.update(String(subscription.id), {
        currentPeriodStart: at(25),
        currentPeriodEnd: at(40),
      });
      expect(first?.planVersionId).not.toBe(scheduled.id);
      const second = await subscriptions.update(String(subscription.id), {
        currentPeriodStart: at(40),
        currentPeriodEnd: at(70),
      });
      expect(second?.planVersionId).toBe(scheduled.id);
      expect(scheduled.priceAmount).toBe(1500);
    } finally {
      await plans.db.close?.();
    }
  });

  it('keeps versions immutable, append-only, contiguous and in integer minor units', async () => {
    const { plans, versions, plan } = await fixture();
    try {
      const v1 = await versions.findLatest(String(plan.id), NORTH);
      if (!v1) throw new Error('missing version');
      await expect(
        versions.update(String(v1.id), { priceAmount: 1 }),
      ).rejects.toThrow();
      await expect(v1.delete()).rejects.toThrow(/append-only/);
      const base = {
        tenantId: NORTH,
        planId: String(plan.id),
        planKey: 'steward',
        effectiveFrom: new Date(),
      };
      await expect(versions.create({ ...base, version: 3 })).rejects.toThrow();
      await expect(versions.create({ ...base, version: 1 })).rejects.toThrow();
      await expect(
        versions.create({ ...base, version: 2, priceAmount: 12.5 }),
      ).rejects.toThrow();
      await expect(
        versions.create({ ...base, version: 2, planKey: 'other' }),
      ).rejects.toThrow();
      // A version can only belong to its own co-op's plan.
      await expect(
        versions.create({ ...base, tenantId: SOUTH, version: 1 }),
      ).rejects.toThrow();
      expect(await versions.listForPlan(String(plan.id))).toHaveLength(1);
    } finally {
      await plans.db.close?.();
    }
  });

  it('records the pre-edit terms of an unversioned legacy plan as version 1', async () => {
    const { plans, versions, plan } = await fixture();
    try {
      await plans.db.query(
        `UPDATE "_smrt_tenant_subscriptions" SET plan_version_id = NULL`,
      );
      await plans.db.query(
        `DELETE FROM "_smrt_subscription_plan_versions" WHERE plan_id = '${plan.id}'`,
      );
      plan.setFeatureGrants(['coop:vote']);
      await plan.save();
      const all = await versions.listForPlan(String(plan.id));
      expect(all.map((version) => version.getFeatureKeys())).toEqual([
        ['coop:vote', 'coop:minutes'],
        ['coop:vote'],
      ]);
    } finally {
      await plans.db.close?.();
    }
  });

  it('fails closed on a missing, inactive or mismatched version', async () => {
    const { plans, versions, resolver, plan, subscription } = await fixture();
    try {
      const v1 = await versions.findLatest(String(plan.id), NORTH);
      // Missing (context says absent) — never falls back to the live plan.
      expect(
        await resolver.resolveEntitlements(rio, {
          now: at(1),
          context: { subscription, plan, planVersion: null },
        }),
      ).toMatchObject({ allowed: false, featureKeys: [] });
      // Missing (reader cannot find the pinned row).
      const blind = new SubscriptionResolver({
        plans,
        subscriptions: await TenantSubscriptionCollection.create({
          db: plans.db,
        }),
        usage: {
          async summarize() {
            throw new Error('no thresholds');
          },
        },
        planVersions: { get: async () => null },
      });
      expect(
        await blind.resolveEntitlements(rio, { now: at(1) }),
      ).toMatchObject({ allowed: false, featureKeys: [] });
      // Inactive version.
      const draft = new SubscriptionPlanVersion({
        ...v1?.getTerms(),
        id: 'draft-version',
        tenantId: NORTH,
        planId: String(plan.id),
        version: 9,
        status: 'draft',
      });
      Object.assign(draft, { id: 'draft-version' });
      const pinnedToDraft = new TenantSubscription({
        tenantId: NORTH,
        subscriberKind: 'external',
        subscriberExternalId: 'member:rio',
        planId: String(plan.id),
        planVersionId: 'draft-version',
        status: 'active',
      });
      expect(
        await resolver.resolveEntitlements(rio, {
          context: { subscription: pinnedToDraft, plan, planVersion: draft },
        }),
      ).toMatchObject({ allowed: false, planVersion: 9 });
      // Mismatched: another co-op's version, or a version of another plan.
      const foreign = new SubscriptionPlanVersion({
        tenantId: SOUTH,
        planId: String(plan.id),
        version: 1,
      });
      Object.assign(foreign, { id: String(v1?.id) });
      await expect(
        resolver.resolveEntitlements(rio, {
          context: { subscription, plan, planVersion: foreign },
        }),
      ).rejects.toThrow(/does not belong/);
      const otherPlan = new SubscriptionPlanVersion({
        tenantId: NORTH,
        planId: 'another-plan',
        version: 1,
      });
      Object.assign(otherPlan, { id: String(v1?.id) });
      await expect(
        resolver.resolveEntitlements(rio, {
          context: { subscription, plan, planVersion: otherPlan },
        }),
      ).rejects.toThrow(/does not match/);
      // A loaded context round-trips without re-reading.
      const context = await resolver.loadEntitlementContext(rio, {
        now: at(1),
      });
      expect(context.planVersion?.id).toBe(v1?.id);
    } finally {
      await plans.db.close?.();
    }
  });
});
