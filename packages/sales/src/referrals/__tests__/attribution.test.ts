/**
 * AttributionService tests: credit modes (first/last touch, assigned,
 * split), window filtering, eligibility gates (self-referral,
 * existing-client), conflicts (ties, competing assignments, review-forced),
 * idempotency, exception resolution with audited awards, re-attribution
 * overrides, and expiry sweeping.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttributionExceptionCollection } from '../collections/AttributionExceptionCollection.js';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';
import type { Referrer } from '../models/Referrer.js';
import {
  AttributionService,
  QualifiedReferralOverrideError,
} from '../services/AttributionService.js';
import type { AttributionPolicyOptions, ReferralTouchKind } from '../types.js';

const NOW = new Date('2026-06-15T00:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

describe('AttributionService', () => {
  let db: DatabaseInterface;
  let service: AttributionService;
  let touches: ReferralTouchCollection;
  let referrals: ReferralCollection;
  let exceptions: AttributionExceptionCollection;
  let policies: AttributionPolicyCollection;
  let programs: ReferralProgramCollection;
  let referrers: ReferrerCollection;
  let programId: string;
  let alice: Referrer;
  let bob: Referrer;
  let cara: Referrer;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    touches = await ReferralTouchCollection.create({ db });
    referrals = await ReferralCollection.create({ db });
    exceptions = await AttributionExceptionCollection.create({ db });
    policies = await AttributionPolicyCollection.create({ db });
    programs = await ReferralProgramCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    service = new AttributionService({
      touches,
      referrals,
      exceptions,
      policies,
      programs,
      referrers,
    });

    programId =
      (
        await programs.create({
          key: 'partners',
          name: 'Partner program',
          status: 'active',
          defaultAttributionPolicyKey: 'default-policy',
        })
      ).id ?? '';
    alice = await referrers.create({
      profileId: 'profile-alice',
      displayName: 'Alice',
      status: 'active',
    });
    bob = await referrers.create({
      profileId: 'profile-bob',
      displayName: 'Bob',
      status: 'active',
    });
    cara = await referrers.create({
      profileId: 'profile-cara',
      displayName: 'Cara',
      status: 'active',
    });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function makePolicy(
    policyKey: string,
    overrides: Partial<AttributionPolicyOptions> = {},
  ) {
    return await policies.create({
      policyKey,
      version: 1,
      status: 'active',
      windowDays: 30,
      creditMode: 'first_touch',
      conflictBehavior: 'auto',
      ...overrides,
    });
  }

  async function makeTouch(params: {
    referrer: Referrer;
    at: Date;
    kind?: ReferralTouchKind;
    subjectKind?: string;
    subjectId?: string;
  }) {
    return await touches.create({
      referrerId: params.referrer.id ?? '',
      programId,
      kind: params.kind ?? 'click',
      subjectKind: params.subjectKind ?? 'lead',
      subjectId: params.subjectId ?? 'lead-1',
      occurredAt: params.at,
    });
  }

  function resolveInput(policyKey: string, overrides: object = {}) {
    return {
      targetKind: 'lead',
      targetId: 'lead-1',
      programId,
      policyKey,
      now: NOW,
      ...overrides,
    };
  }

  it('first_touch: the earliest eligible touch wins and stamps the policy pin', async () => {
    const policy = await makePolicy('ft');
    const early = await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 5 * DAY),
    });
    await makeTouch({ referrer: bob, at: new Date(NOW.getTime() - 1 * DAY) });

    const result = await service.resolve(resolveInput('ft'));
    expect(result.refused).toBeUndefined();
    expect(result.exception).toBeNull();
    expect(result.referrals).toHaveLength(1);
    const referral = result.referrals[0];
    expect(referral.referrerId).toBe(alice.id);
    expect(referral.status).toBe('attributed');
    expect(referral.policyKey).toBe(policy.policyKey);
    expect(referral.policyVersion).toBe(policy.version);
    expect(referral.primaryTouchId).toBe(early.id);
    expect(referral.creditFraction).toBe(1.0);
    expect(referral.attributedAt?.toISOString()).toBe(NOW.toISOString());
    expect(referral.expiresAt?.toISOString()).toBe(
      new Date(NOW.getTime() + 30 * DAY).toISOString(),
    );
  });

  it('last_touch: the latest eligible touch wins', async () => {
    await makePolicy('lt', { creditMode: 'last_touch' });
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 5 * DAY),
    });
    const late = await makeTouch({
      referrer: bob,
      at: new Date(NOW.getTime() - 1 * DAY),
    });

    const result = await service.resolve(resolveInput('lt'));
    expect(result.referrals).toHaveLength(1);
    expect(result.referrals[0].referrerId).toBe(bob.id);
    expect(result.referrals[0].primaryTouchId).toBe(late.id);
  });

  it('ignores touches outside the attribution window', async () => {
    await makePolicy('window');
    // Alice touched FIRST but 40 days ago — outside the 30-day window.
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 40 * DAY),
    });
    await makeTouch({ referrer: bob, at: new Date(NOW.getTime() - 2 * DAY) });

    const result = await service.resolve(resolveInput('window'));
    expect(result.referrals).toHaveLength(1);
    expect(result.referrals[0].referrerId).toBe(bob.id);

    // Nothing but stale evidence → refused, no rows.
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 40 * DAY),
      subjectId: 'lead-2',
    });
    const staleOnly = await service.resolve(
      resolveInput('window', { targetKind: 'lead', targetId: 'lead-2' }),
    );
    expect(staleOnly.refused).toBe('no_eligible_touches');
    expect(staleOnly.referrals).toHaveLength(0);
  });

  it('assigned: a manual assignment beats click evidence', async () => {
    await makePolicy('assigned', { creditMode: 'assigned' });
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 5 * DAY) });
    const assignment = await service.recordManualAssignment({
      referrerId: bob.id ?? '',
      programId,
      targetKind: 'lead',
      targetId: 'lead-1',
      actorProfileId: 'profile-ops',
      reason: 'partner desk introduction',
      occurredAt: new Date(NOW.getTime() - 1 * DAY),
    });
    expect(assignment.kind).toBe('manual_assignment');
    expect(assignment.getEvidence().actorProfileId).toBe('profile-ops');
    expect(assignment.getEvidence().reason).toBe('partner desk introduction');
    // Subject defaults to the target pair so resolve() finds it.
    expect(assignment.subjectKind).toBe('lead');
    expect(assignment.subjectId).toBe('lead-1');

    const result = await service.resolve(resolveInput('assigned'));
    expect(result.referrals).toHaveLength(1);
    expect(result.referrals[0].referrerId).toBe(bob.id);
    expect(result.referrals[0].primaryTouchId).toBe(assignment.id);
  });

  it('assigned: competing manual assignments from distinct referrers raise an exception', async () => {
    await makePolicy('assigned2', { creditMode: 'assigned' });
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 3 * DAY),
      kind: 'manual_assignment',
    });
    await makeTouch({
      referrer: bob,
      at: new Date(NOW.getTime() - 1 * DAY),
      kind: 'manual_assignment',
    });

    const result = await service.resolve(resolveInput('assigned2'));
    expect(result.referrals).toHaveLength(0);
    expect(result.exception?.conflictReason).toBe('competing_touches');
    expect(result.exception?.isOpen()).toBe(true);
    const candidates = result.exception?.getCandidates() ?? [];
    expect(candidates).toHaveLength(2);
    expect(new Set(candidates.map((c) => c.referrerId))).toEqual(
      new Set([alice.id, bob.id]),
    );

    // Assigned mode without any assignment refuses (clicks are context).
    await makeTouch({
      referrer: cara,
      at: new Date(NOW.getTime() - 1 * DAY),
      subjectId: 'lead-9',
    });
    const noAssignment = await service.resolve(
      resolveInput('assigned2', { targetId: 'lead-9' }),
    );
    expect(noAssignment.refused).toBe('no_eligible_touches');
  });

  it('split: every distinct eligible referrer gets an equal-fraction sibling', async () => {
    await makePolicy('split', { creditMode: 'split' });
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 6 * DAY) });
    await makeTouch({ referrer: bob, at: new Date(NOW.getTime() - 4 * DAY) });
    await makeTouch({ referrer: cara, at: new Date(NOW.getTime() - 2 * DAY) });

    const result = await service.resolve(resolveInput('split'));
    expect(result.referrals).toHaveLength(3);
    const fractions = result.referrals.map((r) => r.creditFraction);
    expect(fractions).toEqual([0.3333, 0.3333, 0.3334]);
    expect(fractions.reduce((s, f) => s + f, 0)).toBeCloseTo(1.0, 10);
    const groupIds = new Set(result.referrals.map((r) => r.splitGroupId));
    expect(groupIds.size).toBe(1);
    expect([...groupIds][0]).not.toBe('');
    // Ordered by earliest touch: Alice, Bob, Cara.
    expect(result.referrals.map((r) => r.referrerId)).toEqual([
      alice.id,
      bob.id,
      cara.id,
    ]);
  });

  it('exact-timestamp ties between distinct referrers raise a tie exception', async () => {
    const at = new Date(NOW.getTime() - 3 * DAY);
    await makePolicy('tie');
    await makeTouch({ referrer: alice, at });
    await makeTouch({ referrer: bob, at });

    const result = await service.resolve(resolveInput('tie'));
    expect(result.referrals).toHaveLength(0);
    expect(result.exception?.conflictReason).toBe('tie');
    expect(result.exception?.getCandidates()).toHaveLength(2);
    // The policy pin is stamped for later resolution.
    expect(result.exception?.getMetadata().policyKey).toBe('tie');
  });

  it("conflictBehavior 'review' forces an exception for any multi-referrer contention", async () => {
    await makePolicy('review', { conflictBehavior: 'review' });
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 5 * DAY) });
    await makeTouch({ referrer: bob, at: new Date(NOW.getTime() - 1 * DAY) });

    const result = await service.resolve(resolveInput('review'));
    expect(result.referrals).toHaveLength(0);
    expect(result.exception?.conflictReason).toBe('policy_review');

    // A single eligible referrer still resolves normally under review.
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 2 * DAY),
      subjectId: 'lead-solo',
    });
    const solo = await service.resolve(
      resolveInput('review', { targetId: 'lead-solo' }),
    );
    expect(solo.exception).toBeNull();
    expect(solo.referrals).toHaveLength(1);
  });

  it('drops self-referrals when disallowed and honors allowSelfReferral', async () => {
    await makePolicy('selfref');
    // Alice IS the prospect.
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 5 * DAY) });
    await makeTouch({ referrer: bob, at: new Date(NOW.getTime() - 1 * DAY) });

    const dropped = await service.resolve(
      resolveInput('selfref', { subjectProfileId: 'profile-alice' }),
    );
    expect(dropped.referrals).toHaveLength(1);
    expect(dropped.referrals[0].referrerId).toBe(bob.id);

    // Self-referral only → refused entirely.
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 1 * DAY),
      subjectId: 'lead-self',
    });
    const refused = await service.resolve(
      resolveInput('selfref', {
        targetId: 'lead-self',
        subjectProfileId: 'profile-alice',
      }),
    );
    expect(refused.refused).toBe('no_eligible_touches');

    // A policy that allows self-referrals credits the prospect-referrer.
    await makePolicy('selfok', { allowSelfReferral: true });
    const allowed = await service.resolve(
      resolveInput('selfok', {
        targetId: 'lead-self',
        subjectProfileId: 'profile-alice',
      }),
    );
    expect(allowed.referrals).toHaveLength(1);
    expect(allowed.referrals[0].referrerId).toBe(alice.id);
  });

  it('refuses existing clients unless the policy allows them', async () => {
    await makePolicy('existing');
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 1 * DAY) });

    const refused = await service.resolve(
      resolveInput('existing', { isExistingClient: true }),
    );
    expect(refused.refused).toBe('existing_client_ineligible');
    expect(refused.referrals).toHaveLength(0);
    expect(refused.exception).toBeNull();

    await makePolicy('existing-ok', { allowExistingClients: true });
    const allowed = await service.resolve(
      resolveInput('existing-ok', { isExistingClient: true }),
    );
    expect(allowed.referrals).toHaveLength(1);
  });

  it('refuses when no active policy version exists', async () => {
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 1 * DAY) });
    const result = await service.resolve(resolveInput('never-created'));
    expect(result.refused).toBe('no_active_policy');
  });

  it('resolve() is idempotent for attributed referrals and open exceptions', async () => {
    await makePolicy('idem');
    await makeTouch({ referrer: alice, at: new Date(NOW.getTime() - 2 * DAY) });

    const first = await service.resolve(resolveInput('idem'));
    const second = await service.resolve(resolveInput('idem'));
    expect(second.referrals).toHaveLength(1);
    expect(second.referrals[0].id).toBe(first.referrals[0].id);
    expect(await referrals.findByTarget('lead', 'lead-1')).toHaveLength(1);

    // Open exceptions replay too.
    const at = new Date(NOW.getTime() - 3 * DAY);
    await makeTouch({ referrer: alice, at, subjectId: 'lead-tied' });
    await makeTouch({ referrer: bob, at, subjectId: 'lead-tied' });
    const tied = await service.resolve(
      resolveInput('idem', { targetId: 'lead-tied' }),
    );
    const tiedAgain = await service.resolve(
      resolveInput('idem', { targetId: 'lead-tied' }),
    );
    expect(tiedAgain.exception?.id).toBe(tied.exception?.id);
    expect(await exceptions.findByTarget('lead', 'lead-tied')).toHaveLength(1);
  });

  describe('resolveException', () => {
    async function makeTieException() {
      await makePolicy('resolvable');
      const at = new Date(NOW.getTime() - 3 * DAY);
      const touchA = await makeTouch({ referrer: alice, at });
      const touchB = await makeTouch({ referrer: bob, at });
      const result = await service.resolve(resolveInput('resolvable'));
      const exception = result.exception;
      if (!exception) throw new Error('expected exception');
      return { exception, touchA, touchB };
    }

    it('requires a non-empty resolutionReason', async () => {
      const { exception } = await makeTieException();
      await expect(
        service.resolveException({
          exceptionId: exception.id ?? '',
          awards: [{ referrerId: alice.id ?? '', creditFraction: 1 }],
          resolutionReason: '   ',
          actorProfileId: 'profile-ops',
        }),
      ).rejects.toThrow(/non-empty resolutionReason/);
    });

    it('requires award fractions summing to 1.0', async () => {
      const { exception } = await makeTieException();
      await expect(
        service.resolveException({
          exceptionId: exception.id ?? '',
          awards: [
            { referrerId: alice.id ?? '', creditFraction: 0.5 },
            { referrerId: bob.id ?? '', creditFraction: 0.4 },
          ],
          resolutionReason: 'split the difference',
          actorProfileId: 'profile-ops',
        }),
      ).rejects.toThrow(/must sum to 1\.0/);
    });

    it('creates the awarded referrals and stamps the resolution audit', async () => {
      const { exception, touchA, touchB } = await makeTieException();
      const { referrals: awarded, exception: resolved } =
        await service.resolveException({
          exceptionId: exception.id ?? '',
          awards: [
            { referrerId: alice.id ?? '', creditFraction: 0.6 },
            { referrerId: bob.id ?? '', creditFraction: 0.4 },
          ],
          resolutionReason: 'both worked the account; weighted to the opener',
          actorProfileId: 'profile-ops',
          now: NOW,
        });

      expect(awarded).toHaveLength(2);
      expect(awarded.map((r) => r.creditFraction)).toEqual([0.6, 0.4]);
      expect(awarded.every((r) => r.status === 'attributed')).toBe(true);
      // Split semantics: one shared group.
      const groups = new Set(awarded.map((r) => r.splitGroupId));
      expect(groups.size).toBe(1);
      expect([...groups][0]).not.toBe('');
      // Policy pin flows from the exception metadata.
      expect(awarded[0].policyKey).toBe('resolvable');
      expect(awarded[0].policyVersion).toBe(1);
      // Winning touches recovered from the candidate list.
      expect(awarded[0].primaryTouchId).toBe(touchA.id);
      expect(awarded[1].primaryTouchId).toBe(touchB.id);

      expect(resolved.status).toBe('resolved');
      expect(resolved.resolutionMode).toBe('override');
      expect(resolved.resolvedByProfileId).toBe('profile-ops');
      expect(resolved.resolvedAt?.toISOString()).toBe(NOW.toISOString());
      expect(resolved.getResolvedReferralIds()).toEqual(
        awarded.map((r) => r.id ?? ''),
      );

      // A resolved exception cannot be resolved twice.
      await expect(
        service.resolveException({
          exceptionId: exception.id ?? '',
          awards: [{ referrerId: alice.id ?? '', creditFraction: 1 }],
          resolutionReason: 'again',
          actorProfileId: 'profile-ops',
        }),
      ).rejects.toThrow(/already resolved/);
    });
  });

  describe('override', () => {
    it('re-attributes: disqualifies the displaced credit and writes a resolved audit exception', async () => {
      await makePolicy('overridable');
      await makeTouch({
        referrer: alice,
        at: new Date(NOW.getTime() - 2 * DAY),
      });
      const original = await service.resolve(resolveInput('overridable'));
      const displacedId = original.referrals[0].id ?? '';

      const { referrals: awarded, exception } = await service.override({
        targetKind: 'lead',
        targetId: 'lead-1',
        programId,
        awards: [{ referrerId: bob.id ?? '', creditFraction: 1 }],
        resolutionReason: 'partner desk correction: Bob made the intro',
        actorProfileId: 'profile-ops',
        now: NOW,
      });

      expect(awarded).toHaveLength(1);
      expect(awarded[0].referrerId).toBe(bob.id);
      expect(awarded[0].status).toBe('attributed');
      expect(awarded[0].policyKey).toBe('overridable');

      const displaced = await referrals.get({ id: displacedId });
      expect(displaced?.status).toBe('disqualified');
      expect(displaced?.getMetadata().overriddenByExceptionId).toBe(
        exception.id,
      );

      expect(exception.status).toBe('resolved');
      expect(exception.conflictReason).toBe('override');
      expect(exception.resolutionMode).toBe('override');
      const candidateReferrers = exception
        .getCandidates()
        .map((c) => c.referrerId);
      expect(candidateReferrers).toContain(alice.id);
      expect(candidateReferrers).toContain(bob.id);
      expect(exception.getResolvedReferralIds()).toEqual([awarded[0].id ?? '']);

      // The target now resolves to Bob idempotently.
      const after = await service.resolve(resolveInput('overridable'));
      expect(after.referrals).toHaveLength(1);
      expect(after.referrals[0].id).toBe(awarded[0].id);
    });

    it('requires a reason and refuses to override qualified referrals', async () => {
      await expect(
        service.override({
          targetKind: 'lead',
          targetId: 'lead-1',
          programId,
          awards: [{ referrerId: bob.id ?? '', creditFraction: 1 }],
          resolutionReason: '',
          actorProfileId: 'profile-ops',
        }),
      ).rejects.toThrow(/non-empty resolutionReason/);

      // A qualified referral is downstream-governed: override refuses.
      await referrals.create({
        referrerId: alice.id ?? '',
        programId,
        targetKind: 'lead',
        targetId: 'lead-q',
        status: 'qualified',
      });
      await expect(
        service.override({
          targetKind: 'lead',
          targetId: 'lead-q',
          programId,
          awards: [{ referrerId: bob.id ?? '', creditFraction: 1 }],
          resolutionReason: 'nope',
          actorProfileId: 'profile-ops',
        }),
      ).rejects.toThrow(QualifiedReferralOverrideError);
    });
  });

  it('sweepExpired expires lapsed attributed referrals only', async () => {
    await makePolicy('sweep', { windowDays: 10 });
    await makeTouch({
      referrer: alice,
      at: new Date(NOW.getTime() - 2 * DAY),
      subjectId: 'lead-old',
    });
    await makeTouch({
      referrer: bob,
      at: new Date(NOW.getTime() - 2 * DAY),
      subjectId: 'lead-fresh',
    });

    // Attributed at NOW → expires NOW + 10d.
    const old = await service.resolve(
      resolveInput('sweep', { targetId: 'lead-old' }),
    );
    // Attributed 5 days later → still inside its window at sweep time.
    const fresh = await service.resolve(
      resolveInput('sweep', {
        targetId: 'lead-fresh',
        now: new Date(NOW.getTime() + 5 * DAY),
      }),
    );

    const sweepAt = new Date(NOW.getTime() + 12 * DAY);
    const swept = await referrals.sweepExpired(sweepAt);
    expect(swept.map((r) => r.id)).toEqual([old.referrals[0].id]);
    expect((await referrals.get({ id: old.referrals[0].id }))?.status).toBe(
      'expired',
    );
    expect((await referrals.get({ id: fresh.referrals[0].id }))?.status).toBe(
      'attributed',
    );
  });
});
