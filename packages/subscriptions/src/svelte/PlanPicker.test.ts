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

  it('renders a minor-units price as major units', () => {
    // `priceAmount` is integer minor units (#2401), so 1999 is $19.99 — not
    // $1,999.00. Nothing asserted the rendered string before, which is exactly
    // how a unit change slips through a currency formatter unnoticed.
    const plans: PlanPickerPlan[] = [
      {
        planKey: 'pro',
        name: 'Pro',
        priceAmount: 1999,
        currency: 'USD',
        billingInterval: 'month',
      },
    ];

    const { body } = render(PlanPicker, { props: { plans } });

    expect(body).toContain('19.99');
    expect(body).not.toContain('1,999');
  });

  it('renders a zero-decimal currency without rescaling it', () => {
    // JPY has no minor unit, so ¥1999 must render as ¥1,999 rather than ¥19.99.
    const plans: PlanPickerPlan[] = [
      {
        planKey: 'jp',
        name: 'Japan',
        priceAmount: 1999,
        currency: 'JPY',
        billingInterval: 'month',
      },
    ];

    const { body } = render(PlanPicker, { props: { plans } });

    expect(body).toContain('1,999');
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
