/**
 * Declared recipes for the referrals module of smrt-sales (#4409, #4437).
 *
 * `affiliates.referrals` lives here, not in `@happyvertical/smrt-affiliates`:
 * that package is a deprecated shim that declares no models, and a recipe
 * needs models of its own package. The id keeps the word people use
 * ("affiliates"); the scanner and the planner catalog read it from this
 * package's manifest.
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Commission } from '../commissions/models/Commission.js';
import { CommissionPayout } from '../commissions/models/CommissionPayout.js';
import { Earner } from '../commissions/models/Earner.js';
import { Referral } from './models/Referral.js';
import { ReferralProgram } from './models/ReferralProgram.js';
import { Referrer } from './models/Referrer.js';

/** Affiliates: Reward partners for the customers they send you, and pay them what they earn. */
export class AffiliatesReferralsRecipe extends SmrtRecipe {
  static id = 'affiliates.referrals';
  static help = './referrals.recipe.md';
  static label = 'Affiliates';
  static summary =
    'Reward partners for the customers they send you, and pay them what they earn.';
  static synonyms = [
    'referrals',
    'referral program',
    'partners',
    'commissions',
    'payouts',
    'refer a friend',
  ];
  static section = {
    id: 'grow',
    label: 'Grow',
    icon: 'tag',
    description: 'Bring in new customers and reward the people who help.',
  };
  static models = [
    Referrer,
    ReferralProgram,
    Referral,
    Earner,
    Commission,
    CommissionPayout,
  ];
  static nav = [
    {
      label: 'Affiliates',
      model: Referrer,
      icon: 'users',
      description: 'The partners and customers who send people your way.',
      noun: 'affiliate',
    },
    {
      label: 'Programs',
      model: ReferralProgram,
      icon: 'layers',
      description: 'The offers that decide what a referral earns.',
      noun: 'program',
    },
    {
      label: 'Referrals',
      model: Referral,
      icon: 'repeat',
      description: 'Each person sent to you, and whether it led to a sale.',
    },
    {
      label: 'Commissions',
      model: Commission,
      icon: 'receipt',
      description: 'What each affiliate has earned and where it stands.',
    },
    {
      label: 'Payouts',
      model: CommissionPayout,
      icon: 'bank',
      description: 'Payments made to affiliates for what they earned.',
    },
  ];
  static options = {
    Referrer: {
      fields: {
        displayName: { label: 'Name', order: 1 },
        status: { order: 2 },
        profileId: { label: 'Person', visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        earnerId: { label: 'Payee', visibility: 'advanced' },
        metadata: { visibility: 'hidden' },
      },
    },
    ReferralProgram: {
      fields: {
        name: { order: 1 },
        key: { label: 'Short name', order: 2 },
        status: { order: 3 },
        defaultCommissionPlanKey: { visibility: 'advanced' },
        defaultAttributionPolicyKey: { visibility: 'advanced' },
        tenantId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    Referral: {
      fields: {
        referrerId: { label: 'Affiliate', order: 1 },
        programId: { label: 'Program', order: 2 },
        status: { order: 3 },
        tenantId: { visibility: 'hidden' },
        policyKey: { visibility: 'hidden' },
        policyVersion: { visibility: 'hidden' },
        targetKind: { visibility: 'advanced' },
        targetId: { visibility: 'advanced' },
        creditFraction: { visibility: 'advanced' },
        splitGroupId: { visibility: 'hidden' },
        primaryTouchId: { visibility: 'hidden' },
        attributedAt: { visibility: 'advanced' },
        qualifiedAt: { visibility: 'advanced' },
        expiresAt: { visibility: 'advanced' },
        snapshotId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    Earner: {
      fields: {
        displayName: { label: 'Name', order: 1 },
        status: { order: 2 },
        tenantId: { visibility: 'hidden' },
        kind: { visibility: 'advanced' },
        profileId: { visibility: 'advanced' },
        payoutMethod: { visibility: 'advanced' },
        payoutDestination: { visibility: 'advanced' },
        payoutThresholdCents: { visibility: 'advanced' },
        payoutScheduleKey: { visibility: 'advanced' },
        currency: { visibility: 'advanced' },
        metadata: { visibility: 'hidden' },
      },
    },
    Commission: {
      fields: {
        earnerId: { label: 'Affiliate', order: 1 },
        amountCents: { label: 'Amount', order: 2 },
        currency: { order: 3 },
        status: { order: 4 },
        tenantId: { visibility: 'hidden' },
        earningEventId: { visibility: 'hidden' },
        planKey: { visibility: 'advanced' },
        planVersion: { visibility: 'hidden' },
        componentKey: { visibility: 'hidden' },
        termsSnapshotKind: { visibility: 'hidden' },
        termsSnapshotId: { visibility: 'hidden' },
        basis: { visibility: 'advanced' },
        baseAmountCents: { visibility: 'advanced' },
        rate: { visibility: 'advanced' },
        shareFraction: { visibility: 'hidden' },
        splitGroupId: { visibility: 'hidden' },
        clearingEndsAt: { visibility: 'advanced' },
        earnedAt: { visibility: 'advanced' },
        approvedAt: { visibility: 'advanced' },
        payableAt: { visibility: 'advanced' },
        paidAt: { visibility: 'advanced' },
        payoutId: { visibility: 'advanced' },
        sourceKind: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        calculationTrace: { visibility: 'hidden' },
        dedupeKey: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
    CommissionPayout: {
      fields: {
        earnerId: { label: 'Affiliate', order: 1 },
        totalAmountCents: { label: 'Total', order: 2 },
        currency: { order: 3 },
        status: { order: 4 },
        paidAt: { order: 5 },
        tenantId: { visibility: 'hidden' },
        periodStart: { visibility: 'advanced' },
        periodEnd: { visibility: 'advanced' },
        commissionTotalCents: { visibility: 'advanced' },
        adjustmentTotalCents: { visibility: 'advanced' },
        payoutMethod: { visibility: 'advanced' },
        payoutDestination: { visibility: 'advanced' },
        paymentReference: { visibility: 'advanced' },
        providerRef: { visibility: 'hidden' },
        invoiceId: { visibility: 'hidden' },
        notes: { visibility: 'advanced' },
        idempotencyKey: { visibility: 'hidden' },
        sourceKind: { visibility: 'hidden' },
        sourceId: { visibility: 'hidden' },
        metadata: { visibility: 'hidden' },
      },
    },
  } as const;
}
