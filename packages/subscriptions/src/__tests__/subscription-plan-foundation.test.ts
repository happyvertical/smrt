import { describe, expect, it } from 'vitest';
import { SubscriptionPlanCollection } from '../collections/SubscriptionPlanCollection.js';
import { TenantSubscriptionCollection } from '../collections/TenantSubscriptionCollection.js';

describe('subscription-plan foundation (#3829)', () => {
  it('isolates worker-co-op plan keys by tenant and persists optional provider metadata', async () => {
    const plans = await SubscriptionPlanCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    try {
      const north = await plans.create({
        tenantId: 'worker-coop-north',
        planKey: 'membership',
        name: 'Membership',
        pricingMode: 'pay_what_you_can',
        minimumAmount: 500,
        suggestedAmount: 1200,
      });
      const south = await plans.create({
        tenantId: 'worker-coop-south',
        planKey: 'membership',
        name: 'Membership',
        pricingMode: 'free',
      });
      expect(north.providerPriceId).toBeNull();
      expect(
        (await plans.findByPlanKey('worker-coop-north', 'membership'))?.id,
      ).toBe(north.id);
      expect(
        (await plans.findByPlanKey('worker-coop-south', 'membership'))?.id,
      ).toBe(south.id);
    } finally {
      await plans.db.close?.();
    }
  });

  it('records an external subscriber agreed amount and rejects fractional money', async () => {
    const plans = await SubscriptionPlanCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const subscriptions = await TenantSubscriptionCollection.create({
      db: plans.db,
    });
    try {
      const plan = await plans.create({
        tenantId: 'worker-coop',
        planKey: 'solidarity',
        name: 'Solidarity',
        pricingMode: 'pay_what_you_can',
        minimumAmount: 500,
        suggestedAmount: 1000,
      });
      const subscription = await subscriptions.create({
        tenantId: 'worker-coop',
        subscriberKind: 'external',
        subscriberExternalId: 'member:alex',
        planId: String(plan.id),
        status: 'active',
        agreedAmount: 750,
      });
      expect(subscription.agreedAmount).toBe(750);
      await expect(
        plans.create({
          tenantId: 'worker-coop',
          planKey: 'broken',
          name: 'Broken',
          minimumAmount: 1.5,
        }),
      ).rejects.toThrow();
    } finally {
      await plans.db.close?.();
    }
  });

  it('keeps the legacy global key unique and never crosses a tenant scope', async () => {
    const plans = await SubscriptionPlanCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    try {
      await plans.create({ planKey: 'legacy', name: 'Global legacy plan' });
      await plans.create({
        planKey: 'legacy',
        name: 'Updated global legacy plan',
      });
      await plans.create({
        tenantId: 'worker-coop-north',
        planKey: 'legacy',
        name: 'North membership',
      });
      const global = await plans.list({
        where: { tenantId: null, planKey: 'legacy' },
      });
      expect(global).toHaveLength(1);
      expect((await plans.findByPlanKey(null, 'legacy'))?.name).toBe(
        'Updated global legacy plan',
      );
      expect(
        (await plans.findByPlanKey('worker-coop-north', 'legacy'))?.name,
      ).toBe('North membership');
      expect(
        await plans.findByPlanKey('worker-coop-south', 'legacy'),
      ).toBeNull();
    } finally {
      await plans.db.close?.();
    }
  });
  it('rejects invalid modes and subscription amounts on both create and update', async () => {
    const plans = await SubscriptionPlanCollection.create({
      db: { type: 'sqlite', url: ':memory:' },
    });
    const subscriptions = await TenantSubscriptionCollection.create({
      db: plans.db,
    });
    try {
      const plan = await plans.create({
        tenantId: 'coop',
        planKey: 'solidarity',
        name: 'Solidarity',
        pricingMode: 'pay_what_you_can',
        minimumAmount: 500,
      });
      await expect(
        plans.update(String(plan.id), { pricingMode: 'invalid' }),
      ).rejects.toThrow();
      await expect(
        plans.create({
          planKey: 'free',
          name: 'Free',
          pricingMode: 'free',
          priceAmount: 100,
        }),
      ).rejects.toThrow();
      await expect(
        subscriptions.create({
          tenantId: 'coop',
          planId: String(plan.id),
          agreedAmount: 499,
        }),
      ).rejects.toThrow();
      await expect(
        subscriptions.create({ tenantId: 'coop', planId: String(plan.id) }),
      ).rejects.toThrow();
      const subscription = await subscriptions.create({
        tenantId: 'coop',
        planId: String(plan.id),
        agreedAmount: 500,
      });
      await expect(
        subscriptions.update(String(subscription.id), { agreedAmount: 499 }),
      ).rejects.toThrow();
      const fixed = await plans.create({
        planKey: 'fixed',
        name: 'Fixed',
        priceAmount: 100,
      });
      await expect(
        subscriptions.create({
          tenantId: 'other',
          planId: String(fixed.id),
          agreedAmount: 100,
        }),
      ).rejects.toThrow();
    } finally {
      await plans.db.close?.();
    }
  });
});
