/**
 * Cross-module end-to-end epic tracer (#1935): "One referred Opportunity
 * closes and produces an explainable payable Commission under immutable
 * snapshotted terms" — plus the settlement acceptance of #1933 and the
 * reproducibility/idempotency acceptance of #1932.
 *
 * ONE coherent journey across all three modules, told as sequential stages
 * over one shared database (real in-memory SQLite, no mocks):
 *
 *   referral link → click evidence → Lead → attribution → CRM pipeline to
 *   closed_won → conversion → qualification (frozen term snapshot) →
 *   earning events → Commissions (traced, deduped, amendment-proof,
 *   recurrence-capped) → clearing sweep → approval → payable → adjustment →
 *   payout batch → paid — and finally the Referrer-facing explanation
 *   assembled from collections/services alone.
 *
 * Every stage passes explicit `now`/`occurredAt` Date fixtures wherever the
 * APIs accept them, so all monetary and timestamp assertions are
 * deterministic.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  type Commission,
  CommissionAdjustmentCollection,
  CommissionBalanceService,
  CommissionCalculationService,
  type CommissionCalculationTrace,
  CommissionCollection,
  type CommissionPayout,
  CommissionPayoutCollection,
  CommissionPayoutService,
  CommissionPlanCollection,
  type CommissionPlanComponent,
  CommissionSettlementService,
  calculateCommissionAmountCents,
  type Earner,
  EarnerCollection,
  type EarningEvent,
  EarningEventCollection,
  roundCents,
} from '../commissions/index.js';
import {
  type Lead,
  LeadCollection,
  type Opportunity,
  OpportunityCollection,
  OpportunityConversionCollection,
  PipelineDefinitionCollection,
  type PipelineStage,
  SalesActivityCollection,
  SalesRepresentativeCollection,
} from '../crm/index.js';
import {
  AttributionExceptionCollection,
  AttributionPolicyCollection,
  AttributionService,
  REFERRAL_TERMS_SNAPSHOT_KIND,
  type Referral,
  type ReferralAgreement,
  ReferralAgreementCollection,
  ReferralCollection,
  ReferralCommissionService,
  type ReferralLink,
  ReferralLinkCollection,
  ReferralProgramCollection,
  ReferralQualificationService,
  type ReferralTermSnapshot,
  ReferralTermSnapshotCollection,
  type ReferralTouch,
  ReferralTouchCollection,
  type Referrer,
  ReferrerCollection,
} from '../referrals/index.js';

/** First element or throw — keeps fixture wiring honest. */
function first<T>(rows: T[]): T {
  const row = rows[0];
  if (!row) throw new Error('expected at least one row');
  return row;
}

const DAY = 24 * 60 * 60 * 1000;

// -- Frozen clock fixtures (every stage passes these explicitly) ------------
const CLICK_AT = new Date('2026-07-01T00:00:00Z');
const ATTRIBUTED_AT = new Date('2026-07-02T00:00:00Z');
const QUALIFIED_AT = new Date('2026-07-03T00:00:00Z');
const CONVERTED_AT = new Date('2026-07-05T00:00:00Z');
const INVOICE_1_AT = new Date('2026-07-06T00:00:00Z');
const INVOICE_2_AT = new Date('2026-07-07T00:00:00Z');
const INVOICE_3_AT = new Date('2026-07-08T00:00:00Z');
/** Past every clearingEndsAt (latest is INVOICE_2_AT + 7d = 2026-07-14). */
const SWEEP_AT = new Date('2026-07-20T00:00:00Z');
const APPROVED_AT = new Date('2026-07-20T01:00:00Z');
const PAYABLE_AT = new Date('2026-07-20T02:00:00Z');
const BATCHED_AT = new Date('2026-07-21T00:00:00Z');
const PAID_AT = new Date('2026-07-22T00:00:00Z');

// -- Terms fixtures ---------------------------------------------------------
const PROGRAM_KEY = 'tracer-partners';
const POLICY_KEY = 'tracer-first-touch';
const PLAN_KEY = 'tracer-referral-plan';
const CLEARING_DAYS = 7;
const INTRO_BONUS_CENTS = 5_000;
const PLAN_V1_COMPONENTS: CommissionPlanComponent[] = [
  {
    key: 'intro_bonus',
    trigger: 'conversion',
    basis: 'fixed',
    fixedAmountCents: INTRO_BONUS_CENTS,
  },
  {
    key: 'revenue_share',
    trigger: 'invoice_payment',
    basis: 'gross',
    rate: 0.1,
    recurrence: { kind: 'recurring', maxOccurrences: 2 },
  },
];

