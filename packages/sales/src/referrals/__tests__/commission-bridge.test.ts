/**
 * ReferralCommissionService bridge tests — the #1932 acceptance surface:
 * a qualified referral + an EarningEvent produce Commissions with exact
 * integer-cents amounts THROUGH the frozen term snapshot; replays return
 * existing rows; plan amendments after qualification change nothing;
 * recurrence limits hold across events; splits flow credit fractions; and
 * missing earners / currency mismatches surface as typed skips.
 *
 * Real in-memory SQLite; commissions fixtures (Earner, CommissionPlan,
 * EarningEvent) come from the commissions module (same package).
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommissionCalculationService,
  CommissionCollection,
  CommissionPlanCollection,
  type CommissionPlanComponent,
  EarnerCollection,
  EarningEventCollection,
} from '../../commissions/index.js';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralAgreementCollection } from '../collections/ReferralAgreementCollection.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTermSnapshotCollection } from '../collections/ReferralTermSnapshotCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { Referrer } from '../models/Referrer.js';
import {
  REFERRAL_TERMS_SNAPSHOT_KIND,
  ReferralCommissionService,
} from '../services/ReferralCommissionService.js';
import { ReferralQualificationService } from '../services/ReferralQualificationService.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

const REV_SHARE_10: CommissionPlanComponent[] = [
  { key: 'rev-share', trigger: 'invoice_payment', basis: 'gross', rate: 0.1 },
];

describe('ReferralCommissionService (referrals → commissions bridge)', () => {
  let db: DatabaseInterface;
  let bridge: ReferralCommissionService;
  let qualification: ReferralQualificationService;
  let referrals: ReferralCollection;
  let snapshots: ReferralTermSnapshotCollection;
  let referrers: ReferrerCollection;
  let agreements: ReferralAgreementCollection;
  let plans: CommissionPlanCollection;
  let earners: EarnerCollection;
  let events: EarningEventCollection;
  let commissions: CommissionCollection;
  let programId: string;
  let eventCounter = 0;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    referrals = await ReferralCollection.create({ db });
    snapshots = await ReferralTermSnapshotCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    agreements = await ReferralAgreementCollection.create({ db });
    plans = await CommissionPlanCollection.create({ db });
    earners = await EarnerCollection.create({ db });
    events = await EarningEventCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    const policies = await AttributionPolicyCollection.create({ db });
    bridge = new ReferralCommissionService({
      referrals,
      snapshots,
      referrers,
      calculation: new CommissionCalculationService(commissions),
      commissions,
    });
    qualification = new ReferralQualificationService({
      referrals,
      agreements,
      plans,
      policies,
      snapshots,
      referrers,
    });

    const programs = await ReferralProgramCollection.create({ db });
    programId =
      (await programs.create({ key: 'partners', name: 'Partner program' }))
        .id ?? '';
    eventCounter = 0;
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function makeReferrerWithEarner(profileId: string): Promise<Referrer> {
    const earner = await earners.create({
      profileId,
      displayName: `Earner ${profileId}`,
      status: 'active',
    });
    return await referrers.create({
      profileId,
      earnerId: earner.id ?? '',
      displayName: `Referrer ${profileId}`,
      status: 'active',
    });
  }

  /** Full path to a qualified referral: plan + agreement + attribution + snapshot. */
  async function makeQualifiedReferral(params: {
    referrer: Referrer;
    planKey?: string;
    components?: CommissionPlanComponent[];
    clearingDays?: number;
    targetId?: string;
    creditFraction?: number;
    splitGroupId?: string;
  }) {
    const planKey = params.planKey ?? 'referral-standard';
    const existingPlan = await plans.latestActiveByKey(planKey);
    if (!existingPlan) {
      await plans.create({
        planKey,
        version: 1,
        status: 'active',
        currency: 'USD',
        components: JSON.stringify(params.components ?? REV_SHARE_10),
      });
    }
    await agreements.create({
      referrerId: params.referrer.id ?? '',
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: planKey,
      commissionPlanVersion: 0,
      clearingDays: params.clearingDays ?? 30,
      approvalMode: 'manual',
    });
    const referral = await referrals.create({
      referrerId: params.referrer.id ?? '',
      programId,
      targetKind: 'client',
      targetId: params.targetId ?? 'client-1',
      policyKey: 'standard',
      policyVersion: 1,
      creditFraction: params.creditFraction ?? 1.0,
      splitGroupId: params.splitGroupId ?? '',
      status: 'pending',
    });
    referral.markAttributed(NOW);
    await referral.save();
    const result = await qualification.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    if (!result.qualified || !result.snapshot) {
      throw new Error(`fixture failed to qualify: ${result.reason}`);
    }
    return { referral, snapshot: result.snapshot };
  }

  async function makeEvent(overrides: Record<string, unknown> = {}) {
    eventCounter += 1;
    return await events.create({
      eventKind: 'invoice_payment',
      occurredAt: new Date('2026-07-01T00:00:00Z'),
      sourceKind: 'invoice',
      sourceId: `inv-${eventCounter}`,
      grossAmountCents: 123_456,
      currency: 'USD',
      dedupeKey: `evt-${eventCounter}`,
      ...overrides,
    });
  }

  it('tracer (#1932): invoice payment → exact commission through the frozen snapshot', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    const { referral, snapshot } = await makeQualifiedReferral({ referrer });
    const event = await makeEvent(); // gross 123_456, USD

    const result = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-1',
    });

    expect(result.skippedReferrals).toEqual([]);
    expect(result.results).toHaveLength(1);
    const outcome = result.results[0];
    expect(outcome.referralId).toBe(referral.id);
    expect(outcome.skipped).toEqual([]);
    expect(outcome.existing).toEqual([]);
    expect(outcome.created).toHaveLength(1);

    const commission = outcome.created[0];
    // 123456 * 0.1 = 12345.6 → 12346 (half away from zero, once).
    expect(commission.amountCents).toBe(12_346);
    expect(commission.baseAmountCents).toBe(123_456);
    expect(commission.rate).toBe(0.1);
    expect(commission.shareFraction).toBe(1.0);
    expect(commission.currency).toBe('USD');
    expect(commission.status).toBe('pending');
    expect(commission.planKey).toBe('referral-standard');
    expect(commission.planVersion).toBe(1);
    expect(commission.termsSnapshotKind).toBe(REFERRAL_TERMS_SNAPSHOT_KIND);
    expect(commission.termsSnapshotId).toBe(snapshot.id);
    expect(commission.dedupeKey).toBe(
      `${event.dedupeKey}:${snapshot.id}:rev-share:${referrer.earnerId}:0`,
    );
    // Clearing window comes from the snapshot's agreement copy (30 days).
    expect(commission.clearingEndsAt?.toISOString()).toBe(
      new Date(event.occurredAt.getTime() + 30 * DAY).toISOString(),
    );
    expect(commission.earnerId).toBe(referrer.earnerId);
  });

  it('replays idempotently: the same event returns existing, never duplicates', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    await makeQualifiedReferral({ referrer });
    const event = await makeEvent();

    const first = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-1',
    });
    const replay = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-1',
    });

    expect(replay.results[0].created).toHaveLength(0);
    expect(replay.results[0].existing).toHaveLength(1);
    expect(replay.results[0].existing[0].id).toBe(
      first.results[0].created[0].id,
    );
    expect(await commissions.findByEvent(event.id ?? '')).toHaveLength(1);
  });

  it('reproducibility: a plan amendment after qualification never changes calculations', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    await makeQualifiedReferral({ referrer });
    const firstEvent = await makeEvent();
    const first = await bridge.processEarningEvent({
      event: firstEvent,
      targetKind: 'client',
      targetId: 'client-1',
    });
    expect(first.results[0].created[0].amountCents).toBe(12_346);

    // Amend the plan to 50% and make v2 the governing version.
    const v1 = await plans.latestActiveByKey('referral-standard');
    if (!v1) throw new Error('expected plan');
    const v2 = await plans.createAmendment('referral-standard', {
      components: [
        {
          key: 'rev-share',
          trigger: 'invoice_payment',
          basis: 'gross',
          rate: 0.5,
        },
      ],
    });
    v2.activate();
    await v2.save();
    v1.supersede();
    await v1.save();

    // Replay of the first event: still the existing 10% row.
    const replay = await bridge.processEarningEvent({
      event: firstEvent,
      targetKind: 'client',
      targetId: 'client-1',
    });
    expect(replay.results[0].existing[0].amountCents).toBe(12_346);
    expect(replay.results[0].created).toHaveLength(0);

    // A NEW event still calculates at the OLD frozen 10% terms.
    const nextEvent = await makeEvent({ grossAmountCents: 100_000 });
    const next = await bridge.processEarningEvent({
      event: nextEvent,
      targetKind: 'client',
      targetId: 'client-1',
    });
    expect(next.results[0].created[0].amountCents).toBe(10_000); // not 50_000
    expect(next.results[0].created[0].planVersion).toBe(1);
  });

  it('honors recurring maxOccurrences across events via the occurrence resolver', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    await makeQualifiedReferral({
      referrer,
      planKey: 'residual-capped',
      components: [
        {
          key: 'residual',
          trigger: 'invoice_payment',
          basis: 'gross',
          rate: 0.05,
          recurrence: { kind: 'recurring', maxOccurrences: 2 },
        },
      ],
    });

    const run = async () =>
      await bridge.processEarningEvent({
        event: await makeEvent({ grossAmountCents: 10_000 }),
        targetKind: 'client',
        targetId: 'client-1',
      });

    const first = await run();
    expect(first.results[0].created).toHaveLength(1);
    expect(
      first.results[0].created[0].getCalculationTrace()?.occurrenceIndex,
    ).toBe(0);

    const second = await run();
    expect(second.results[0].created).toHaveLength(1);
    expect(
      second.results[0].created[0].getCalculationTrace()?.occurrenceIndex,
    ).toBe(1);

    const third = await run();
    expect(third.results[0].created).toHaveLength(0);
    expect(third.results[0].skipped).toEqual([
      { componentKey: 'residual', reason: 'occurrence_limit_reached' },
    ]);
  });

  it('splits: sibling referrals flow their credit fractions into commissions', async () => {
    const opener = await makeReferrerWithEarner('profile-opener');
    const closer = await makeReferrerWithEarner('profile-closer');
    await makeQualifiedReferral({
      referrer: opener,
      creditFraction: 0.6,
      splitGroupId: 'split-x',
      targetId: 'client-split',
    });
    await makeQualifiedReferral({
      referrer: closer,
      creditFraction: 0.4,
      splitGroupId: 'split-x',
      targetId: 'client-split',
    });

    const event = await makeEvent(); // gross 123_456
    const result = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-split',
    });

    expect(result.results).toHaveLength(2);
    const amounts = result.results.map((r) => r.created[0].amountCents);
    // 12345.6 * 0.6 = 7407.36 → 7407; * 0.4 = 4938.24 → 4938.
    expect(amounts).toEqual([7_407, 4_938]);
    expect(amounts[0] + amounts[1]).toBe(12_345);
    for (const outcome of result.results) {
      expect(outcome.created[0].splitGroupId).toBe('split-x');
    }
    const shares = result.results.map((r) => r.created[0].shareFraction);
    expect(shares[0]).toBeCloseTo(0.6);
    expect(shares[1]).toBeCloseTo(0.4);
  });

  it('skips referrals whose referrer has no earner', async () => {
    const noEarner = await referrers.create({
      profileId: 'profile-unbanked',
      displayName: 'No payout account yet',
      status: 'active',
    });
    const { referral } = await makeQualifiedReferral({
      referrer: noEarner,
      targetId: 'client-unbanked',
    });

    const result = await bridge.processEarningEvent({
      event: await makeEvent(),
      targetKind: 'client',
      targetId: 'client-unbanked',
    });
    expect(result.results).toEqual([]);
    expect(result.skippedReferrals).toEqual([
      { referralId: referral.id, reason: 'referrer_missing_earner' },
    ]);
  });

  it('surfaces the calculation service currency_mismatch skip', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    await makeQualifiedReferral({ referrer }); // snapshot currency USD
    const event = await makeEvent({ currency: 'EUR' });

    const result = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-1',
    });
    expect(result.results[0].created).toHaveLength(0);
    expect(result.results[0].skipped).toEqual([
      { componentKey: 'rev-share', reason: 'currency_mismatch' },
    ]);
  });

  it('resolves explicit referralIds and reports non-processable ids', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    const { referral } = await makeQualifiedReferral({ referrer });
    const pending = await referrals.create({
      referrerId: referrer.id ?? '',
      programId,
      targetKind: 'client',
      targetId: 'client-other',
      status: 'pending',
    });

    const result = await bridge.processEarningEvent({
      event: await makeEvent(),
      referralIds: [
        referral.id ?? '',
        pending.id ?? '',
        '00000000-0000-4000-8000-000000000000',
      ],
    });

    expect(result.results).toHaveLength(1);
    expect(result.results[0].referralId).toBe(referral.id);
    expect(result.results[0].created).toHaveLength(1);
    expect(result.skippedReferrals).toEqual([
      { referralId: pending.id, reason: 'not_qualified' },
      {
        referralId: '00000000-0000-4000-8000-000000000000',
        reason: 'referral_not_found',
      },
    ]);
  });

  it('requires a persisted event and a referral selector', async () => {
    const referrer = await makeReferrerWithEarner('profile-jordan');
    await makeQualifiedReferral({ referrer });
    await expect(
      bridge.processEarningEvent({ event: await makeEvent() }),
    ).rejects.toThrow(/requires referralIds or a \(targetKind, targetId\)/);
  });
});
