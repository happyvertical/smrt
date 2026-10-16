import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import { afterEach, describe, expect, it } from 'vitest';
import { MemberRegisterService } from '../member-register/index.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;
describePostgres('member register (postgres)', () => {
  let cleanup: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await cleanup?.();
    cleanup = undefined;
  });
  it('keeps tenant data and immutable record-date evidence isolated', async () => {
    const isolated = await createIsolatedTestDbFromManifest({
      includeObjects: [
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