// -- The exact money math the epic PR can quote -----------------------------
// intro_bonus:      fixed 5_000 on conversion
// revenue_share #1: 123_456 × 0.1 = 12_345.6 → 12_346 (half away from zero)
// revenue_share #2: 100_000 × 0.1 = 10_000
// revenue_share #3: skipped — maxOccurrences 2 reached
// payable:          5_000 + 12_346 + 10_000 = 27_346
// refund:           -2_000 → net payable 25_346
const INVOICE_1_GROSS = 123_456;
const REV_SHARE_1 = 12_346;
const INVOICE_2_GROSS = 100_000;
const REV_SHARE_2 = 10_000;
const PAYABLE_TOTAL = INTRO_BONUS_CENTS + REV_SHARE_1 + REV_SHARE_2; // 27_346
const REFUND_CENTS = -2_000;
const NET_PAYABLE = PAYABLE_TOTAL + REFUND_CENTS; // 25_346

/**
 * Reproduce a commission amount from its persisted trace, following the
 * documented calculation semantics: `fixed` applies only the share fraction;
 * every other basis applies rate × share. Rounding happens exactly once.
 */
function recomputeFromTrace(trace: CommissionCalculationTrace): number {
  return trace.basis === 'fixed'
    ? roundCents(trace.baseAmountCents * trace.shareFraction)
    : calculateCommissionAmountCents(
        trace.baseAmountCents,
        trace.rate,
        trace.shareFraction,
      );
}

