import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { expect, it, vi } from 'vitest';
import {
  LegalMember,
  LegalMemberCollection,
  LegalMemberReferenceCollection,
  LegalMemberStatusHistory,
  LegalMemberStatusHistoryCollection,
  MemberEligibilitySnapshot,
  MemberEligibilitySnapshotCollection,
  MemberRegisterService,
} from '../../member-register/index.js';

/** Run identical failure/retry probes through each real supported SQL adapter. */
export function memberRegisterAtomicityTests(
  database: () => Promise<DatabaseInterface>,
): void {
  async function fixture() {
    const db = await database();
    const tenantId = crypto.randomUUID();
    const register = new MemberRegisterService(db, { tenantId });
    const klass = await register.addClass({ key: 'worker', name: 'Worker' });
    const input = {
      memberClassId: klass.id as string,
      kind: 'individual' as const,
      displayName: 'Pat',
      joinedOn: '2026-01-01',
    };
    return { db, tenantId, register, input };
  }

  it('denies foreign tenant writes and malformed register input', async () => {
    const { db, tenantId, register, input } = await fixture();
    const other = new MemberRegisterService(db, {
      tenantId: crypto.randomUUID(),
    });
    await expect(other.enroll(input)).rejects.toMatchObject({
      code: 'MEMBER_REGISTER_NOT_FOUND',
    });
    for (const invalid of [
      { ...input, kind: 'unknown' as 'individual' },
      { ...input, displayName: '' },
      { ...input, joinedOn: '2026-02-30' },
    ])
      await expect(register.enroll(invalid)).rejects.toMatchObject({
        code: 'MEMBER_REGISTER_INVALID',
      });
    const member = await register.enroll(input);
    await expect(
      other.setStatus(member.id as string, {
        status: 'active',
        effectiveOn: '2026-02-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_NOT_FOUND' });
    await expect(
      other.appoint(member.id as string, {
        role: 'secretary',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_NOT_FOUND' });
    await expect(
      other.addReference(member.id as string, {
        kind: 'dues',
        sourceType: 'ledger',
        sourceId: 'external',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_NOT_FOUND' });
    await expect(
      register.setStatus(member.id as string, {
        status: 'unknown' as 'active',
        effectiveOn: '2026-02-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
    await expect(
      register.appoint(member.id as string, {
        role: 'secretary',
        effectiveFrom: '2026-02-01',
        effectiveTo: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
    await expect(
      register.addReference(member.id as string, {
        kind: 'unknown' as 'dues',
        sourceType: 'ledger',
        sourceId: 'external',
        effectiveFrom: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
    await expect(
      register.addReference(member.id as string, {
        kind: 'dues',
        sourceType: 'ledger',
        sourceId: 'external',
        effectiveFrom: '2026-02-01',
        effectiveTo: '2026-01-01',
      }),
    ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
    await withTenant({ tenantId }, async () => {
      await expect(other.asOf('2026-02-01')).rejects.toMatchObject({
        code: 'MEMBER_REGISTER_TENANT_MISMATCH',
      });
    });
  });

  it('persists same-day correction order and resolves reinstatement from history', async () => {
    const { db, tenantId, register, input } = await fixture();
    const member = await register.enroll(input);
    await register.setStatus(member.id as string, {
      status: 'resigned',
      effectiveOn: '2026-02-01',
    });
    await register.setStatus(member.id as string, {
      status: 'active',
      effectiveOn: '2026-02-01',
    });
    await register.setStatus(member.id as string, {
      status: 'suspended',
      effectiveOn: '2099-01-01',
    });
    expect((await register.asOf('2026-02-01'))[0]).toMatchObject({
      eligible: true,
    });
    expect((await register.asOf('2099-01-01'))[0]).toMatchObject({
      eligible: false,
    });
    const members = await LegalMemberCollection.create({ db });
    expect(await members.get({ id: member.id, tenantId })).toMatchObject({
      status: 'active',
      leftOn: null,
    });
    await register.addReference(member.id as string, {
      kind: 'dues',
      sourceType: 'ledger',
      sourceId: 'future',
      authoritative: true,
      effectiveFrom: '2026-04-01',
    });
    expect(
      (
        await register.asOf('2026-03-01', {
          requireAuthoritativeKinds: ['dues'],
        })
      )[0],
    ).toMatchObject({ eligible: false });
    const references = await LegalMemberReferenceCollection.create({ db });
    const reference = (await references.list({ where: { tenantId } }))[0];
    reference.sourceId = 'rewrite';
    await expect(reference.save()).rejects.toThrow('append-only');
    const histories = await LegalMemberStatusHistoryCollection.create({ db });
    const history = await histories.list({ where: { tenantId } });
    expect(history.map((entry) => entry.sequence).sort()).toEqual([1, 2, 3, 4]);
    history[0].reason = 'rewrite';
    await expect(history[0].save()).rejects.toThrow('append-only');
  });

  it('rolls back enroll after both inserts and retries without orphan members', async () => {
    const { db, tenantId, register, input } = await fixture();
    const save = LegalMemberStatusHistory.prototype.save;
    const fault = vi
      .spyOn(LegalMemberStatusHistory.prototype, 'save')
      .mockImplementationOnce(async function (this: LegalMemberStatusHistory) {
        await save.call(this);
        throw new Error('injected history failure');
      });
    try {
      await expect(register.enroll(input)).rejects.toThrow(
        'injected history failure',
      );
    } finally {
      fault.mockRestore();
    }
    const members = await LegalMemberCollection.create({ db });
    const history = await LegalMemberStatusHistoryCollection.create({ db });
    expect(await members.list({ where: { tenantId } })).toHaveLength(0);
    expect(await history.list({ where: { tenantId } })).toHaveLength(0);
    await register.enroll(input);
    expect(await members.list({ where: { tenantId } })).toHaveLength(1);
    expect(await history.list({ where: { tenantId } })).toHaveLength(1);
  });

  it('rolls back history and current member state when status save fails', async () => {
    const { db, tenantId, register, input } = await fixture();
    const member = await register.enroll(input);
    const save = LegalMember.prototype.save;
    const fault = vi
      .spyOn(LegalMember.prototype, 'save')
      .mockImplementationOnce(async function (this: LegalMember) {
        await save.call(this);
        throw new Error('injected member failure');
      });
    const change = { status: 'resigned' as const, effectiveOn: '2026-02-01' };
    try {
      await expect(
        register.setStatus(member.id as string, change),
      ).rejects.toThrow('injected member failure');
    } finally {
      fault.mockRestore();
    }
    const members = await LegalMemberCollection.create({ db });
    const history = await LegalMemberStatusHistoryCollection.create({ db });
    expect(await members.get({ id: member.id, tenantId })).toMatchObject({
      status: 'active',
      leftOn: null,
    });
    expect(await history.list({ where: { tenantId } })).toHaveLength(1);
    await register.setStatus(member.id as string, change);
    expect(await members.get({ id: member.id, tenantId })).toMatchObject({
      status: 'resigned',
      leftOn: '2026-02-01',
    });
    expect(
      (await history.list({ where: { tenantId } }))
        .map((entry) => entry.sequence)
        .sort(),
    ).toEqual([1, 2]);
  });

  it('rolls back a failed multi-member snapshot batch and preserves immutable retry evidence', async () => {
    const { db, tenantId, register, input } = await fixture();
    await register.enroll(input);
    await register.enroll({ ...input, displayName: 'Robin' });
    const save = MemberEligibilitySnapshot.prototype.save;
    let writes = 0;
    const fault = vi
      .spyOn(MemberEligibilitySnapshot.prototype, 'save')
      .mockImplementation(async function (this: MemberEligibilitySnapshot) {
        const result = await save.call(this);
        if (++writes === 2) throw new Error('injected snapshot failure');
        return result;
      });
    try {
      await expect(register.asOf('2026-02-01')).rejects.toThrow(
        'injected snapshot failure',
      );
    } finally {
      fault.mockRestore();
    }
    expect(writes).toBe(2);
    const snapshots = await MemberEligibilitySnapshotCollection.create({ db });
    expect(await snapshots.list({ where: { tenantId } })).toHaveLength(0);
    expect(await register.asOf('2026-02-01')).toHaveLength(2);
    const stored = await snapshots.list({ where: { tenantId } });
    expect(stored).toHaveLength(2);
    stored[0].reason = 'rewrite';
    await expect(stored[0].save()).rejects.toThrow('immutable');
    await expect(stored[0].delete()).rejects.toThrow('cannot be deleted');
  });
}
