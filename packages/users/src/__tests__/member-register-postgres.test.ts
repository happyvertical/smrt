import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  LegalMember,
  LegalMemberCollection,
  LegalMemberStatusHistoryCollection,
  MemberRegisterService,
} from '../member-register/index.js';

import { memberRegisterAtomicityTests } from './helpers/member-register-atomicity.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres('member register (postgres)', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });
  memberRegisterAtomicityTests(async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Profile',
        'ProfileType',
        'MemberClass',
        'LegalMember',
        'LegalMemberStatusHistory',
        'LegalMemberReference',
        'MemberOfficerAppointment',
        'MemberEligibilitySnapshot',
      ],
    });
    cleanup = isolated.cleanup;
    return isolated.baseDb;
  });

  it('does not attach returned members to a later transaction reusing the released connection', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'MemberClass',
        'LegalMember',
        'LegalMemberStatusHistory',
      ],
    });
    cleanup = isolated.cleanup;
    const db = isolated.baseDb;
    const tenantId = crypto.randomUUID();
    const register = new MemberRegisterService(db, { tenantId });
    const klass = await register.addClass({ key: 'worker', name: 'Worker' });
    const enrolled = await register.enroll({
      memberClassId: klass.id as string,
      kind: 'individual',
      displayName: 'Original',
      joinedOn: '2026-01-01',
    });
    for (const operation of ['enroll', 'setStatus']) {
      const member =
        operation === 'enroll'
          ? enrolled
          : await register.setStatus(enrolled.id as string, {
              status: 'active',
              effectiveOn: '2026-02-01',
            });
      const name = crypto.randomUUID();
      await expect(
        db.transaction(async () => {
          await withTenant({ tenantId }, async () => {
            member.displayName = name;
            await member.save();
          });
          throw new Error('unrelated transaction aborted');
        }),
      ).rejects.toThrow('unrelated transaction aborted');
      const members = await LegalMemberCollection.create({ db });
      expect(
        (await members.get({ id: member.id, tenantId }))?.displayName,
      ).toBe(name);
    }
  });

  it('rolls back the competing same-day history entry through the member revision guard', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Profile',
        'ProfileType',
        'MemberClass',
        'LegalMember',
        'LegalMemberStatusHistory',
        'LegalMemberReference',
        'MemberOfficerAppointment',
        'MemberEligibilitySnapshot',
      ],
    });
    cleanup = isolated.cleanup;
    const tenantId = crypto.randomUUID();
    const register = new MemberRegisterService(isolated.baseDb, { tenantId });
    const klass = await register.addClass({ key: 'worker', name: 'Worker' });
    const member = await register.enroll({
      memberClassId: klass.id as string,
      kind: 'individual',
      displayName: 'Pat',
      joinedOn: '2026-01-01',
    });
    let release = () => {};
    const bothReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    const save = LegalMember.prototype.save;
    const barrier = vi
      .spyOn(LegalMember.prototype, 'save')
      .mockImplementation(async function (this: LegalMember) {
        if (++arrivals === 2) release();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            bothReady,
            new Promise<void>((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(new Error('Concurrent writers did not reach barrier')),
                10000,
              );
            }),
          ]);
          return await save.call(this);
        } finally {
          clearTimeout(timeout);
        }
      });
    const changes = [
      { status: 'suspended' as const, effectiveOn: '2026-02-01' },
      { status: 'active' as const, effectiveOn: '2026-02-01' },
    ];
    let results: PromiseSettledResult<LegalMember>[];
    try {
      results = await Promise.allSettled(
        changes.map((change) =>
          register.setStatus(member.id as string, change),
        ),
      );
    } finally {
      release();
      barrier.mockRestore();
    }
    expect(arrivals).toBe(2);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const loser = results.findIndex((result) => result.status === 'rejected');
    expect(results[loser]).toMatchObject({
      status: 'rejected',
      reason: { code: 'RUNTIME_REVISION_CONFLICT' },
    });
    const histories = await LegalMemberStatusHistoryCollection.create({
      db: isolated.baseDb,
    });
    const history = await histories.list({ where: { tenantId } });
    expect(history.map((row) => row.sequence).sort()).toEqual([1, 2]);
    const winner = changes[1 - loser];
    expect(history.find((row) => row.sequence === 2)?.status).toBe(
      winner.status,
    );
    const members = await LegalMemberCollection.create({ db: isolated.baseDb });
    expect(await members.get({ id: member.id, tenantId })).toMatchObject({
      status: winner.status,
    });
    expect((await register.asOf('2026-02-01'))[0].evidence.status).toBe(
      winner.status,
    );
    await register.setStatus(member.id as string, changes[loser]);
    expect(
      (await histories.list({ where: { tenantId } }))
        .map((row) => row.sequence)
        .sort(),
    ).toEqual([1, 2, 3]);
    expect((await register.asOf('2026-02-01'))[0].evidence.status).toBe(
      changes[loser].status,
    );
  });

  it('keeps tenant data and immutable record-date evidence isolated', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
        'Profile',
        'ProfileType',
        'MemberClass',
        'LegalMember',
        'LegalMemberStatusHistory',
        'LegalMemberReference',
        'MemberOfficerAppointment',
        'MemberEligibilitySnapshot',
      ],
    });
    cleanup = isolated.cleanup;
    const alpha = new MemberRegisterService(isolated.baseDb, {
      tenantId: crypto.randomUUID(),
    });
    const beta = new MemberRegisterService(isolated.baseDb, {
      tenantId: crypto.randomUUID(),
    });
    const klass = await alpha.addClass({ key: 'worker', name: 'Worker' });
    const member = await alpha.enroll({
      memberClassId: klass.id as string,
      kind: 'individual',
      displayName: 'Pat',
      joinedOn: '2026-01-01',
    });
    await alpha.appoint(member.id as string, {
      role: 'treasurer',
      effectiveFrom: '2026-01-01',
    });
    expect(
      (
        await alpha.asOf('2026-02-01', { requireAuthoritativeKinds: ['dues'] })
      )[0],
    ).toMatchObject({
      eligible: false,
      reason: expect.stringContaining('evidence unavailable'),
    });
    await alpha.setStatus(member.id as string, {
      status: 'suspended',
      effectiveOn: '2026-03-01',
    });
    expect((await alpha.asOf('2026-02-01'))[0]).toMatchObject({
      eligible: true,
    });
    expect(await beta.asOf('2026-03-01')).toEqual([]);
    await alpha.addReference(member.id as string, {
      kind: 'dues',
      sourceType: 'ledger',
      sourceId: 'future-dues',
      authoritative: true,
      effectiveFrom: '2026-04-01',
    });
    expect(
      (
        await alpha.asOf('2026-03-15', { requireAuthoritativeKinds: ['dues'] })
      )[0],
    ).toMatchObject({ eligible: false });
  });
});
