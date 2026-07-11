/**
 * ReferralQualificationService tests: agreement/plan resolution refusals,
 * term-snapshot freezing (plan amendments don't leak), unpinned-version
 * pinning, idempotent qualification, explicit requalification, eligibility
 * re-checks, and the snapshot's own immutability guard.
 *
 * Real in-memory SQLite — commission-plan fixtures come from the
 * commissions module (same package).
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CommissionPlanCollection,
  type CommissionPlanComponent,
} from '../../commissions/index.js';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralAgreementCollection } from '../collections/ReferralAgreementCollection.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTermSnapshotCollection } from '../collections/ReferralTermSnapshotCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { Referral } from '../models/Referral.js';
import { ReferralQualificationService } from '../services/ReferralQualificationService.js';

const NOW = new Date('2026-06-15T00:00:00Z');

const COMPONENTS: CommissionPlanComponent[] = [
  { key: 'rev-share', trigger: 'invoice_payment', basis: 'gross', rate: 0.1 },
];

describe('ReferralQualificationService', () => {
  let db: DatabaseInterface;
  let service: ReferralQualificationService;
  let referrals: ReferralCollection;
  let agreements: ReferralAgreementCollection;
  let plans: CommissionPlanCollection;
  let policies: AttributionPolicyCollection;
  let snapshots: ReferralTermSnapshotCollection;
  let referrers: ReferrerCollection;
  let referrerId: string;
  let programId: string;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    referrals = await ReferralCollection.create({ db });
    agreements = await ReferralAgreementCollection.create({ db });
    plans = await CommissionPlanCollection.create({ db });
    policies = await AttributionPolicyCollection.create({ db });
    snapshots = await ReferralTermSnapshotCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    service = new ReferralQualificationService({
      referrals,
      agreements,
      plans,
      policies,
      snapshots,
      referrers,
    });

    referrerId =
      (
        await referrers.create({
          profileId: 'profile-referrer',
          displayName: 'Jordan Partner',
          status: 'active',
        })
      ).id ?? '';
    const programs = await ReferralProgramCollection.create({ db });
    programId =
      (await programs.create({ key: 'partners', name: 'Partner program' }))
        .id ?? '';
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function makeAttributedReferral(
    overrides: Record<string, unknown> = {},
  ): Promise<Referral> {
    const referral = await referrals.create({
      referrerId,
      programId,
      targetKind: 'client',
      targetId: 'client-1',
      policyKey: 'standard',
      policyVersion: 1,
      status: 'pending',
      ...overrides,
    });
    referral.markAttributed(NOW);
    await referral.save();
    return referral;
  }

  async function makeActivePlan(
    components: CommissionPlanComponent[] = COMPONENTS,
  ) {
    return await plans.create({
      planKey: 'referral-standard',
      version: 1,
      status: 'active',
      currency: 'USD',
      components: JSON.stringify(components),
    });
  }

  async function makeActiveAgreement(overrides: Record<string, unknown> = {}) {
    return await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: 'referral-standard',
      commissionPlanVersion: 0,
      clearingDays: 30,
      approvalMode: 'auto',
      ...overrides,
    });
  }

  it('refuses referrals that are not attributed', async () => {
    const pending = await referrals.create({
      referrerId,
      programId,
      targetKind: 'client',
      targetId: 'client-p',
      status: 'pending',
    });
    const result = await service.qualify({
      referralId: pending.id ?? '',
      now: NOW,
    });
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe('not_attributed');
    expect(result.snapshot).toBeNull();
    // Refusal never mutates the referral.
    expect((await referrals.get({ id: pending.id }))?.status).toBe('pending');
  });

  it('refuses when no active agreement governs at `now`', async () => {
    await makeActivePlan();
    const referral = await makeAttributedReferral();
    const result = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe('no_active_agreement');

    // An agreement whose window has closed refuses the same way.
    await makeActiveAgreement({
      effectiveTo: new Date('2026-01-01T00:00:00Z'),
    });
    const closed = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(closed.reason).toBe('no_active_agreement');
  });

  it('refuses when the bound plan has no active version', async () => {
    await makeActiveAgreement(); // binds 'referral-standard', unpinned
    const referral = await makeAttributedReferral();

    // No plan rows at all.
    const missing = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(missing.reason).toBe('no_active_plan');

    // A draft version is not active terms.
    await plans.create({
      planKey: 'referral-standard',
      version: 1,
      status: 'draft',
      components: JSON.stringify(COMPONENTS),
    });
    const draftOnly = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(draftOnly.reason).toBe('no_active_plan');
  });

  it('refuses when the agreement pins a version that is not active', async () => {
    await makeActivePlan();
    await makeActiveAgreement({ commissionPlanVersion: 7 });
    const referral = await makeAttributedReferral();
    const result = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(result.qualified).toBe(false);
    expect(result.reason).toBe('no_active_plan');
  });

  it('qualifies: mints the frozen snapshot and transitions the referral', async () => {
    const plan = await makeActivePlan();
    const agreement = await makeActiveAgreement();
    const referral = await makeAttributedReferral();

    const result = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(result.qualified).toBe(true);
    expect(result.created).toBe(true);
    const snapshot = result.snapshot;
    if (!snapshot) throw new Error('expected snapshot');

    expect(snapshot.referralId).toBe(referral.id);
    expect(snapshot.agreementId).toBe(agreement.id);
    expect(snapshot.agreementVersion).toBe(1);
    expect(snapshot.planKey).toBe('referral-standard');
    expect(snapshot.planVersion).toBe(plan.version);
    expect(snapshot.policyKey).toBe('standard');
    expect(snapshot.policyVersion).toBe(1);
    expect(snapshot.currency).toBe('USD');
    expect(snapshot.clearingDays).toBe(30);
    expect(snapshot.approvalMode).toBe('auto');
    expect(snapshot.getComponents()).toEqual(COMPONENTS);

    const persisted = await referrals.get({ id: referral.id });
    expect(persisted?.status).toBe('qualified');
    expect(persisted?.snapshotId).toBe(snapshot.id);
    expect(persisted?.qualifiedAt?.toISOString()).toBe(NOW.toISOString());
  });

  it('freezes the component copy: later plan amendments do not leak in', async () => {
    const v1 = await makeActivePlan();
    await makeActiveAgreement();
    const referral = await makeAttributedReferral();
    const { snapshot } = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    if (!snapshot) throw new Error('expected snapshot');

    // Amend the plan to a 50% rate and make it the governing version.
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

    const frozen = await snapshots.get({ id: snapshot.id });
    expect(frozen?.planVersion).toBe(1);
    expect(frozen?.getComponents()).toEqual(COMPONENTS); // still 10%
  });

  it('is idempotent: a second qualify returns the existing snapshot', async () => {
    await makeActivePlan();
    await makeActiveAgreement();
    const referral = await makeAttributedReferral();

    const first = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    const second = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(second.qualified).toBe(true);
    expect(second.created).toBe(false);
    expect(second.snapshot?.id).toBe(first.snapshot?.id);
    expect(await snapshots.findByReferral(referral.id ?? '')).toHaveLength(1);
  });

  it('pins the latest active version when the agreement leaves it unpinned', async () => {
    const v1 = await makeActivePlan();
    const v2 = await plans.createAmendment('referral-standard', {
      components: [
        {
          key: 'rev-share',
          trigger: 'invoice_payment',
          basis: 'gross',
          rate: 0.15,
        },
      ],
    });
    v2.activate();
    await v2.save();
    v1.supersede();
    await v1.save();

    const agreement = await makeActiveAgreement(); // commissionPlanVersion: 0
    const referral = await makeAttributedReferral();
    const { snapshot } = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });

    expect(agreement.commissionPlanVersion).toBe(0); // agreement stays unpinned
    expect(snapshot?.planVersion).toBe(2); // snapshot pins what governed
    expect(snapshot?.getComponents()[0].rate).toBe(0.15);
  });

  it('re-checks policy eligibility flags at qualification time', async () => {
    await policies.create({
      policyKey: 'standard',
      version: 1,
      status: 'active',
      windowDays: 30,
      allowExistingClients: false,
      allowSelfReferral: false,
    });
    await makeActivePlan();
    await makeActiveAgreement();

    const referral = await makeAttributedReferral();
    const existing = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
      isExistingClient: true,
    });
    expect(existing.qualified).toBe(false);
    expect(existing.reason).toBe('existing_client_ineligible');

    const self = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
      subjectProfileId: 'profile-referrer', // the referrer IS the prospect
    });
    expect(self.qualified).toBe(false);
    expect(self.reason).toBe('self_referral_ineligible');

    // With clean flags the same referral qualifies.
    const clean = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });
    expect(clean.qualified).toBe(true);
  });

  describe('requalify', () => {
    it('re-snapshots under CURRENT terms, keeping the old snapshot as history', async () => {
      const v1 = await makeActivePlan();
      await makeActiveAgreement();
      const referral = await makeAttributedReferral();
      const first = await service.qualify({
        referralId: referral.id ?? '',
        now: NOW,
      });
      const firstSnapshotId = first.snapshot?.id ?? '';

      // Amend to 50% and activate.
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

      const later = new Date(NOW.getTime() + 24 * 60 * 60 * 1000);
      const result = await service.requalify({
        referralId: referral.id ?? '',
        reason: 'partner renegotiated to the amended plan',
        now: later,
      });

      expect(result.requalified).toBe(true);
      expect(result.previousSnapshotId).toBe(firstSnapshotId);
      expect(result.snapshot?.id).not.toBe(firstSnapshotId);
      expect(result.snapshot?.planVersion).toBe(2);
      expect(result.snapshot?.getComponents()[0].rate).toBe(0.5);

      // Old snapshot survives untouched; the referral points at the new one.
      const history = await snapshots.findByReferral(referral.id ?? '');
      expect(history).toHaveLength(2);
      const old = await snapshots.get({ id: firstSnapshotId });
      expect(old?.planVersion).toBe(1);
      const persisted = await referrals.get({ id: referral.id });
      expect(persisted?.snapshotId).toBe(result.snapshot?.id);
      const trail = persisted?.getMetadata().requalifications as Array<
        Record<string, unknown>
      >;
      expect(trail).toHaveLength(1);
      expect(trail[0].reason).toBe('partner renegotiated to the amended plan');
      expect(trail[0].fromSnapshotId).toBe(firstSnapshotId);
      expect(trail[0].toSnapshotId).toBe(result.snapshot?.id);
    });

    it('throws on misuse: empty reason or a non-qualified referral', async () => {
      await makeActivePlan();
      await makeActiveAgreement();
      const referral = await makeAttributedReferral();

      await expect(
        service.requalify({ referralId: referral.id ?? '', reason: '  ' }),
      ).rejects.toThrow(/non-empty reason/);
      await expect(
        service.requalify({
          referralId: referral.id ?? '',
          reason: 'not qualified yet',
        }),
      ).rejects.toThrow(/only qualified referrals/);
    });
  });

  it('guards persisted snapshots against any mutation', async () => {
    await makeActivePlan();
    await makeActiveAgreement();
    const referral = await makeAttributedReferral();
    const { snapshot } = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });

    const loaded = await snapshots.get({ id: snapshot?.id });
    if (!loaded) throw new Error('expected snapshot');
    // A no-op re-save passes…
    await expect(loaded.save()).resolves.toBeDefined();
    // …but any field change is rejected.
    loaded.clearingDays = 0;
    await expect(loaded.save()).rejects.toThrow(/immutable once created/);

    const reloaded = await snapshots.get({ id: snapshot?.id });
    if (!reloaded) throw new Error('expected snapshot');
    reloaded.components = JSON.stringify([]);
    await expect(reloaded.save()).rejects.toThrow(/immutable once created/);
  });

  it('unpinned resolution ignores a future-dated active amendment (codex P2)', async () => {
    await makeActivePlan(); // v1, effective immediately
    const v2 = await plans.createAmendment('referral-standard', {
      components: [
        {
          key: 'rev-share',
          trigger: 'invoice_payment',
          basis: 'gross',
          rate: 0.5,
        },
      ],
      effectiveFrom: new Date('2099-01-01T00:00:00Z'),
    });
    v2.activate();
    await v2.save();

    await makeActiveAgreement(); // unpinned (commissionPlanVersion: 0)
    const referral = await makeAttributedReferral();
    const { qualified, snapshot } = await service.qualify({
      referralId: referral.id ?? '',
      now: NOW,
    });

    // The snapshot pins the version IN EFFECT at the qualification clock —
    // the future-dated v2 does not govern early.
    expect(qualified).toBe(true);
    expect(snapshot?.planVersion).toBe(1);
    expect(snapshot?.getComponents()[0].rate).not.toBe(0.5);
  });
});
