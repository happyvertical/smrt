/**
 * Declared recipes for smrt-subscriptions (#4409): user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 * The scanner reads these statics into the `recipes` array of `manifest.json`
 * and `smrt-knowledge.json`; nothing here runs at that point.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { ClientCharge } from './models/commercial.js';
import { SubscriptionPlan } from './models/SubscriptionPlan.js';
import { SubscriptionPlanVersion } from './models/SubscriptionPlanVersion.js';
import { TenantSubscription } from './models/TenantSubscription.js';

/**
 * Subscriptions: the plans you sell, who is subscribed to which, the terms
 * each paid period is held to, and what usage was charged. Reseller pricing
 * (price books, pricing rules, credits) stays out: it is a wholesale concern,
 * not something a person opens day to day.
 */
export class SubscriptionPlansRecipe extends SmrtRecipe {
  static id = 'subscriptions.plans';
  static help = './plans.recipe.md';
  static label = 'Subscriptions';
  static summary =
    'Sell plans that renew, see who is subscribed to which, and what their usage cost.';
  static synonyms = [
    'subscriptions',
    'subscription plans',
    'plans',
    'memberships',
    'recurring billing',
    'pricing tiers',
  ];
  static section = {
    id: 'sales',
    label: 'Sales',
    icon: 'shoppingBag',
    description: 'Customers, orders and quotes: everything you sell.',
  };
  static models = [
    SubscriptionPlan,
    SubscriptionPlanVersion,
    TenantSubscription,
    ClientCharge,
  ];
  static nav = [
    {
      label: 'Plans',
      model: SubscriptionPlan,
      icon: 'tag',
      description:
        'The plans you sell, with their price and how often they bill.',
      noun: 'plan',
    },
    {
      label: 'Subscriptions',
      model: TenantSubscription,
      icon: 'repeat',
      description:
        'Who is subscribed to which plan, and where each one stands.',
      noun: 'subscription',
    },
    {
      label: 'Plan versions',
      model: SubscriptionPlanVersion,
      icon: 'fileText',
      description:
        'Every set of terms a plan has had, and from when each applied.',
      noun: 'plan version',
    },
    {
      label: 'Charges',
      model: ClientCharge,
      icon: 'receipt',
      description: 'What each subscriber used and what it cost them.',
      noun: 'charge',
    },
  ];
  static options = {
    SubscriptionPlan: {
      fields: {
        name: { order: 1 },
        planKey: { label: 'Plan code', order: 2 },
        description: { order: 3 },
        status: { order: 4 },
        priceAmount: { label: 'Price (in cents)', order: 5 },
        currency: { order: 6 },
        billingInterval: { label: 'Billed every', order: 7 },
        pricingMode: { label: 'How it is priced', order: 8 },
        minimumAmount: {
          label: 'Minimum (in cents)',
          visibility: 'advanced',
        },
        suggestedAmount: {
          label: 'Suggested (in cents)',
          visibility: 'advanced',
        },
        sortOrder: { label: 'Position in list', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        features: { visibility: 'hidden' },
        thresholds: { visibility: 'hidden' },
        externalProvider: { visibility: 'hidden' },
        providerProductId: { visibility: 'hidden' },
        providerPriceId: { visibility: 'hidden' },
        stripeProductId: { visibility: 'hidden' },
        stripePriceId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    SubscriptionPlanVersion: {
      fields: {
        planId: { label: 'Plan', order: 1 },
        version: { label: 'Version number', order: 2 },
        effectiveFrom: { label: 'In force from', order: 3 },
        name: { order: 4 },
        status: { order: 5 },
        priceAmount: { label: 'Price (in cents)', order: 6 },
        currency: { order: 7 },
        billingInterval: { label: 'Billed every', order: 8 },
        planKey: { label: 'Plan code', visibility: 'advanced' },
        pricingMode: { label: 'How it is priced', visibility: 'advanced' },
        minimumAmount: {
          label: 'Minimum (in cents)',
          visibility: 'advanced',
        },
        suggestedAmount: {
          label: 'Suggested (in cents)',
          visibility: 'advanced',
        },
        tenantId: { visibility: 'hidden' },
        features: { visibility: 'hidden' },
        thresholds: { visibility: 'hidden' },
      },
    },
    TenantSubscription: {
      fields: {
        planId: { label: 'Plan', order: 1 },
        status: { order: 2 },
        startedAt: { label: 'Started on', order: 3 },
        currentPeriodStart: { label: 'Current period starts', order: 4 },
        currentPeriodEnd: { label: 'Current period ends', order: 5 },
        trialEndsAt: { label: 'Trial ends', order: 6 },
        cancelAtPeriodEnd: { label: 'Cancel at end of period', order: 7 },
        canceledAt: { label: 'Cancelled on', visibility: 'advanced' },
        agreedAmount: {
          label: 'Agreed amount (in cents)',
          visibility: 'advanced',
        },
        subscriberKind: { label: 'Subscriber type', visibility: 'advanced' },
        subscriberExternalId: {
          label: 'Outside subscriber',
          visibility: 'advanced',
        },
        planVersionId: {
          label: 'Plan version',
          visibility: 'advanced',
          locked: true,
        },
        tenantId: { visibility: 'hidden' },
        planVersionPinnedAt: { visibility: 'hidden' },
        planVersionPinReason: { visibility: 'hidden' },
        planVersionPinNote: { visibility: 'hidden' },
        retainsPaidPeriod: { visibility: 'hidden' },
        externalProvider: { visibility: 'hidden' },
        stripeCustomerId: { visibility: 'hidden' },
        stripeSubscriptionId: { visibility: 'hidden' },
        stripeCheckoutSessionId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    ClientCharge: {
      fields: {
        metricKey: { label: 'What was used', order: 1 },
        quantity: { label: 'How much', order: 2 },
        amount: { label: 'Amount (in cents)', order: 3 },
        currency: { order: 4 },
        status: { order: 5 },
        approvedAt: { label: 'Approved on', order: 6 },
        serviceKey: { label: 'Service', visibility: 'advanced' },
        provider: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        usageEventId: { visibility: 'hidden' },
        usageTenantId: { visibility: 'hidden' },
        subscriberKind: { visibility: 'hidden' },
        subscriberExternalId: { visibility: 'hidden' },
        projectId: { visibility: 'hidden' },
        workRefType: { visibility: 'hidden' },
        workRefId: { visibility: 'hidden' },
        pricingRuleId: { visibility: 'hidden' },
        priceBookId: { visibility: 'hidden' },
        pricingSnapshot: { visibility: 'hidden' },
      },
    },
  } as const;
}