describe('epic tracer (#1935): referred Opportunity → explainable payable Commission', () => {
  let db: DatabaseInterface;

  // Collections (shared DB connection).
  let earners: EarnerCollection;
  let plans: CommissionPlanCollection;
  let events: EarningEventCollection;
  let commissions: CommissionCollection;
  let adjustments: CommissionAdjustmentCollection;
  let payouts: CommissionPayoutCollection;
  let leads: LeadCollection;
  let opportunities: OpportunityCollection;
  let conversions: OpportunityConversionCollection;
  let pipelines: PipelineDefinitionCollection;
  let activities: SalesActivityCollection;
  let reps: SalesRepresentativeCollection;
  let referrers: ReferrerCollection;
  let programs: ReferralProgramCollection;
  let policies: AttributionPolicyCollection;
  let links: ReferralLinkCollection;
  let touches: ReferralTouchCollection;
  let referrals: ReferralCollection;
  let agreements: ReferralAgreementCollection;
  let snapshots: ReferralTermSnapshotCollection;

  // Services.
  let attribution: AttributionService;
  let qualification: ReferralQualificationService;
  let bridge: ReferralCommissionService;
  let settlement: CommissionSettlementService;
  let balances: CommissionBalanceService;
  let payoutService: CommissionPayoutService;

  // Journey state accumulated across stages.
  let referrer: Referrer;
  let referrerEarner: Earner;
  let repEarner: Earner;
  let programId: string;
  let agreement: ReferralAgreement;
  let stagesByKey: Map<string, PipelineStage>;
  let link: ReferralLink;
  let identifiedTouch: ReferralTouch;
  let lead: Lead;
  let referral: Referral;
  let opportunity: Opportunity;
  let snapshot: ReferralTermSnapshot;
  let conversionEvent: EarningEvent;
  let invoice1Event: EarningEvent;
  let introCommission: Commission;
  let revShare1: Commission;
  let revShare2: Commission;
  let revShare1BeforeAdjustment: Record<string, unknown>;
  let payout: CommissionPayout;
  const clientId = 'client-anytown-1';

  beforeAll(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });

    earners = await EarnerCollection.create({ db });
    plans = await CommissionPlanCollection.create({ db });
    events = await EarningEventCollection.create({ db });
    commissions = await CommissionCollection.create({ db });
    adjustments = await CommissionAdjustmentCollection.create({ db });
    payouts = await CommissionPayoutCollection.create({ db });
    leads = await LeadCollection.create({ db });
    opportunities = await OpportunityCollection.create({ db });
    conversions = await OpportunityConversionCollection.create({ db });
    pipelines = await PipelineDefinitionCollection.create({ db });
    activities = await SalesActivityCollection.create({ db });
    reps = await SalesRepresentativeCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    programs = await ReferralProgramCollection.create({ db });
    policies = await AttributionPolicyCollection.create({ db });
    links = await ReferralLinkCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    referrals = await ReferralCollection.create({ db });
    agreements = await ReferralAgreementCollection.create({ db });
    snapshots = await ReferralTermSnapshotCollection.create({ db });

    attribution = new AttributionService({
      touches,
      referrals,
      exceptions: await AttributionExceptionCollection.create({ db }),
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
    settlement = new CommissionSettlementService(commissions);
    balances = new CommissionBalanceService(commissions, adjustments);
    payoutService = new CommissionPayoutService({
      earners,
      commissions,
      adjustments,
      payouts,
    });
  }, 30_000);

  afterAll(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('stage 1 — fixtures: pipeline, roles with distinct earners, program, policy v1, plan v1, agreement v1', async () => {
    // Default CRM pipeline.
    const { pipeline, stages } = await pipelines.ensureDefaultPipeline();
    expect(pipeline.key).toBe('default');
    stagesByKey = new Map(stages.map((stage) => [stage.key, stage]));
    expect([...stagesByKey.keys()]).toEqual([
      'new',
      'qualified',
      'discovery',
      'proposal',
      'negotiation',
      'closed_won',
      'closed_lost',
    ]);

    // Roles vs money: SalesRepresentative and Referrer are DISTINCT roles,
    // each holding their own neutral Earner payout account.
    repEarner = await earners.create({
      profileId: 'profile-rep-casey',
      displayName: 'Casey Rep (payout)',
      status: 'active',
    });
    await reps.create({
      profileId: 'profile-rep-casey',
      earnerId: repEarner.id ?? '',
      status: 'active',
    });
    referrerEarner = await earners.create({
      profileId: 'profile-referrer-jordan',
      displayName: 'Jordan Partner (payout)',
      status: 'active',
      // Low enough that the tracer's net payable clears the batch threshold.
      payoutThresholdCents: 1_000,
      payoutMethod: 'bank_transfer',
      currency: 'USD',
    });
    referrer = await referrers.create({
      profileId: 'profile-referrer-jordan',
      earnerId: referrerEarner.id ?? '',
      displayName: 'Jordan Partner',
      status: 'active',
    });

    // Program + ACTIVE AttributionPolicy v1 (first_touch, 30d, auto).
    const policy = await policies.create({
      policyKey: POLICY_KEY,
      version: 1,
      status: 'active',
      windowDays: 30,
      creditMode: 'first_touch',
      conflictBehavior: 'auto',
      allowSelfReferral: false,
    });
    expect(policy.isActive()).toBe(true);
    programId =
      (
        await programs.create({
          key: PROGRAM_KEY,
          name: 'Tracer partner program',
          status: 'active',
          defaultAttributionPolicyKey: POLICY_KEY,
          defaultCommissionPlanKey: PLAN_KEY,
        })
      ).id ?? '';

    // ACTIVE CommissionPlan v1 with the two tracer components.
    const planV1 = await plans.create({
      planKey: PLAN_KEY,
      version: 1,
      status: 'active',
      currency: 'USD',
      components: JSON.stringify(PLAN_V1_COMPONENTS),
    });
    expect(planV1.getComponents()).toEqual(PLAN_V1_COMPONENTS);

    // ACTIVE ReferralAgreement v1 pinning plan v1, clearingDays 7, manual
    // approval, with immutable executed-evidence references.
    agreement = await agreements.create({
      referrerId: referrer.id ?? '',
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: PLAN_KEY,
      commissionPlanVersion: 1,
      clearingDays: CLEARING_DAYS,
      approvalMode: 'manual',
      executionId: 'agreement-execution-tracer-1',
      executedAgreementId: 'executed-agreement-tracer-1',
    });
    expect(agreement.isActive()).toBe(true);
  });

  it('stage 2 — intake: link → click evidence → Lead → exactly one attributed Referral', async () => {
    // Shareable link with a crypto-random uniqueness-checked code.
    link = await links.createWithUniqueCode({
      referrerId: referrer.id ?? '',
      programId,
      targetUrl: 'https://example.test/landing',
      label: 'Tracer campaign',
    });
    expect(link.code).toMatch(/^[a-z0-9]{10}$/);

    // The prospect clicks: counter + immutable click-touch evidence.
    const click = await links.recordClick({
      code: link.code,
      occurredAt: CLICK_AT,
      evidence: { userAgentHash: 'ua-tracer' },
    });
    expect(click.refused).toBeUndefined();
    expect(click.link?.clickCount).toBe(1);
    expect(click.touch?.kind).toBe('click');
    expect(click.touch?.occurredAt.toISOString()).toBe(CLICK_AT.toISOString());

    // The prospect submits the intake form → a Lead materializes, carrying
    // the referral source pointer and preserved acquisition context.
    lead = await leads.create({
      name: 'Anytown Water Co-op',
      contactName: 'Sam Prospect',
      email: 'sam@anytown.test',
      sourceKind: 'referral',
      sourceId: link.id ?? '',
      acquisitionContext: JSON.stringify({
        referralCode: link.code,
        landing: 'https://example.test/landing',
      }),
    });
    expect(lead.getAcquisitionContext().referralCode).toBe(link.code);

    // recordClick() touches carry no subject identity (RecordClickInput has
    // no subject fields), so attribution can never gather them — the intake
    // handler records the IDENTIFIED click touch (same interaction, same
    // occurredAt) once the prospect is known. Touches are append-only
    // evidence: enrichment is a NEW row, never an edit.
    identifiedTouch = await touches.create({
      linkId: link.id ?? '',
      code: link.code,
      referrerId: referrer.id ?? '',
      programId,
      kind: 'click',
      subjectKind: 'lead',
      subjectId: lead.id ?? '',
      occurredAt: CLICK_AT,
      evidence: JSON.stringify({
        code: link.code,
        linkId: link.id ?? '',
        anonymousClickTouchId: click.touch?.id ?? '',
      }),
    });

    // Attribution resolves deterministically at ATTRIBUTED_AT.
    const resolution = await attribution.resolve({
      targetKind: 'lead',
      targetId: lead.id ?? '',
      programId,
      now: ATTRIBUTED_AT,
    });
    expect(resolution.refused).toBeUndefined();
    expect(resolution.exception).toBeNull();
    expect(resolution.referrals).toHaveLength(1);
    referral = resolution.referrals[0];
    expect(referral.status).toBe('attributed');
    expect(referral.referrerId).toBe(referrer.id);
    // Policy v1 is stamped at attribution time.
    expect(referral.policyKey).toBe(POLICY_KEY);
    expect(referral.policyVersion).toBe(1);
    expect(referral.creditFraction).toBe(1.0);
    expect(referral.primaryTouchId).toBe(identifiedTouch.id);
    expect(referral.attributedAt?.toISOString()).toBe(
      ATTRIBUTED_AT.toISOString(),
    );
    expect(referral.expiresAt?.toISOString()).toBe(
      new Date(ATTRIBUTED_AT.getTime() + 30 * DAY).toISOString(),
    );
    // Exactly one referral row exists for the target.
    expect(await referrals.findByTarget('lead', lead.id ?? '')).toHaveLength(1);

    // Attribution evidence is retained: the touch row is unchanged and the
    // referral references it.
    const retained = await touches.get({ id: identifiedTouch.id });
    expect(retained?.kind).toBe('click');
    expect(retained?.code).toBe(link.code);
    expect(retained?.linkId).toBe(link.id);
    expect(retained?.occurredAt.toISOString()).toBe(CLICK_AT.toISOString());
    expect(retained?.getEvidence().anonymousClickTouchId).not.toBe('');
  });

  it('stage 3 — CRM: qualify to Opportunity, walk the pipeline to closed_won, record the conversion idempotently', async () => {
    // Lead → Opportunity at the default pipeline's first stage.
    opportunity = await leads.qualify({
      leadId: lead.id ?? '',
      expectedValueCents: 250_000,
    });
    const newStage = stagesByKey.get('new');
    expect(opportunity.stageId).toBe(newStage?.id);
    expect(opportunity.probability).toBe(newStage?.probability);
    expect(opportunity.status).toBe('open');
    // The opportunity inherits the lead's referral source for reporting.
    expect(opportunity.sourceKind).toBe('referral');
    expect(opportunity.sourceId).toBe(link.id);

    // Walk the funnel: each move adopts the stage's probability.
    for (const [stageKey, probability] of [
      ['qualified', 0.25],
      ['discovery', 0.4],
      ['proposal', 0.6],
      ['negotiation', 0.8],
    ] as const) {
      const moved = await opportunities.moveToStage({
        opportunityId: opportunity.id ?? '',
        stageId: stagesByKey.get(stageKey)?.id ?? '',
      });
      expect(moved.probability).toBe(probability);
      expect(moved.status).toBe('open');
    }

    // closed_won is terminal: status won, wonAt stamped, probability 1.0.
    opportunity = await opportunities.moveToStage({
      opportunityId: opportunity.id ?? '',
      stageId: stagesByKey.get('closed_won')?.id ?? '',
    });
    expect(opportunity.status).toBe('won');
    expect(opportunity.probability).toBe(1.0);
    expect(opportunity.wonAt).not.toBeNull();

    // The audit trail: 1 qualification + 5 stage_change activities.
    const trail = await activities.findBySubject(
      'opportunity',
      opportunity.id ?? '',
    );
    expect(trail.map((activity) => activity.activityKind)).toEqual([
      'qualification',
      'stage_change',
      'stage_change',
      'stage_change',
      'stage_change',
      'stage_change',
    ]);
    expect(await activities.findBySubject('lead', lead.id ?? '')).toHaveLength(
      1,
    );

    // The won deal materializes downstream as a client — idempotently.
    const first = await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'client',
      targetId: clientId,
    });
    expect(first.created).toBe(true);
    const replay = await conversions.recordConversion({
      opportunityId: opportunity.id ?? '',
      targetKind: 'client',
      targetId: clientId,
    });
    expect(replay.created).toBe(false);
    expect(replay.conversion.id).toBe(first.conversion.id);
    expect(
      await conversions.findByOpportunity(opportunity.id ?? ''),
    ).toHaveLength(1);

    // CRM never touched referral state: still attributed, not qualified.
    expect((await referrals.get({ id: referral.id }))?.status).toBe(
      'attributed',
    );
  });

  it('stage 4 — qualification: the term snapshot freezes plan v1 + policy + agreement versions, idempotently', async () => {
    const result = await qualification.qualify({
      referralId: referral.id ?? '',
      now: QUALIFIED_AT,
    });
    expect(result.qualified).toBe(true);
    expect(result.created).toBe(true);
    if (!result.snapshot) throw new Error('expected snapshot');
    snapshot = result.snapshot;

    // The snapshot pins EVERYTHING the later calculations need.
    expect(snapshot.referralId).toBe(referral.id);
    expect(snapshot.agreementId).toBe(agreement.id);
    expect(snapshot.agreementVersion).toBe(1);
    expect(snapshot.planKey).toBe(PLAN_KEY);
    expect(snapshot.planVersion).toBe(1);
    expect(snapshot.policyKey).toBe(POLICY_KEY);
    expect(snapshot.policyVersion).toBe(1);
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.clearingDays).toBe(CLEARING_DAYS);
    expect(snapshot.approvalMode).toBe('manual');
    expect(snapshot.getComponents()).toEqual(PLAN_V1_COMPONENTS);

    const persisted = await referrals.get({ id: referral.id });
    expect(persisted?.status).toBe('qualified');
    expect(persisted?.snapshotId).toBe(snapshot.id);
    expect(persisted?.qualifiedAt?.toISOString()).toBe(
      QUALIFIED_AT.toISOString(),
    );

    // Idempotent second call: same snapshot, nothing re-minted.
    const again = await qualification.qualify({
      referralId: referral.id ?? '',
      now: QUALIFIED_AT,
    });
    expect(again.qualified).toBe(true);
    expect(again.created).toBe(false);
    expect(again.snapshot?.id).toBe(snapshot.id);
    expect(await snapshots.findByReferral(referral.id ?? '')).toHaveLength(1);
  });

  it('stage 5 — earning (conversion): the fixed intro bonus lands pending, cleared and trace-explained', async () => {
    const ingested = await events.getOrCreateByDedupeKey({
      eventKind: 'conversion',
      occurredAt: CONVERTED_AT,
      sourceKind: 'conversion',
      sourceId: first(await conversions.findByOpportunity(opportunity.id ?? ''))
        .id as string,
      grossAmountCents: 0, // the fixed component needs no basis amount
      currency: 'USD',
      dedupeKey: `tracer:conversion:${clientId}`,
    });
    expect(ingested.created).toBe(true);
    conversionEvent = ingested.event;

    const result = await bridge.processEarningEvent({
      event: conversionEvent,
      targetKind: 'lead',
      targetId: lead.id ?? '',
    });
    expect(result.skippedReferrals).toEqual([]);
    expect(result.results).toHaveLength(1);
    const outcome = result.results[0];
    expect(outcome.referralId).toBe(referral.id);
    // revenue_share doesn't listen for 'conversion' — filtered, not skipped.
    expect(outcome.skipped).toEqual([]);
    expect(outcome.existing).toEqual([]);
    expect(outcome.created).toHaveLength(1);

    introCommission = outcome.created[0];
    expect(introCommission.componentKey).toBe('intro_bonus');
    expect(introCommission.amountCents).toBe(INTRO_BONUS_CENTS);
    expect(introCommission.basis).toBe('fixed');
    expect(introCommission.baseAmountCents).toBe(INTRO_BONUS_CENTS);
    expect(introCommission.rate).toBe(0);
    expect(introCommission.shareFraction).toBe(1.0);
    expect(introCommission.status).toBe('pending');
    expect(introCommission.currency).toBe('USD');
    expect(introCommission.earnerId).toBe(referrerEarner.id);
    expect(introCommission.termsSnapshotKind).toBe(
      REFERRAL_TERMS_SNAPSHOT_KIND,
    );
    expect(introCommission.termsSnapshotId).toBe(snapshot.id);
    expect(introCommission.dedupeKey).toBe(
      `${conversionEvent.dedupeKey}:${snapshot.id}:intro_bonus:${referrerEarner.id}:0`,
    );
    // Clearing window: occurredAt + the snapshot's 7 clearing days.
    expect(introCommission.clearingEndsAt?.toISOString()).toBe(
      new Date(CONVERTED_AT.getTime() + CLEARING_DAYS * DAY).toISOString(),
    );

    // The calculationTrace EXPLAINS the amount: parsing and recomputing
    // base × rate × share under the traced semantics reproduces it.
    const trace = introCommission.getCalculationTrace();
    if (!trace) throw new Error('expected calculation trace');
    expect(trace).toEqual({
      planKey: PLAN_KEY,
      planVersion: 1,
      componentKey: 'intro_bonus',
      basis: 'fixed',
      baseAmountCents: INTRO_BONUS_CENTS,
      rate: 0,
      shareFraction: 1,
      occurrenceIndex: 0,
      earningEventId: conversionEvent.id,
      roundingMode: 'half_away_from_zero',
    });
    expect(recomputeFromTrace(trace)).toBe(introCommission.amountCents);
  });

  it('stage 6 — amendment prospectivity (#1932): plan v2 at 20% never leaks into the frozen 10% terms; replays return existing', async () => {
    // Amend the plan: v2 doubles revenue_share to 0.2 and becomes the
    // governing version for FUTURE qualifications.
    const v2 = await plans.createAmendment(PLAN_KEY, {
      components: [
        PLAN_V1_COMPONENTS[0],
        {
          key: 'revenue_share',
          trigger: 'invoice_payment',
          basis: 'gross',
          rate: 0.2,
          recurrence: { kind: 'recurring', maxOccurrences: 2 },
        },
      ],
    });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    v2.activate();
    await v2.save();
    const v1 = (
      await plans.list({ where: { planKey: PLAN_KEY, version: 1 } })
    )[0];
    v1.supersede();
    await v1.save();
    expect((await plans.latestActiveByKey(PLAN_KEY))?.version).toBe(2);
    // v1's own row is immutable history — its components still say 10%.
    expect(
      (
        await plans.list({ where: { planKey: PLAN_KEY, version: 1 } })
      )[0].getComponents(),
    ).toEqual(PLAN_V1_COMPONENTS);

    // An invoice is paid AFTER the amendment.
    invoice1Event = (
      await events.getOrCreateByDedupeKey({
        eventKind: 'invoice_payment',
        occurredAt: INVOICE_1_AT,
        sourceKind: 'invoice',
        sourceId: 'inv-1001',
        grossAmountCents: INVOICE_1_GROSS,
        currency: 'USD',
        dedupeKey: 'tracer:invoice:inv-1001',
      })
    ).event;
    const result = await bridge.processEarningEvent({
      event: invoice1Event,
      targetKind: 'lead',
      targetId: lead.id ?? '',
    });
    expect(result.results[0].created).toHaveLength(1);
    revShare1 = result.results[0].created[0];

    // 123_456 × 0.1 (FROZEN v1) = 12_345.6 → 12_346 — NOT 0.2 (24_691).
    expect(revShare1.componentKey).toBe('revenue_share');
    expect(revShare1.amountCents).toBe(REV_SHARE_1);
    expect(revShare1.baseAmountCents).toBe(INVOICE_1_GROSS);
    expect(revShare1.rate).toBe(0.1);
    expect(revShare1.planVersion).toBe(1);
    expect(revShare1.clearingEndsAt?.toISOString()).toBe(
      new Date(INVOICE_1_AT.getTime() + CLEARING_DAYS * DAY).toISOString(),
    );
    const trace = revShare1.getCalculationTrace();
    if (!trace) throw new Error('expected calculation trace');
    expect(recomputeFromTrace(trace)).toBe(REV_SHARE_1);

    // Replaying the SAME event returns the existing row — no duplicates.
    const replay = await bridge.processEarningEvent({
      event: invoice1Event,
      targetKind: 'lead',
      targetId: lead.id ?? '',
    });
    expect(replay.results[0].created).toHaveLength(0);
    expect(replay.results[0].existing).toHaveLength(1);
    expect(replay.results[0].existing[0].id).toBe(revShare1.id);
    expect(await commissions.findByEvent(invoice1Event.id ?? '')).toHaveLength(
      1,
    );
  });

  it('stage 7 — recurrence: the second invoice earns, the third is capped at maxOccurrences 2', async () => {
    const invoice2Event = (
      await events.getOrCreateByDedupeKey({
        eventKind: 'invoice_payment',
        occurredAt: INVOICE_2_AT,
        sourceKind: 'invoice',
        sourceId: 'inv-1002',
        grossAmountCents: INVOICE_2_GROSS,
        currency: 'USD',
        dedupeKey: 'tracer:invoice:inv-1002',
      })
    ).event;
    const second = await bridge.processEarningEvent({
      event: invoice2Event,
      targetKind: 'lead',
      targetId: lead.id ?? '',
    });
    expect(second.results[0].created).toHaveLength(1);
    revShare2 = second.results[0].created[0];
    expect(revShare2.amountCents).toBe(REV_SHARE_2); // 100_000 × 0.1
    expect(revShare2.getCalculationTrace()?.occurrenceIndex).toBe(1);
    expect(revShare2.dedupeKey).toBe(
      `${invoice2Event.dedupeKey}:${snapshot.id}:revenue_share:${referrerEarner.id}:1`,
    );

    // The third invoice hits the recurrence cap — typed skip, no row.
    const invoice3Event = (
      await events.getOrCreateByDedupeKey({
        eventKind: 'invoice_payment',
        occurredAt: INVOICE_3_AT,
        sourceKind: 'invoice',
        sourceId: 'inv-1003',
        grossAmountCents: 50_000,
        currency: 'USD',
        dedupeKey: 'tracer:invoice:inv-1003',
      })
    ).event;
    const third = await bridge.processEarningEvent({
      event: invoice3Event,
      targetKind: 'lead',
      targetId: lead.id ?? '',
    });
    expect(third.results[0].created).toHaveLength(0);
    expect(third.results[0].skipped).toEqual([
      { componentKey: 'revenue_share', reason: 'occurrence_limit_reached' },
    ]);

    // The referrer's ledger: exactly the three earned commissions.
    expect(
      await commissions.list({ where: { earnerId: referrerEarner.id } }),
    ).toHaveLength(3);
  });

  it('stage 8 — settlement (#1933): clearing sweep → approve → payable; the refund adjustment appends, never rewrites', async () => {
    const ids = [
      introCommission.id ?? '',
      revShare1.id ?? '',
      revShare2.id ?? '',
    ];

    // Sweep the clearing window at SWEEP_AT (past every clearingEndsAt).
    const swept = await settlement.sweepClearing(SWEEP_AT);
    expect(swept.map((c) => c.id).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const row = await commissions.get({ id });
      expect(row?.status).toBe('earned');
      expect(row?.earnedAt?.toISOString()).toBe(SWEEP_AT.toISOString());
    }

    // Manual approval (the agreement's approvalMode), then payable release.
    await settlement.approveCommissions(ids, APPROVED_AT);
    await settlement.markPayable(ids, PAYABLE_AT);
    for (const id of ids) {
      const row = await commissions.get({ id });
      expect(row?.status).toBe('payable');
      expect(row?.approvedAt?.toISOString()).toBe(APPROVED_AT.toISOString());
      expect(row?.payableAt?.toISOString()).toBe(PAYABLE_AT.toISOString());
    }

    // The computed balance: 5_000 + 12_346 + 10_000 = 27_346 payable.
    const before = await balances.getBalance(referrerEarner.id ?? '', 'USD');
    expect(before.payableCents).toBe(PAYABLE_TOTAL);
    expect(before.unsettledAdjustmentCents).toBe(0);
    expect(before.netPayableCents).toBe(PAYABLE_TOTAL);

    // Adjustments are audit rows and must explain themselves: a refund
    // without a reason is rejected outright.
    await expect(
      adjustments.create({
        commissionId: revShare1.id ?? '',
        earnerId: referrerEarner.id ?? '',
        adjustmentKind: 'refund',
        amountCents: REFUND_CENTS,
        currency: 'USD',
      }),
    ).rejects.toThrow(/[Rr]equired field 'reason'/);

    // Snapshot the original commission row, then append the refund.
    revShare1BeforeAdjustment = (
      await commissions.get({ id: revShare1.id })
    )?.toJSON() as Record<string, unknown>;
    const adjustment = await adjustments.create({
      commissionId: revShare1.id ?? '',
      earnerId: referrerEarner.id ?? '',
      adjustmentKind: 'refund',
      amountCents: REFUND_CENTS,
      currency: 'USD',
      reason: 'Customer refunded invoice inv-1001 in part',
    });
    expect(adjustment.amountCents).toBe(REFUND_CENTS);

    // Adjustments NEVER rewrite the commission: the original row is
    // byte-identical — amount, status, trace, timestamps, everything.
    const after = (
      await commissions.get({ id: revShare1.id })
    )?.toJSON() as Record<string, unknown>;
    expect(after).toEqual(revShare1BeforeAdjustment);
    expect(after.amountCents).toBe(REV_SHARE_1);
    expect(after.status).toBe('payable');

    // Net payable: 27_346 - 2_000 = 25_346.
    const balance = await balances.getBalance(referrerEarner.id ?? '', 'USD');
    expect(balance.payableCents).toBe(PAYABLE_TOTAL);
    expect(balance.unsettledAdjustmentCents).toBe(REFUND_CENTS);
    expect(balance.netPayableCents).toBe(NET_PAYABLE);
  });

  it('stage 9 — payout: exact rows batched and stamped, idempotent by key, completed with a retained reference', async () => {
    const commissionIds = [
      introCommission.id ?? '',
      revShare1.id ?? '',
      revShare2.id ?? '',
    ];

    const batch = await payoutService.createPayoutBatch({
      earnerId: referrerEarner.id ?? '',
      currency: 'USD',
      idempotencyKey: 'tracer-1',
      now: BATCHED_AT,
    });
    expect(batch.created).toBe(true);
    if (!batch.payout) throw new Error('expected payout');
    payout = batch.payout;
    expect(payout.status).toBe('pending');
    expect(payout.commissionTotalCents).toBe(PAYABLE_TOTAL);
    expect(payout.adjustmentTotalCents).toBe(REFUND_CENTS);
    expect(payout.totalAmountCents).toBe(NET_PAYABLE);
    expect(payout.payoutMethod).toBe('bank_transfer'); // earner default
    expect(batch.settledCommissionIds.sort()).toEqual(
      [...commissionIds].sort(),
    );
    expect(batch.settledAdjustmentIds).toHaveLength(1);

    // The exact rows are stamped with the payout id.
    for (const id of commissionIds) {
      expect((await commissions.get({ id }))?.payoutId).toBe(payout.id);
    }
    expect(await commissions.findByPayout(payout.id ?? '')).toHaveLength(3);
    expect(await adjustments.findByPayout(payout.id ?? '')).toHaveLength(1);

    // Idempotent replay: same key → same payout, nothing re-stamped.
    const replay = await payoutService.createPayoutBatch({
      earnerId: referrerEarner.id ?? '',
      currency: 'USD',
      idempotencyKey: 'tracer-1',
      now: BATCHED_AT,
    });
    expect(replay.created).toBe(false);
    expect(replay.payout?.id).toBe(payout.id);
    expect(replay.settledCommissionIds).toEqual([]);
    expect(replay.settledAdjustmentIds).toEqual([]);
    expect(await commissions.findByPayout(payout.id ?? '')).toHaveLength(3);
    expect(await adjustments.findByPayout(payout.id ?? '')).toHaveLength(1);

    // Drive the payout state machine: approve → processing → completed.
    payout.approve();
    await payout.save();
    payout.markProcessing();
    await payout.save();
    const completed = await payoutService.completePayout(
      payout.id ?? '',
      'wire-123',
      PAID_AT,
    );
    expect(completed.status).toBe('completed');
    expect(completed.paymentReference).toBe('wire-123');
    expect(completed.paidAt?.toISOString()).toBe(PAID_AT.toISOString());

    // Every settled commission is now paid.
    for (const id of commissionIds) {
      const row = await commissions.get({ id });
      expect(row?.status).toBe('paid');
      expect(row?.paidAt?.toISOString()).toBe(PAID_AT.toISOString());
    }

    // Re-batching finds nothing left to pay.
    const rebatch = await payoutService.createPayoutBatch({
      earnerId: referrerEarner.id ?? '',
      currency: 'USD',
      idempotencyKey: 'tracer-2',
      now: PAID_AT,
    });
    expect(rebatch.payout).toBeNull();
    expect(rebatch.reason).toBe('nothing_payable');
  });

  it('stage 10 — referrer view: the whole story is explainable from collections/services alone', async () => {
    // WHO earned and WHY: the referral, its policy pin, and the touch.
    const mine = await referrals.findByReferrer(referrer.id ?? '');
    expect(mine).toHaveLength(1);
    const myReferral = mine[0];
    expect(myReferral.status).toBe('qualified');
    expect(myReferral.policyKey).toBe(POLICY_KEY);
    expect(myReferral.policyVersion).toBe(1);
    const policyRow = (
      await policies.list({ where: { policyKey: POLICY_KEY, version: 1 } })
    )[0];
    expect(policyRow.creditMode).toBe('first_touch');
    const touch = await touches.get({ id: myReferral.primaryTouchId });
    expect(touch?.kind).toBe('click');
    expect(touch?.getEvidence().code).toBe(link.code);

    // UNDER WHICH TERMS: the frozen snapshot names agreement/plan/policy
    // versions — still v1 even though the live plan moved to v2.
    const terms = await snapshots.get({ id: myReferral.snapshotId });
    expect(terms?.agreementId).toBe(agreement.id);
    expect(terms?.agreementVersion).toBe(1);
    expect(terms?.planKey).toBe(PLAN_KEY);
    expect(terms?.planVersion).toBe(1);
    expect(terms?.policyKey).toBe(POLICY_KEY);
    expect(terms?.policyVersion).toBe(1);
    expect((await plans.latestActiveByKey(PLAN_KEY))?.version).toBe(2);

    // ... and the executed agreement row carries its execution evidence.
    const executed = await agreements.get({ id: agreement.id });
    expect(executed?.executionId).toBe('agreement-execution-tracer-1');
    expect(executed?.executedAgreementId).toBe('executed-agreement-tracer-1');

    // HOW MUCH and WHY THAT MUCH: every commission amount reproduces from
    // its own persisted trace.
    const earnings = await commissions.list({
      where: { earnerId: referrerEarner.id },
    });
    expect(earnings).toHaveLength(3);
    expect(earnings.map((c) => c.amountCents).sort((a, b) => a - b)).toEqual([
      INTRO_BONUS_CENTS,
      REV_SHARE_2,
      REV_SHARE_1,
    ]);
    for (const earning of earnings) {
      expect(earning.termsSnapshotKind).toBe(REFERRAL_TERMS_SNAPSHOT_KIND);
      expect(earning.termsSnapshotId).toBe(snapshot.id);
      expect(earning.status).toBe('paid');
      const trace = earning.getCalculationTrace();
      if (!trace) throw new Error('expected calculation trace');
      expect(recomputeFromTrace(trace)).toBe(earning.amountCents);
    }

    // CORRECTIONS, with reasons.
    const corrections = await adjustments.findByCommission(revShare1.id ?? '');
    expect(corrections).toHaveLength(1);
    expect(corrections[0].adjustmentKind).toBe('refund');
    expect(corrections[0].amountCents).toBe(REFUND_CENTS);
    expect(corrections[0].reason).toBe(
      'Customer refunded invoice inv-1001 in part',
    );
    expect(corrections[0].payoutId).toBe(payout.id);

    // BALANCE after settlement: nothing payable, nothing dangling.
    const balance = await balances.getBalance(referrerEarner.id ?? '', 'USD');
    expect(balance.payableCents).toBe(0);
    expect(balance.pendingCents).toBe(0);
    expect(balance.earnedCents).toBe(0);
    expect(balance.approvedCents).toBe(0);
    expect(balance.unsettledAdjustmentCents).toBe(0);
    expect(balance.netPayableCents).toBe(0);

    // PAYOUT HISTORY with the money-movement reference.
    const paidOut = await payouts.get({ id: payout.id });
    expect(paidOut?.status).toBe('completed');
    expect(paidOut?.paymentReference).toBe('wire-123');
    expect(paidOut?.totalAmountCents).toBe(NET_PAYABLE);
    expect(await payouts.sumPaidByEarner(referrerEarner.id ?? '', 'USD')).toBe(
      NET_PAYABLE,
    );

    // Roles stay distinct all the way down: the sales rep's Earner never
    // earned referral money.
    expect(
      await commissions.list({ where: { earnerId: repEarner.id } }),
    ).toHaveLength(0);
  });
});
