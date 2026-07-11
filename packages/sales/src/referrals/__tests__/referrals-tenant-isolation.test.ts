/**
 * Tenant isolation tests for the referrals module. Every model is
 * `@TenantScoped({ mode: 'optional' })`: under an ambient `withTenant()`
 * context rows auto-populate `tenantId` and reads auto-filter; without a
 * context rows stay global (`tenantId: null`).
 *
 * Mirrors the sibling crm/commissions isolation tests — real in-memory
 * SQLite, tenancy enabled, no DB mocking.
 */

import { getTestDatabase } from '@happyvertical/smrt-core';
import {
  disableTenancy,
  enableTenancy,
  withTenant,
} from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ReferralCollection } from '../collections/ReferralCollection.js';
import { ReferralProgramCollection } from '../collections/ReferralProgramCollection.js';
import { ReferralTouchCollection } from '../collections/ReferralTouchCollection.js';
import { ReferrerCollection } from '../collections/ReferrerCollection.js';

describe('Referrals tenant isolation', () => {
  let db: DatabaseInterface;
  let referrals: ReferralCollection;
  let touches: ReferralTouchCollection;
  let referrers: ReferrerCollection;
  let programs: ReferralProgramCollection;

  beforeEach(async () => {
    enableTenancy();
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    referrals = await ReferralCollection.create({ db });
    touches = await ReferralTouchCollection.create({ db });
    referrers = await ReferrerCollection.create({ db });
    programs = await ReferralProgramCollection.create({ db });
  });

  afterEach(async () => {
    disableTenancy();
    if (db && typeof db.close === 'function') {
      await db.close();
    }
  });

  async function makeTenantFixture(tenantId: string) {
    return await withTenant({ tenantId }, async () => {
      const referrer = await referrers.create({
        profileId: `profile-${tenantId}`,
        displayName: `Referrer of ${tenantId}`,
        status: 'active',
      });
      const program = await programs.create({
        key: 'partners',
        name: `Program of ${tenantId}`,
      });
      return { referrer, program };
    });
  }

  it('auto-populates tenantId on referrals and touches inside withTenant', async () => {
    const { referrer, program } = await makeTenantFixture('tenant-a');

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const referral = await referrals.create({
        referrerId: referrer.id ?? '',
        programId: program.id ?? '',
        targetKind: 'lead',
        targetId: 'lead-1',
        status: 'pending',
      });
      expect(referral.tenantId).toBe('tenant-a');

      const touch = await touches.create({
        referrerId: referrer.id ?? '',
        programId: program.id ?? '',
        kind: 'click',
        subjectKind: 'lead',
        subjectId: 'lead-1',
      });
      expect(touch.tenantId).toBe('tenant-a');
    });
  });

  it('does not list tenant A referrals or touches under tenant B', async () => {
    const a = await makeTenantFixture('tenant-a');
    const b = await makeTenantFixture('tenant-b');

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await referrals.create({
        referrerId: a.referrer.id ?? '',
        programId: a.program.id ?? '',
        targetKind: 'lead',
        targetId: 'lead-a1',
        status: 'pending',
      });
      await referrals.create({
        referrerId: a.referrer.id ?? '',
        programId: a.program.id ?? '',
        targetKind: 'lead',
        targetId: 'lead-a2',
        status: 'pending',
      });
      await touches.create({
        referrerId: a.referrer.id ?? '',
        programId: a.program.id ?? '',
        kind: 'click',
        subjectKind: 'lead',
        subjectId: 'lead-a1',
      });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await referrals.create({
        referrerId: b.referrer.id ?? '',
        programId: b.program.id ?? '',
        targetKind: 'lead',
        targetId: 'lead-b1',
        status: 'pending',
      });
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const rows = await referrals.list({});
      expect(rows).toHaveLength(2);
      expect(rows.every((row) => row.tenantId === 'tenant-a')).toBe(true);
      expect(await touches.findBySubject('lead', 'lead-a1')).toHaveLength(1);
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      const rows = await referrals.list({});
      expect(rows).toHaveLength(1);
      expect(rows[0].targetId).toBe('lead-b1');
      // Tenant A's evidence is invisible here.
      expect(await touches.findBySubject('lead', 'lead-a1')).toHaveLength(0);
      expect(await touches.list({})).toHaveLength(0);
    });
  });

  it('scopes target finders to the ambient tenant', async () => {
    const a = await makeTenantFixture('tenant-a');
    const b = await makeTenantFixture('tenant-b');

    // The SAME external target id exists in both tenants.
    await withTenant({ tenantId: 'tenant-a' }, async () => {
      await referrals.create({
        referrerId: a.referrer.id ?? '',
        programId: a.program.id ?? '',
        targetKind: 'client',
        targetId: 'client-shared',
        status: 'qualified',
      });
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      await referrals.create({
        referrerId: b.referrer.id ?? '',
        programId: b.program.id ?? '',
        targetKind: 'client',
        targetId: 'client-shared',
        status: 'pending',
      });
    });

    await withTenant({ tenantId: 'tenant-a' }, async () => {
      const qualified = await referrals.findQualifiedByTarget(
        'client',
        'client-shared',
      );
      expect(qualified).toHaveLength(1);
      expect(qualified[0].tenantId).toBe('tenant-a');
    });
    await withTenant({ tenantId: 'tenant-b' }, async () => {
      expect(
        await referrals.findQualifiedByTarget('client', 'client-shared'),
      ).toHaveLength(0);
      expect(
        await referrals.findByTarget('client', 'client-shared'),
      ).toHaveLength(1);
    });
  });

  it('allows global (tenantId=null) rows when no context is set', async () => {
    const referrer = await referrers.create({
      profileId: 'profile-global',
      status: 'active',
    });
    const program = await programs.create({ key: 'global-program' });
    const referral = await referrals.create({
      referrerId: referrer.id ?? '',
      programId: program.id ?? '',
      targetKind: 'lead',
      targetId: 'lead-global',
      status: 'pending',
    });
    expect(referral.tenantId).toBeNull();
  });
});
