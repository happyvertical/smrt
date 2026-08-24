/**
 * Cross-module integration: the #1932 reproducibility corners — rounding
 * (half away from zero, applied exactly once), byte-identical replay,
 * split-credit conservation with documented per-sibling rounding, currency
 * mismatch surfacing, the self-referral eligibility gate, and audited
 * attribution overrides (including the qualified-referral refusal).
 *
 * Real in-memory SQLite via the smrt-vitest plugin; explicit `now` /
 * `occurredAt` fixtures everywhere so every cent is deterministic.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommissionCalculationService,
  type CommissionCalculationTrace,
  CommissionCollection,
  CommissionPlanCollection,
  type CommissionPlanComponent,
  calculateCommissionAmountCents,
  EarnerCollection,
  EarningEventCollection,
  roundCents,
} from '../commissions/index.js';
import {
  AttributionExceptionCollection,
  AttributionPolicyCollection,
  AttributionService,
  QualifiedReferralOverrideError,
  type Referral,
  ReferralAgreementCollection,
  ReferralCollection,
  ReferralCommissionService,
  ReferralProgramCollection,
  ReferralQualificationService,
  ReferralTermSnapshotCollection,
  ReferralTouchCollection,
  type Referrer,
  ReferrerCollection,
} from '../referrals/index.js';
import { seedAgreementEvidence } from '../test-fixtures.js';

const NOW = new Date('2026-07-01T00:00:00Z');
const EVENT_AT = new Date('2026-07-02T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

/** Recompute an amount from its trace under the documented semantics. */
function recomputeFromTrace(trace: CommissionCalculationTrace): number {
  return trace.basis === 'fixed'
    ? roundCents(trace.baseAmountCents * trace.shareFraction)
    : calculateCommissionAmountCents(
        trace.baseAmountCents,
        trace.rate,
        trace.shareFraction,
      );
}

