import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemberEligibilitySnapshotCollection,
  MemberRegisterService,
} from '../member-register/index.js';

describe('generic legal member register', () => {
  let close: (() => Promise<void>) | undefined;
  async function service(tenantId: string) {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    close = async () => {
      await db.close?.();
    };
    return new MemberRegisterService(db, { tenantId, actorRef: 'registrar' });
  }
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('keeps worker-co-op legal membership independent from login and subscription concepts', async () => {
    const register = await service('worker-coop');
    const worker = await register.addClass({ key: 'worker', name: 'Worker' });
    const supporting = await register.addClass({
      key: 'supporting',
      name: 'Supporting member',
    });
    const alex = await register.enroll({
      memberClassId: worker.id as string,
      kind: 'individual',
      displayName: 'Alex Rivera',
      joinedOn: '2026-01-05',
      externalPartyRef: 'payroll:alex',
    });
    const studio = await register.enroll({
      memberClassId: supporting.id as string,
      kind: 'organisation',
      displayName: 'River Studio Ltd.',
      joinedOn: '2026-01-07',
      externalPartyRef: 'crm:studio',
    });
    expect(alex.userId).toBeNull();
    expect(studio.kind).toBe('organisation');
    await register.addReference(alex.id as string, {
      kind: 'share',
      sourceType: '@happyvertical/smrt-ledgers:JournalEntry',
      sourceId: 'share-1',
      authoritative: true,
    });
    await register.addReference(alex.id as string, {
      kind: 'dues',
      sourceType: '@happyvertical/smrt-subscriptions:TenantSubscription',
      sourceId: 'dues-1',
      authoritative: true,
    });
    await register.appoint(alex.id as string, {
      role: 'treasurer',
      effectiveFrom: '2026-01-05',
      authority: { approvesExternalPayments: true },
    });
    await register.appoint(studio.id as string, {
      role: 'secretary',
      effectiveFrom: '2026-01-07',
    });
    const rows = await register.asOf('2026-02-01', {
      memberClassKeys: ['worker', 'supporting'],
      requireAuthoritativeKinds: ['share', 'dues'],
    });
    expect(rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ memberId: alex.id, eligible: true }),
        expect.objectContaining({
          memberId: studio.id,
          eligible: false,
          reason: expect.stringContaining('authoritative evidence unavailable'),
        }),
      ]),
    );
    expect(MemberRegisterService.exportJson(rows)).toContain('2026-02-01');
    expect(MemberRegisterService.exportCsv(rows)).toContain('memberClassKey');
    expect(
      MemberRegisterService.exportCsv([
        { ...rows[0], displayName: '=SUM(A1:A2)', memberClassKey: '@worker' },
      ]),
    ).toContain('"\'=SUM(A1:A2)"');
  });

  it('records status history and resolves record-date state without cross-tenant leakage', async () => {
    const db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    close = async () => {
      await db.close?.();
    };
    const alpha = new MemberRegisterService(db, { tenantId: 'alpha' });
    const beta = new MemberRegisterService(db, { tenantId: 'beta' });
    const klass = await alpha.addClass({ key: 'worker', name: 'Worker' });
    const member = await alpha.enroll({
      memberClassId: klass.id as string,
      kind: 'individual',
      displayName: 'Pat Lee',
      joinedOn: '2026-01-01',
    });
    const before = await alpha.asOf('2026-02-01');
    await alpha.setStatus(member.id as string, {
      status: 'suspended',
      effectiveOn: '2026-03-01',
      reason: 'review',
    });
    expect((await alpha.asOf('2026-02-01'))[0]).toMatchObject({
      eligible: true,
    });
    expect((await alpha.asOf('2026-03-01'))[0]).toMatchObject({
      eligible: false,
      reason: 'status suspended excluded by policy',
    });
    expect(await beta.asOf('2026-03-01')).toEqual([]);
    expect(await beta.asOf('2026-03-01')).toEqual([]);
    const stored = await withTenant({ tenantId: 'alpha' }, async () => {
      const snapshots = await MemberEligibilitySnapshotCollection.create({
        db,
      });
      return snapshots.list({ where: { tenantId: 'alpha' } });
    });
    expect(stored).toHaveLength(3);
    expect(before).toEqual([expect.objectContaining({ eligible: true })]);
    expect(stored.some((snapshot) => snapshot.eligible)).toBe(true);
    await expect(stored[0].delete()).rejects.toThrow('cannot be deleted');
  });
});
