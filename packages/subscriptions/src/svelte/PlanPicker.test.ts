import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import { SubscriptionPlan } from '../models/SubscriptionPlan.js';
import PlanPicker, { type PlanPickerPlan } from './PlanPicker.svelte';
import planPickerSource from './PlanPicker.svelte?raw';

describe('PlanPicker', () => {
  it('keys serialized id-less plans by planKey', () => {
    const plans: PlanPickerPlan[] = [
      {
        planKey: 'starter',
        name: 'Starter',
        priceAmount: 0,
        currency: 'USD',
        billingInterval: 'month',
      },
      {
        planKey: 'pro',
        name: 'Pro',
        priceAmount: 10,
        currency: 'USD',
        billingInterval: 'month',
      },
    ];

    const { body } = render(PlanPicker, {
      props: { plans },
    });

    expect(body.match(/smrt-plan-picker__plan/g)).toHaveLength(2);
    expect(planPickerSource).toContain('{#each plans as plan (plan.planKey)}');
  });

  it('counts enabled features from the normal model serialization shape', () => {
    const plan = new SubscriptionPlan({
      planKey: 'pro',
      name: 'Pro',
      priceAmount: 10,
      currency: 'USD',
      billingInterval: 'month',
      features: JSON.stringify([
        'smrt:chat',
        { featureKey: 'smrt:projects', enabled: true },
        { featureKey: 'smrt:disabled', enabled: false },
      ]),
    });
    const serialized = plan.toJSON() as unknown as PlanPickerPlan;

    const { body } = render(PlanPicker, {
      props: { plans: [serialized] },
    });

    expect(body).toContain('2 features');
  });

  it('treats malformed serialized feature JSON as empty', () => {
    const plan: PlanPickerPlan = {
      planKey: 'broken',
      name: 'Broken',
      priceAmount: 0,
      currency: 'USD',
      billingInterval: 'month',
      features: '{bad json',
    };
    const { body } = render(PlanPicker, {
      props: { plans: [plan] },
    });

    expect(body).toContain('0 features');
  });
});
