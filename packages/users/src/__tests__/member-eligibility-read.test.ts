import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import {
  createIsolatedTestDbFromManifest,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type EligibilityPolicy,
  LegalMemberCollection,
  LegalMemberReferenceCollection,
  type LegalMemberStatus,
  MemberEligibilitySnapshotCollection,
  MemberRegisterService,
} from '../member-register/index.js';

for (const dialect of ['sqlite', 'duckdb', 'postgres'] as const) {
  const describeDialect =
    dialect === 'postgres' && !isPostgresAvailable() ? describe.skip : describe;
  describeDialect(`member-scoped eligibility (${dialect})`, () => {
    let db: DatabaseInterface;
    let cleanup: (() => Promise<void>) | undefined;
    afterEach(async () => {
      if (cleanup) await cleanup();
      else await db?.close?.();
      cleanup = undefined;
    });
    async function fixture() {
      if (dialect === 'postgres') {
        const isolated = await createIsolatedTestDbFromManifest({
          includeObjects: [
            'User',
            'Profile',
            'ProfileType',
            'MemberClass',
            'LegalMember',
            'LegalMemberStatusHistory',
            'LegalMemberReference',
            'MemberEligibilitySnapshot',
          ],
        });
        db = isolated.baseDb;
        cleanup = isolated.cleanup;
      } else {
        db = await getTestDatabase({
          type: dialect,
          url: ':memory:',
          omitForeignKeyConstraints: dialect === 'duckdb',
        });
      }
      const tenantId = crypto.randomUUID();
      const register = new MemberRegisterService(db, {
        tenantId,
        actorRef: 'co-op registrar',
      });
      const klass = await register.addClass({
        key: 'worker',
        name: 'Worker cooperative',
      });
      const input = {
        memberClassId: klass.id as string,
        kind: 'individual' as const,
        displayName: 'Pat',
        joinedOn: '2026-01-01',
      };
      const member = await register.enroll(input);
      return { register, tenantId, member, input };
    }

    it('never writes, opens transactions or enumerates unrelated members on repeated capability reads', async () => {
      const { register, tenantId, member, input } = await fixture();
      const list = vi.spyOn(LegalMemberCollection.prototype, 'list');
      const query = vi.spyOn(db, 'query');
      const read = () =>
        register.eligibilityFor(
          { memberId: member.id as string },
          '2026-02-01',
        );
      const before = query.mock.calls.length;
      await read();
      const baseline = query.mock.calls.length - before;
      expect(baseline).toBeGreaterThan(0);
      for (let i = 0; i < 40; i++)
        await register.enroll({ ...input, displayName: `Unrelated ${i}` });
      const tx = vi.spyOn(db, 'transaction');
      try {
        const start = query.mock.calls.length;
        expect(await read()).toMatchObject({ eligible: true });
        expect(query.mock.calls.length - start).toBe(baseline);
        await read();
        expect(tx).not.toHaveBeenCalled();
        await register.setStatus(member.id as string, {
          status: 'suspended',
          effectiveOn: '2026-02-01',
        });
        tx.mockClear();
        for (let i = 0; i < 3; i++)
          expect(await read()).toMatchObject({ eligible: false });
        expect(tx).not.toHaveBeenCalled();
        expect(list).not.toHaveBeenCalled();
      } finally {
        tx.mockRestore();
        query.mockRestore();
        list.mockRestore();
      }
      const snapshots = await MemberEligibilitySnapshotCollection.create({
        db,
      });
      expect(await snapshots.list({ where: { tenantId } })).toHaveLength(0);
    });

    it('matches persisted register semantics across dates, statuses, class policies and authoritative references', async () => {
      const { register, member } = await fixture();
      const id = member.id as string;
      await register.setStatus(id, {
        status: 'suspended',
        effectiveOn: '2026-02-01',
      });
      await register.setStatus(id, {
        status: 'resigned',
        effectiveOn: '2026-03-01',
      });
      await register.setStatus(id, {
        status: 'ceased',
        effectiveOn: '2026-04-01',
      });
      await register.setStatus(id, {
        status: 'resigned',
        effectiveOn: '2026-04-02',
      });
      await register.setStatus(id, {
        status: 'active',
        effectiveOn: '2026-04-02',
      });
      await register.setStatus(id, {
        status: 'suspended',
        effectiveOn: '2099-01-01',
      });
      await register.addReference(id, {
        kind: 'dues',
        sourceType: 'cooperative-dues',
        sourceId: 'unverified',
        effectiveFrom: '2026-01-01',
      });
      const ref = await register.addReference(id, {
        kind: 'dues',
        sourceType: 'cooperative-ledger',
        sourceId: 'dues-1',
        authoritative: true,
        effectiveFrom: '2026-02-01',
        effectiveTo: '2026-04-30',
      });
      await register.revokeReference(ref.id as string, {
        effectiveOn: '2026-04-01',
      });
      const policies: EligibilityPolicy[] = [
        {},
        { memberClassKeys: [] },
        { memberClassKeys: ['worker'] },
        { memberClassKeys: ['consumer'] },
        { statuses: [] },
        { statuses: ['suspended', 'resigned'] },
        { requireAuthoritativeKinds: ['dues'] },
        { requireAuthoritativeKinds: ['share'] },
      ];
      for (const on of [
        '2025-12-01',
        '2026-01-31',
        '2026-02-01',
        '2026-03-01',
        '2026-04-01',
        '2026-04-02',
        '2099-01-01',
      ]) {
        for (const policy of policies) {
          const read = await register.eligibilityFor(
            { memberId: id },
            on,
            policy,
          );
          expect(read).toEqual((await register.asOf(on, policy))[0]);
        }
      }
    });

    it('fails closed for missing, foreign, ambiguous and malformed identities and mismatched active contexts', async () => {
      const { register, tenantId, member, input } = await fixture();
      const foreign = new MemberRegisterService(db, {
        tenantId: crypto.randomUUID(),
      });
      for (const identity of [
        { memberId: crypto.randomUUID() },
        { userId: crypto.randomUUID() },
      ])
        await expect(
          register.eligibilityFor(identity, '2026-02-01'),
        ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_NOT_FOUND' });
      await expect(
        foreign.eligibilityFor({ memberId: member.id as string }, '2026-02-01'),
      ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_NOT_FOUND' });
      await withTenant({ tenantId: crypto.randomUUID() }, async () => {
        await expect(
          register.eligibilityFor(
            { memberId: member.id as string },
            '2026-02-01',
          ),
        ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_TENANT_MISMATCH' });
      });
      // Exercise malformed JSON at the public JavaScript boundary.
      await expect(
        register.eligibilityFor(JSON.parse('{}'), '2026-02-01'),
      ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
      // Selector alternatives are mutually exclusive.
      await expect(
        register.eligibilityFor(
          JSON.parse(
            JSON.stringify({
              memberId: member.id,
              userId: crypto.randomUUID(),
            }),
          ),
          '2026-02-01',
        ),
      ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
      // Runtime contracts must reject strings as allowlists.
      await expect(
        register.eligibilityFor(
          { memberId: member.id as string },
          '2026-02-01',
          JSON.parse('{"memberClassKeys":"worker"}'),
        ),
      ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
      // userId is optional and deliberately not unique on the legal register.
      const { UserCollection } = await import(
        '../collections/UserCollection.js'
      );
      const users = await UserCollection.create({ db });
      const user = await users.create({
        email: `${crypto.randomUUID()}@example.com`,
      });
      await register.enroll({ ...input, userId: user.id });
      expect(
        await register.eligibilityFor(
          { userId: user.id as string },
          '2026-02-01',
        ),
      ).toMatchObject({ eligible: true });
      await register.enroll({ ...input, userId: user.id });
      await expect(
        register.eligibilityFor({ userId: user.id as string }, '2026-02-01'),
      ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_NOT_FOUND' });
      await withTenant({ tenantId }, async () => {
        await expect(
          register.eligibilityFor({ memberId: '' }, '2026-02-01'),
        ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
        await expect(
          register.eligibilityFor(
            { memberId: member.id as string },
            '2026-02-30',
          ),
        ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
        await expect(
          register.eligibilityFor(
            { memberId: member.id as string },
            '2026-02-01',
            { statuses: ['unknown' as LegalMemberStatus] },
          ),
        ).rejects.toMatchObject({ code: 'MEMBER_REGISTER_INVALID' });
      });
    });

    it('uses the supplied executor, propagates read failures, and atomically retains command evidence on explicit acceptance', async () => {
      const { register, tenantId, member } = await fixture();
      const identity = { memberId: member.id as string };
      const snapshots = await MemberEligibilitySnapshotCollection.create({
        db,
      });
      const references = await LegalMemberReferenceCollection.create({ db });
      await register.setStatus(member.id as string, {
        status: 'suspended',
        effectiveOn: '2026-01-15',
      });
      const command = async (fail: boolean) =>
        register.withTransaction(async (bound, executor) => {
          const tx = vi.spyOn(executor, 'transaction');
          try {
            await bound.setStatus(member.id as string, {
              status: 'active',
              effectiveOn: '2026-01-31',
              reason: 'accepted command',
            });
            expect(
              await bound.eligibilityFor(identity, '2026-02-01'),
            ).toMatchObject({ eligible: true });
            const snapshot = await bound.captureEligibility(
              identity,
              '2026-02-01',
            );
            expect(tx).not.toHaveBeenCalled();
            const refs = await LegalMemberReferenceCollection.create({
              db: executor,
            });
            await refs.create({
              tenantId,
              memberId: member.id as string,
              kind: 'agreement',
              sourceType: 'accepted-command',
              sourceId: snapshot.id as string,
              effectiveFrom: '2026-02-01',
            });
            if (fail) throw new Error('command refused');
            return snapshot;
          } finally {
            tx.mockRestore();
          }
        });
      await expect(command(true)).rejects.toThrow('command refused');
      expect(
        await register.eligibilityFor(identity, '2026-02-01'),
      ).toMatchObject({ eligible: false });
      expect(await snapshots.list({ where: { tenantId } })).toHaveLength(0);
      expect(await references.list({ where: { tenantId } })).toHaveLength(0);
      const snapshot = await command(false);
      expect(await snapshots.list({ where: { tenantId } })).toHaveLength(1);
      expect(await references.list({ where: { tenantId } })).toHaveLength(1);
      await withTenant({ tenantId }, async () => {
        snapshot.reason = 'rewritten';
        await expect(snapshot.save()).rejects.toThrow();
        await expect(snapshot.delete()).rejects.toThrow('cannot be deleted');
      });
      const failure = vi
        .spyOn(db, 'query')
        .mockRejectedValueOnce(new Error('read unavailable'));
      try {
        await expect(
          register.eligibilityFor(identity, '2026-02-01'),
        ).rejects.toThrow('read unavailable');
      } finally {
        failure.mockRestore();
      }
      expect(await snapshots.list({ where: { tenantId } })).toHaveLength(1);
    });
  });
}
