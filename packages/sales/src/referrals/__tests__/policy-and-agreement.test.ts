/**
 * Versioned-terms tests for AttributionPolicy and ReferralAgreement:
 * amendments insert `version + 1` drafts, `latestActiveByKey` /
 * `activeFor` resolve the governing version, active rows are
 * immutability-guarded (WeakMap-serialize pattern), and status transitions
 * are save-guarded.
 *
 * Real in-memory SQLite — no mocks of database operations.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AttributionPolicyCollection } from '../collections/AttributionPolicyCollection.js';
import { ReferralAgreementCollection } from '../collections/ReferralAgreementCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';

describe('AttributionPolicy versioning', () => {
  let db: DatabaseInterface;
  let policies: AttributionPolicyCollection;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    policies = await AttributionPolicyCollection.create({ db });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('creates an amendment as a version+1 draft copying the previous fields', async () => {
    const v1 = await policies.create({
      policyKey: 'standard',
      version: 1,
      status: 'draft',
      windowDays: 30,
      creditMode: 'first_touch',
      conflictBehavior: 'auto',
      eligibleServices: JSON.stringify(['solar-retrofit']),
    });
    v1.activate();
    await v1.save();

    const v2 = await policies.createAmendment('standard', { windowDays: 60 });
    expect(v2.version).toBe(2);
    expect(v2.status).toBe('draft');
    expect(v2.windowDays).toBe(60);
    // Unchanged fields copy over from the latest version.
    expect(v2.creditMode).toBe('first_touch');
    expect(v2.getEligibleServices()).toEqual(['solar-retrofit']);
    // The source version is untouched.
    const reloaded = await policies.get({ id: v1.id });
    expect(reloaded?.status).toBe('active');
    expect(reloaded?.windowDays).toBe(30);
  });

  it('refuses to amend a policy key that has no versions', async () => {
    await expect(policies.createAmendment('missing')).rejects.toThrow(
      /no versions exist/,
    );
  });

  it('latestActiveByKey returns the highest ACTIVE version only', async () => {
    const v1 = await policies.create({
      policyKey: 'standard',
      version: 1,
      status: 'active',
      windowDays: 30,
    });
    expect((await policies.latestActiveByKey('standard'))?.version).toBe(1);

    const v2 = await policies.createAmendment('standard', { windowDays: 45 });
    // Draft amendments do not govern yet.
    expect((await policies.latestActiveByKey('standard'))?.version).toBe(1);

    v2.activate();
    await v2.save();
    v1.supersede();
    await v1.save();
    const governing = await policies.latestActiveByKey('standard');
    expect(governing?.version).toBe(2);
    expect(governing?.windowDays).toBe(45);

    expect(await policies.latestActiveByKey('unknown')).toBeNull();
  });

  it('latestActiveByKey ignores active policy versions not yet in effect (codex P2)', async () => {
    const v1 = await policies.create({
      policyKey: 'effective-policy',
      version: 1,
      status: 'active',
      windowDays: 30,
      effectiveFrom: null,
    });
    expect(v1.version).toBe(1);

    // A future-dated amendment activated ahead of its effective date.
    const v2 = await policies.createAmendment('effective-policy', {
      windowDays: 90,
      effectiveFrom: new Date('2026-09-01T00:00:00Z'),
    });
    v2.activate();
    await v2.save();

    // Before the effective date the in-force version still governs…
    const before = await policies.latestActiveByKey(
      'effective-policy',
      new Date('2026-08-15T00:00:00Z'),
    );
    expect(before?.version).toBe(1);
    expect(before?.windowDays).toBe(30);
    // …and from the effective date on, the amendment takes over.
    const after = await policies.latestActiveByKey(
      'effective-policy',
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(after?.version).toBe(2);
  });

  it('tenants do not collide on the same policy key/version (codex P1)', async () => {
    const a = await policies.create({
      policyKey: 'default',
      version: 1,
      tenantId: 'tenant-a',
      windowDays: 30,
    });
    const b = await policies.create({
      policyKey: 'default',
      version: 1,
      tenantId: 'tenant-b',
      windowDays: 60,
    });
    expect(a.id).not.toBe(b.id);
    expect((await policies.get({ id: a.id }))?.windowDays).toBe(30);
    expect((await policies.get({ id: b.id }))?.windowDays).toBe(60);
  });

  it('freezes policy-defining fields once active (status transitions stay allowed)', async () => {
    await policies.create({
      policyKey: 'frozen',
      version: 1,
      status: 'active',
      windowDays: 30,
    });

    const loaded = await policies.get({ id: (await policies.list({}))[0].id });
    if (!loaded) throw new Error('expected policy');
    loaded.windowDays = 90;
    await expect(loaded.save()).rejects.toThrow(/immutable once the policy/);

    // A freshly loaded instance can still transition status.
    const again = await policies.latestActiveByKey('frozen');
    if (!again) throw new Error('expected active policy');
    again.retire();
    await expect(again.save()).resolves.toBeDefined();
    expect(await policies.latestActiveByKey('frozen')).toBeNull();
  });

  it('save-guards illegal status transitions on persisted rows', async () => {
    const policy = await policies.create({
      policyKey: 'guarded',
      version: 1,
      status: 'active',
      windowDays: 30,
    });

    // Raw assignment backwards: active → draft is not an edge.
    policy.status = 'draft';
    await expect(policy.save()).rejects.toThrow(/illegal status transition/);

    // Terminal statuses reject transition methods outright.
    const fresh = await policies.get({ id: policy.id });
    if (!fresh) throw new Error('expected policy');
    fresh.supersede();
    await fresh.save();
    expect(() => fresh.retire()).toThrow(/cannot retire/);
    expect(() => fresh.supersede()).toThrow(/cannot supersede/);
  });

  it('validates terms on activation', async () => {
    const bad = await policies.create({
      policyKey: 'invalid',
      version: 1,
      status: 'draft',
      windowDays: 0,
    });
    expect(() => bad.activate()).toThrow(/windowDays must be a positive/);

    const badList = await policies.create({
      policyKey: 'invalid-list',
      version: 1,
      status: 'draft',
      windowDays: 30,
      eligibleRegions: 'not-json',
    });
    expect(() => badList.activate()).toThrow(/JSON array of strings/);
  });
});

describe('ReferralAgreement versioning', () => {
  let db: DatabaseInterface;
  let agreements: ReferralAgreementCollection;
  let referrerId: string;
  let programId: string;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    agreements = await ReferralAgreementCollection.create({ db });
    const referrers = await ReferrerCollection.create({ db });
    const programs = await ReferralProgramCollection.create({ db });
    referrerId =
      (
        await referrers.create({
          profileId: 'profile-1',
          displayName: 'Jordan Partner',
          status: 'active',
        })
      ).id ?? '';
    programId =
      (await programs.create({ key: 'partners', name: 'Partner program' }))
        .id ?? '';
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  it('requires a commissionPlanKey to activate', async () => {
    const draft = await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'draft',
    });
    expect(() => draft.activate()).toThrow(/commissionPlanKey is required/);

    draft.commissionPlanKey = 'referral-standard';
    draft.activate();
    await expect(draft.save()).resolves.toBeDefined();
  });

  it('activeFor returns the active version whose effective window contains the instant', async () => {
    await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: 'referral-standard',
      effectiveFrom: new Date('2026-01-01T00:00:00Z'),
      effectiveTo: new Date('2026-06-30T23:59:59Z'),
    });

    expect(
      await agreements.activeFor(
        referrerId,
        programId,
        new Date('2026-03-01T00:00:00Z'),
      ),
    ).not.toBeNull();
    // Before the window starts and after it ends: nothing governs.
    expect(
      await agreements.activeFor(
        referrerId,
        programId,
        new Date('2025-12-31T00:00:00Z'),
      ),
    ).toBeNull();
    expect(
      await agreements.activeFor(
        referrerId,
        programId,
        new Date('2026-07-02T00:00:00Z'),
      ),
    ).toBeNull();
  });

  it('activeFor ignores drafts and terminal versions and prefers the highest active version', async () => {
    const v1 = await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: 'referral-standard',
    });
    const v2 = await agreements.createAmendment(referrerId, programId, {
      clearingDays: 45,
    });
    expect(v2.version).toBe(2);
    // Draft amendment does not govern.
    expect((await agreements.activeFor(referrerId, programId))?.version).toBe(
      1,
    );

    v2.activate();
    await v2.save();
    // Both momentarily active — the newest version wins.
    expect((await agreements.activeFor(referrerId, programId))?.version).toBe(
      2,
    );

    v1.supersede();
    await v1.save();
    const governing = await agreements.activeFor(referrerId, programId);
    expect(governing?.version).toBe(2);
    expect(governing?.clearingDays).toBe(45);

    v2.terminate();
    await v2.save();
    expect(await agreements.activeFor(referrerId, programId)).toBeNull();
  });

  it('freezes terms once active but keeps evidence fields and effectiveTo mutable', async () => {
    await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: 'referral-standard',
      clearingDays: 30,
    });

    const frozen = await agreements.activeFor(referrerId, programId);
    if (!frozen) throw new Error('expected active agreement');
    frozen.clearingDays = 0;
    await expect(frozen.save()).rejects.toThrow(/terms are immutable/);

    // Evidence and end-dating remain legal on active rows.
    const evidence = await agreements.activeFor(referrerId, programId);
    if (!evidence) throw new Error('expected active agreement');
    evidence.executedArtifactUrl = 'https://esign.example/artifact.pdf';
    evidence.executedArtifactHash = 'sha256:abc';
    evidence.setAcceptanceEvidence({ signer: 'profile-1' });
    evidence.effectiveTo = new Date('2026-12-31T00:00:00Z');
    await expect(evidence.save()).resolves.toBeDefined();
  });

  it('save-guards illegal agreement status transitions', async () => {
    const agreement = await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: 'referral-standard',
    });
    agreement.status = 'draft';
    await expect(agreement.save()).rejects.toThrow(/illegal status transition/);

    const fresh = await agreements.activeFor(referrerId, programId);
    if (!fresh) throw new Error('expected active agreement');
    fresh.terminate();
    await fresh.save();
    expect(() => fresh.activate()).toThrow(/cannot activate/);
    expect(() => fresh.supersede()).toThrow(/cannot supersede/);
  });

  it('copies fields into amendments and applies changes', async () => {
    await agreements.create({
      referrerId,
      programId,
      version: 1,
      status: 'active',
      commissionPlanKey: 'referral-standard',
      commissionPlanVersion: 3,
      clearingDays: 30,
      approvalMode: 'auto',
      contractRef: 'contract-uuid',
    });
    const amendment = await agreements.createAmendment(referrerId, programId, {
      commissionPlanVersion: 0,
    });
    expect(amendment.version).toBe(2);
    expect(amendment.status).toBe('draft');
    expect(amendment.commissionPlanKey).toBe('referral-standard');
    expect(amendment.commissionPlanVersion).toBe(0);
    expect(amendment.clearingDays).toBe(30);
    expect(amendment.approvalMode).toBe('auto');
    expect(amendment.contractRef).toBe('contract-uuid');
  });

  it('refuses to amend a pair with no versions', async () => {
    await expect(
      agreements.createAmendment('missing-referrer', programId),
    ).rejects.toThrow(/no versions exist/);
  });
});