describe('rounding, currency, splits, and attribution gates (#1932)', () => {
  let db: DatabaseInterface;
  let earners: EarnerCollection;
  let plans: CommissionPlanCollection;
  let events: EarningEventCollection;
  let commissions: CommissionCollection;
  let referrers: ReferrerCollection;
  let programs: ReferralProgramCollection;
  let policies: AttributionPolicyCollection;
  let touches: ReferralTouchCollection;
  let referrals: ReferralCollection;
  let agreements: ReferralAgreementCollection;
  let snapshots: ReferralTermSnapshotCollection;
  let exceptions: AttributionExceptionCollection;
  let attribution: AttributionService;
  let qualification: ReferralQualificationService;
  let bridge: ReferralCommissionService;
  let programId: string;
  let eventCounter = 0;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    await seedAgreementEvidence(
      db,
      'test-agreement-execution',
      'test-executed-agreement',
    );
    earners = await EarnerCollection.create({ db });
    plans = await CommissionPlanCollection.create({ db });
    events = await EarningEventCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    programs = await ReferralProgramCollection.create({ db });
    policies = await AttributionPolicyCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    referrals = await ReferralCollection.create({ db });
    agreements = await ReferralAgreementCollection.create({ db });
    snapshots = await ReferralTermSnapshotCollection.create({ db });
    exceptions = await AttributionExceptionCollection.create({ db });

    attribution = new AttributionService({
      touches,
      referrals,
      exceptions,
      policies,
      programs,
      referrers,
    });
    qualification = new ReferralQualificationService({
      referrals,
      agreements,
      plans,
      policies,
      snapshots,
      referrers,
    });
    bridge = new ReferralCommissionService({
      referrals,
      snapshots,
      referrers,
      calculation: new CommissionCalculationService(commissions),
      commissions,
    });

    programId =
      (
        await programs.create({
          key: 'rcs-partners',
          name: 'Rounding/currency/splits program',
          status: 'active',
        })
      ).id ?? '';
    eventCounter = 0;
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  // -------- Fixture helpers --------

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

  async function makeActivePlan(
    planKey: string,
    components: CommissionPlanComponent[],
    currency = 'USD',
  ) {
    return await plans.create({
      planKey,
      version: 1,
      status: 'active',
      currency,
      components: JSON.stringify(components),
    });
  }

  async function makeActiveAgreement(referrerId: string, planKey: string) {
    return await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: planKey,
      commissionPlanVersion: 0,
      clearingDays: 0,
      approvalMode: 'auto',
      executionId: 'test-agreement-execution',
      executedAgreementId: 'test-executed-agreement',
    });
  }

  /** Directly attributed referral (no touch ceremony) qualified at NOW. */
  async function makeQualifiedReferral(params: {
    referrer: Referrer;
    planKey: string;
    targetId: string;
  }): Promise<Referral> {
    await makeActiveAgreement(params.referrer.id ?? '', params.planKey);
    const referral = await referrals.create({
      referrerId: params.referrer.id ?? '',
      programId,
      targetKind: 'client',
      targetId: params.targetId,
      status: 'pending',
    });
    referral.markAttributed(NOW);
    await referral.save();
    const result = await qualification.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    if (!result.qualified) {
      throw new Error(`fixture failed to qualify: ${result.reason}`);
    }
    return referral;
  }

  async function makeInvoiceEvent(overrides: Record<string, unknown> = {}) {
    eventCounter += 1;
    return await events.create({
      eventKind: 'invoice_payment',
      occurredAt: EVENT_AT,
      sourceKind: 'invoice',
      sourceId: `inv-${eventCounter}`,
      grossAmountCents: 0,
      currency: 'USD',
      dedupeKey: `rcs-evt-${eventCounter}`,
      ...overrides,
    });
  }

  // -------- Rounding reproducibility --------

  it('money helpers round half away from zero, symmetrically', () => {
    expect(roundCents(2.5)).toBe(3);
    expect(roundCents(-2.5)).toBe(-3);
    expect(roundCents(0)).toBe(0);
    // 33_333 × 0.1 = 3_333.3 → 3_333 (round down: below the half).
    expect(calculateCommissionAmountCents(33_333, 0.1)).toBe(3_333);
    // 12_345 × 0.335 = 4_135.575 → 4_136 (half rounds away from zero).
    expect(calculateCommissionAmountCents(12_345, 0.335)).toBe(4_136);
  });

  it('gross 33,333 at 10% stores 3,333 with a reproducing trace; replays are byte-identical', async () => {
    const referrer = await makeReferrerWithEarner('profile-round-10');
    await makeActivePlan('round-10', [
      { key: 'rev', trigger: 'invoice_payment', basis: 'gross', rate: 0.1 },
    ]);
    await makeQualifiedReferral({
      referrer,
      planKey: 'round-10',
      targetId: 'client-round-10',
    });
    const event = await makeInvoiceEvent({ grossAmountCents: 33_333 });

    const run = () =>
      bridge.processEarningEvent({
        event,
        targetKind: 'client',
        targetId: 'client-round-10',
      });

    const firstRun = await run();
    const commission = firstRun.results[0].created[0];
    expect(commission.amountCents).toBe(3_333);
    expect(commission.baseAmountCents).toBe(33_333);
    expect(commission.rate).toBe(0.1);
    const trace = commission.getCalculationTrace();
    if (!trace) throw new Error('expected calculation trace');
    expect(trace.roundingMode).toBe('half_away_from_zero');
    expect(recomputeFromTrace(trace)).toBe(3_333);

    // Running the same calculation again is a pure replay: the identical
    // row comes back with a byte-equal persisted trace, and no second row.
    const secondRun = await run();
    expect(secondRun.results[0].created).toHaveLength(0);
    expect(secondRun.results[0].existing).toHaveLength(1);
    const replayed = secondRun.results[0].existing[0];
    expect(replayed.id).toBe(commission.id);
    expect(replayed.amountCents).toBe(commission.amountCents);
    expect(replayed.calculationTrace).toBe(commission.calculationTrace);
    expect(await commissions.findByEvent(event.id ?? '')).toHaveLength(1);
  });

  it('gross 12,345 at 33.5% stores exactly what calculateCommissionAmountCents reproduces (4,136)', async () => {
    const referrer = await makeReferrerWithEarner('profile-round-335');
    await makeActivePlan('round-335', [
      { key: 'rev', trigger: 'invoice_payment', basis: 'gross', rate: 0.335 },
    ]);
    await makeQualifiedReferral({
      referrer,
      planKey: 'round-335',
      targetId: 'client-round-335',
    });
    const event = await makeInvoiceEvent({ grossAmountCents: 12_345 });

    const result = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-round-335',
    });
    const commission = result.results[0].created[0];
    const trace = commission.getCalculationTrace();
    if (!trace) throw new Error('expected calculation trace');

    // The stored amount, the trace recompute, and the exported helper all
    // agree — rounding happened exactly once, on the final product.
    const expected = calculateCommissionAmountCents(12_345, 0.335, 1);
    expect(expected).toBe(4_136);
    expect(commission.amountCents).toBe(expected);
    expect(recomputeFromTrace(trace)).toBe(expected);
    expect(trace.baseAmountCents).toBe(12_345);
    expect(trace.rate).toBe(0.335);
    expect(trace.shareFraction).toBe(1);
  });

  // -------- Split credit --------

  it('split mode: sibling referrals share credit, and per-sibling rounding reconciles against the unsplit amount', async () => {
    const opener = await makeReferrerWithEarner('profile-opener');
    const closer = await makeReferrerWithEarner('profile-closer');
    await policies.create({
      policyKey: 'split-pol',
      version: 1,
      status: 'active',
      windowDays: 30,
      creditMode: 'split',
      conflictBehavior: 'auto',
    });

    // Two touches from distinct referrers inside the window.
    await touches.create({
      referrerId: opener.id ?? '',
      programId,
      kind: 'click',
      subjectKind: 'client',
      subjectId: 'client-split',
      occurredAt: new Date(NOW.getTime() - 5 * DAY),
    });
    await touches.create({
      referrerId: closer.id ?? '',
      programId,
      kind: 'click',
      subjectKind: 'client',
      subjectId: 'client-split',
      occurredAt: new Date(NOW.getTime() - 2 * DAY),
    });

    const resolution = await attribution.resolve({
      targetKind: 'client',
      targetId: 'client-split',
      programId,
      policyKey: 'split-pol',
      now: NOW,
    });
    expect(resolution.exception).toBeNull();
    expect(resolution.referrals).toHaveLength(2);
    const fractions = resolution.referrals.map((r) => r.creditFraction);
    expect(fractions).toEqual([0.5, 0.5]);
    expect(fractions.reduce((sum, f) => sum + f, 0)).toBe(1.0);
    const groupIds = new Set(resolution.referrals.map((r) => r.splitGroupId));
    expect(groupIds.size).toBe(1);
    const splitGroupId = [...groupIds][0];
    expect(splitGroupId).not.toBe('');

    // Each sibling qualifies under their own agreement, same plan.
    await makeActivePlan('split-plan', [
      { key: 'rev', trigger: 'invoice_payment', basis: 'gross', rate: 0.1 },
    ]);
    for (const referral of resolution.referrals) {
      await makeActiveAgreement(referral.referrerId, 'split-plan');
      const result = await qualification.qualify({
        referralId: referral.id ?? '',
        now: NOW,
      });
      expect(result.qualified).toBe(true);
    }

    // One earning event pays both siblings through their share fractions.
    // 123_446 × 0.1 = 12_344.6 → unsplit 12_345; per sibling
    // 123_446 × 0.1 × 0.5 = 6_172.3 → 6_172 each (documented per-sibling
    // rounding: siblings round independently, drift ≤ 1 cent per sibling).
    const event = await makeInvoiceEvent({ grossAmountCents: 123_446 });
    const result = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-split',
    });
    expect(result.skippedReferrals).toEqual([]);
    expect(result.results).toHaveLength(2);

    const expectedPerSibling = calculateCommissionAmountCents(
      123_446,
      0.1,
      0.5,
    );
    expect(expectedPerSibling).toBe(6_172);
    const created = result.results.map((outcome) => outcome.created[0]);
    for (const commission of created) {
      expect(commission.amountCents).toBe(expectedPerSibling);
      expect(commission.shareFraction).toBe(0.5);
      expect(commission.splitGroupId).toBe(splitGroupId);
      const trace = commission.getCalculationTrace();
      if (!trace) throw new Error('expected calculation trace');
      expect(recomputeFromTrace(trace)).toBe(commission.amountCents);
    }
    // Both earner accounts got their own row.
    expect(new Set(created.map((c) => c.earnerId)).size).toBe(2);

    const unsplit = calculateCommissionAmountCents(123_446, 0.1, 1);
    expect(unsplit).toBe(12_345);
    const sum = created.reduce((total, c) => total + c.amountCents, 0);
    expect(sum).toBe(12_344);
    expect(sum).toBeLessThanOrEqual(unsplit);
    expect(unsplit - sum).toBeLessThanOrEqual(created.length); // ≤1¢/sibling
  });

  // -------- Currency --------

  it('a currency mismatch between the frozen terms and the event surfaces as a typed skip', async () => {
    const referrer = await makeReferrerWithEarner('profile-currency');
    await makeActivePlan(
      'usd-plan',
      [{ key: 'rev', trigger: 'invoice_payment', basis: 'gross', rate: 0.1 }],
      'USD',
    );
    await makeQualifiedReferral({
      referrer,
      planKey: 'usd-plan',
      targetId: 'client-cad',
    });

    // The event settles in CAD; the snapshot froze USD — no FX, no row.
    const event = await makeInvoiceEvent({
      grossAmountCents: 123_456,
      currency: 'CAD',
    });
    const result = await bridge.processEarningEvent({
      event,
      targetKind: 'client',
      targetId: 'client-cad',
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0].created).toHaveLength(0);
    expect(result.results[0].existing).toHaveLength(0);
    expect(result.results[0].skipped).toEqual([
      { componentKey: 'rev', reason: 'currency_mismatch' },
    ]);
    expect(await commissions.findByEvent(event.id ?? '')).toHaveLength(0);
  });

  // -------- Self-referral gate --------

  it('drops a click whose referrer IS the prospect when the policy disallows self-referrals', async () => {
    const selfish = await makeReferrerWithEarner('profile-selfish');
    await policies.create({
      policyKey: 'no-self',
      version: 1,
      status: 'active',
      windowDays: 30,
      creditMode: 'first_touch',
      conflictBehavior: 'auto',
      allowSelfReferral: false,
    });
    await touches.create({
      referrerId: selfish.id ?? '',
      programId,
      kind: 'click',
      subjectKind: 'lead',
      subjectId: 'lead-self',
      occurredAt: new Date(NOW.getTime() - 1 * DAY),
    });

    const result = await attribution.resolve({
      targetKind: 'lead',
      targetId: 'lead-self',
      programId,
      policyKey: 'no-self',
      subjectProfileId: 'profile-selfish', // the prospect IS the referrer
      now: NOW,
    });
    expect(result.referrals).toHaveLength(0);
    expect(result.exception).toBeNull();
    expect(result.refused).toBe('no_eligible_touches');
    expect(await referrals.findByTarget('lead', 'lead-self')).toHaveLength(0);
  });

  // -------- Override audit --------

  it('override: requires a reason, disqualifies displaced credit with a resolved audit row, and refuses qualified referrals', async () => {
    const alice = await makeReferrerWithEarner('profile-alice');
    const bob = await makeReferrerWithEarner('profile-bob');
    await policies.create({
      policyKey: 'override-pol',
      version: 1,
      status: 'active',
      windowDays: 30,
      creditMode: 'first_touch',
      conflictBehavior: 'auto',
    });
    await touches.create({
      referrerId: alice.id ?? '',
      programId,
      kind: 'click',
      subjectKind: 'lead',
      subjectId: 'lead-ov',
      occurredAt: new Date(NOW.getTime() - 3 * DAY),
    });
    const original = await attribution.resolve({
      targetKind: 'lead',
      targetId: 'lead-ov',
      programId,
      policyKey: 'override-pol',
      now: NOW,
    });
    const displacedId = original.referrals[0].id ?? '';

    // Overrides are audited: an empty reason is rejected before anything moves.
    await expect(
      attribution.override({
        targetKind: 'lead',
        targetId: 'lead-ov',
        programId,
        awards: [{ referrerId: bob.id ?? '', creditFraction: 1 }],
        resolutionReason: '   ',
        actorProfileId: 'profile-ops',
        now: NOW,
      }),
    ).rejects.toThrow(/non-empty resolutionReason/);
    expect((await referrals.get({ id: displacedId }))?.status).toBe(
      'attributed',
    );

    // A reasoned override re-decides WHO earned the introduction.
    const { referrals: awarded, exception } = await attribution.override({
      targetKind: 'lead',
      targetId: 'lead-ov',
      programId,
      awards: [{ referrerId: bob.id ?? '', creditFraction: 1 }],
      resolutionReason: 'partner desk correction: Bob made the intro',
      actorProfileId: 'profile-ops',
      now: NOW,
    });
    expect(awarded).toHaveLength(1);
    expect(awarded[0].referrerId).toBe(bob.id);
    expect(awarded[0].status).toBe('attributed');
    // The displaced credit is disqualified and points at its audit record.
    const displaced = await referrals.get({ id: displacedId });
    expect(displaced?.status).toBe('disqualified');
    expect(displaced?.getMetadata().overriddenByExceptionId).toBe(exception.id);
    // The audit exception is resolved, reasoned, and names the new credit.
    expect(exception.status).toBe('resolved');
    expect(exception.conflictReason).toBe('override');
    expect(exception.resolutionReason).toBe(
      'partner desk correction: Bob made the intro',
    );
    expect(exception.resolvedByProfileId).toBe('profile-ops');
    expect(exception.getResolvedReferralIds()).toEqual([awarded[0].id ?? '']);
    const persistedException = await exceptions.get({ id: exception.id });
    expect(persistedException?.status).toBe('resolved');

    // QUALIFIED referrals are governed by their term snapshots downstream —
    // re-attribution refuses rather than orphaning agreed terms.
    await makeActivePlan('override-plan', [
      { key: 'rev', trigger: 'invoice_payment', basis: 'gross', rate: 0.1 },
    ]);
    await makeQualifiedReferral({
      referrer: alice,
      planKey: 'override-plan',
      targetId: 'client-qualified',
    });
    await expect(
      attribution.override({
        targetKind: 'client',
        targetId: 'client-qualified',
        programId,
        awards: [{ referrerId: bob.id ?? '', creditFraction: 1 }],
        resolutionReason: 'attempted rewrite of qualified credit',
        actorProfileId: 'profile-ops',
        now: NOW,
      }),
    ).rejects.toThrow(QualifiedReferralOverrideError);
  });
});
