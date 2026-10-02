import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttendanceBreakCollection,
  AttendancePunchCollection,
  AttendanceReplayCollection,
  AttendanceService,
  ServiceTimeEntryCollection,
} from '../index.js';

const actor = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  profileId: '22222222-2222-4222-8222-222222222222',
};
const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
const work = {
  workRefType: '@fixture/work:WorkPackage',
  workRefId: 'work-1',
  description: 'Framing',
};
export function attendanceSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let service: AttendanceService;
    beforeEach(async () => {
      actor.tenantId = crypto.randomUUID();
      actor.profileId = crypto.randomUUID();
      db = await create();
      service = new AttendanceService(db, actor);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanup();
    });
    it('closes with unpaid and paid breaks and links one draft entry', async () => {
      await service.punchIn(at(8));
      await service.startBreak(at(9));
      await service.endBreak(at(10));
      await service.startBreak(at(11), true);
      await service.endBreak(at(12));
      const punch = await service.punchOut(at(13), work);
      expect(punch.durationSeconds).toBe(4 * 3600);
      expect(punch.unpaidBreakSeconds).toBe(3600);
      const again = await service.linkServiceTimeEntry(punch.id!, work);
      expect(again.serviceTimeEntryId).toBe(punch.serviceTimeEntryId);
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const entries = await ServiceTimeEntryCollection.create({ db });
        const entry = await entries.get(punch.serviceTimeEntryId!);
        expect(entry).toMatchObject({
          status: 'draft',
          durationSeconds: 14400,
          participantProfileId: actor.profileId,
        });
      });
      await expect(
        service.linkServiceTimeEntry(punch.id!, {
          ...work,
          workRefId: 'other',
        }),
      ).rejects.toThrow('different work');
    });
    it('keeps linked evidence attribution bound to the actor despite extra work keys', async () => {
      const injected = {
        ...work,
        participantProfileId: crypto.randomUUID(),
        participantKind: 'agent',
        tenantId: crypto.randomUUID(),
        agentRef: 'attacker',
      };
      const outcomes = await service.replay([
        {
          clientId: 'attribution-in',
          action: 'punchIn',
          at: at(8).toISOString(),
        },
        {
          clientId: 'attribution-out',
          action: 'punchOut',
          at: at(9).toISOString(),
          work: injected,
        },
      ]);
      expect(outcomes[1].error).toBeUndefined();
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const punches = await AttendancePunchCollection.create({ db });
        const punch = await punches.get(outcomes[1].punchId!);
        const entries = await ServiceTimeEntryCollection.create({ db });
        const entry = await entries.get(punch!.serviceTimeEntryId!);
        expect(entry).toMatchObject({
          tenantId: actor.tenantId,
          participantProfileId: actor.profileId,
          participantKind: 'human',
        });
      });
      expect(
        await service.replay([
          {
            clientId: 'attribution-out',
            action: 'punchOut',
            at: at(9).toISOString(),
            work,
          },
        ]),
      ).toEqual([outcomes[1]]);
    });
    it('rejects direct closes before a committed break or while a break remains open', async () => {
      const punch = await service.punchIn(at(8));
      await service.startBreak(at(10));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        punch.endedAt = at(9);
        await expect(punch.save()).rejects.toThrow('Break must be inside');
        punch.endedAt = at(12);
        await expect(punch.save()).rejects.toThrow('Break must be inside');
      });
      await service.endBreak(at(11));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        punch.endedAt = at(10);
        await expect(punch.save()).rejects.toThrow('Break must be inside');
      });
      const closed = await service.punchOut(at(12));
      expect(closed.durationSeconds).toBe(3 * 3600);
    });
    it('serializes direct punch close against a concurrent break insertion', async () => {
      const punch = await service.punchIn(at(8));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const breaks = await AttendanceBreakCollection.create({ db });
        punch.endedAt = at(12);
        punch.durationSeconds = 4 * 3600;
        const results = await Promise.allSettled([
          punch.save(),
          breaks.create({
            tenantId: actor.tenantId,
            punchId: punch.id!,
            startedAt: at(13),
          }),
        ]);
        expect(
          results.filter((result) => result.status === 'fulfilled'),
        ).toHaveLength(1);
        const punches = await AttendancePunchCollection.create({ db });
        const stored = await punches.get(punch.id!);
        const children = await breaks.list({
          where: { tenantId: actor.tenantId, punchId: punch.id },
        });
        if (stored!.endedAt) expect(children).toHaveLength(0);
        else expect(children).toHaveLength(1);
      });
    });
    it('enforces one open punch in the database and permits a new closed slot', async () => {
      const results = await Promise.allSettled([
        service.punchIn(at(8)),
        service.punchIn(at(8)),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const punches = await AttendancePunchCollection.create({ db });
        await expect(
          punches.create({ ...actor, startedAt: at(9), _insertOnly: true }),
        ).rejects.toThrow();
        expect(
          await punches.list({ where: { ...actor, endedAt: null } }),
        ).toHaveLength(1);
      });
      if (isPostgresDatabase(db)) {
        const alias = new AttendanceService(db, {
          tenantId: actor.tenantId.toUpperCase(),
          profileId: actor.profileId.toUpperCase(),
        });
        await expect(alias.punchIn(at(9))).rejects.toThrow('already open');
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const punches = await AttendancePunchCollection.create({ db });
          await expect(
            punches.create({
              ...actor,
              profileId: actor.profileId.toUpperCase(),
              startedAt: at(9),
              _insertOnly: true,
            }),
          ).rejects.toThrow();
        });
      }
      await service.punchOut(at(10));
      await service.punchIn(at(11));
    });
    it('isolates tenant/profile actors and refuses a conflicting active tenant', async () => {
      const punch = await service.punchIn(at(8));
      await new AttendanceService(db, {
        ...actor,
        tenantId: '33333333-3333-4333-8333-333333333333',
      }).punchIn(at(8));
      const other = new AttendanceService(db, {
        ...actor,
        profileId: '44444444-4444-4444-8444-444444444444',
      });
      await other.punchIn(at(8));
      await expect(other.linkServiceTimeEntry(punch.id!, work)).rejects.toThrow(
        'not found',
      );
      await withTenant(
        { tenantId: '33333333-3333-4333-8333-333333333333' },
        async () => {
          await expect(service.punchOut(at(9))).rejects.toThrow(
            'active tenant',
          );
        },
      );
    });
    it('rejects backwards events and duplicate breaks', async () => {
      await service.punchIn(at(8));
      await expect(service.startBreak(at(7))).rejects.toThrow('predates');
      await service.startBreak(at(9));
      await expect(service.startBreak(at(10))).rejects.toThrow('already open');
      await service.endBreak(at(10));
      await expect(service.endBreak(at(11))).rejects.toThrow('No open break');
    });
    it('rolls back a close and active break when linked work is invalid', async () => {
      await service.punchIn(at(8));
      await service.startBreak(at(9));
      await expect(
        service.punchOut(at(10), { ...work, workRefId: '' }),
      ).rejects.toThrow('work reference');
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const breaks = await AttendanceBreakCollection.create({ db });
        expect(
          (await breaks.list({ where: { tenantId: actor.tenantId } }))[0]
            .endedAt,
        ).toBeNull();
      });
      const punch = await service.punchOut(at(11), work);
      expect(punch.durationSeconds).toBe(3600);
    });
    it('auto closes only due punches at the configured deadline and flags review', async () => {
      await service.punchIn(at(8));
      expect(await service.autoClose(at(9), 7200)).toBeNull();
      const punch = await service.autoClose(at(12), 7200);
      expect(punch).toMatchObject({
        reviewRequired: true,
        endedAt: at(10),
        durationSeconds: 7200,
      });
      expect(await service.autoClose(at(12), 7200)).toBeNull();
    });
    it('orders offline taps, persists identical outcomes, and rejects key changes', async () => {
      const taps = [
        {
          clientId: 'out',
          action: 'punchOut' as const,
          at: at(10).toISOString(),
          work,
        },
        { clientId: 'in', action: 'punchIn' as const, at: at(8).toISOString() },
      ];
      const result = await service.replay(taps);
      expect(result.map((r) => r.clientId)).toEqual(['in', 'out']);
      expect(result.every((r) => r.punchId && !r.error)).toBe(true);
      expect(await service.replay(taps)).toEqual(result);
      await expect(
        service.replay([{ ...taps[0], at: at(11).toISOString() }]),
      ).rejects.toThrow('different content');
      const stale = {
        clientId: 'stale',
        action: 'punchOut' as const,
        at: at(9).toISOString(),
      };
      const refusal = await service.replay([stale]);
      expect(refusal[0].error).toContain('predates');
      await service.punchIn(at(12));
      expect(await service.replay([stale])).toEqual(refusal);
    });
    it('validates malformed offline commands before writing', async () => {
      await expect(
        service.replay([{ clientId: '', at: 'bad', action: 'punchIn' }]),
      ).rejects.toThrow('Malformed');
      await expect(
        service.replay([{ clientId: 'bad', at: 'bad', action: 'punchIn' }]),
      ).rejects.toThrow('timestamps');
      await expect(
        service.replay([
          {
            clientId: 'bad',
            at: at(8).toISOString(),
            action: 'bogus' as never,
          },
        ]),
      ).rejects.toThrow('Malformed');
    });
    it('rolls back a transient replay failure and retries without duplicate mutations', async () => {
      const tap = {
        clientId: 'retry',
        action: 'punchIn' as const,
        at: at(8).toISOString(),
      };
      const write = vi
        .spyOn(AttendanceReplayCollection.prototype, 'create')
        .mockRejectedValueOnce(new Error('transient receipt failure'));
      await expect(service.replay([tap])).rejects.toThrow(
        'transient receipt failure',
      );
      write.mockRestore();
      const results = await Promise.all([
        service.replay([tap]),
        service.replay([tap]),
      ]);
      expect(results[0]).toEqual(results[1]);
      expect(results[0][0].error).toBeUndefined();
      await service.punchOut(at(9));
    });
    it('rolls back a database failure when creating linked evidence', async () => {
      await service.punchIn(at(8));
      await service.startBreak(at(9));
      const write = vi
        .spyOn(ServiceTimeEntryCollection.prototype, 'create')
        .mockRejectedValueOnce(new Error('entry unavailable'));
      await expect(service.punchOut(at(10), work)).rejects.toThrow(
        'entry unavailable',
      );
      write.mockRestore();
      const punch = await service.punchOut(at(11), work);
      expect(punch.durationSeconds).toBe(3600);
    });
    it('prevents persisted ownership changes and reopening closed intervals', async () => {
      const punch = await service.punchIn(at(8));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        punch.profileId = '44444444-4444-4444-8444-444444444444';
        await expect(punch.save()).rejects.toThrow('immutable');
      });
      const closed = await service.punchOut(at(10));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        closed.endedAt = null;
        await expect(closed.save()).rejects.toThrow('immutable');
      });
    });
    it('preserves millisecond taps and rounds net duration once to whole seconds', async () => {
      const start = new Date(at(8).getTime() + 123);
      const end = new Date(start.getTime() + 1600);
      await service.punchIn(start);
      const punch = await service.punchOut(end);
      expect(punch.startedAt).toEqual(start);
      expect(punch.endedAt).toEqual(end);
      expect(punch.durationSeconds).toBe(2);
    });
    it('rejects a break referencing another tenant punch at the model boundary', async () => {
      const foreign = await new AttendanceService(db, {
        tenantId: crypto.randomUUID(),
        profileId: crypto.randomUUID(),
      }).punchIn(at(8));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const breaks = await AttendanceBreakCollection.create({ db });
        await expect(
          breaks.create({
            tenantId: actor.tenantId,
            punchId: foreign.id ?? undefined,
            startedAt: at(9),
            _insertOnly: true,
          }),
        ).rejects.toThrow('inside its tenant-owned punch');
      });
    });
    it('refuses automatic close that would truncate later committed attendance', async () => {
      await service.punchIn(at(8));
      await service.startBreak(at(11));
      await expect(service.autoClose(at(12), 7200)).rejects.toThrow('predates');
      const punch = await service.punchOut(at(13));
      expect(punch.durationSeconds).toBe(3 * 3600);
      expect(punch.reviewRequired).toBe(false);
    });
    it('orders against the active punch when a zero-length predecessor shares its start', async () => {
      await service.punchIn(at(8));
      await service.punchOut(at(8));
      await service.punchIn(at(8));
      await service.startBreak(at(10));
      const result = await service.replay([
        {
          clientId: 'before-break',
          action: 'endBreak',
          at: at(9).toISOString(),
        },
      ]);
      expect(result[0].error).toContain('predates');
      await service.endBreak(at(11));
    });
    it('rejects malformed optional work before any replay mutation', async () => {
      await expect(
        service.replay([
          {
            clientId: 'malformed-work',
            action: 'punchIn',
            at: at(8).toISOString(),
            work: { ...work, workRefId: 123 } as never,
          },
        ]),
      ).rejects.toThrow('work reference');
      await service.punchIn(at(8));
    });
    it('fails closed on a corrupt durable outcome without replaying the mutation', async () => {
      const tap = {
        clientId: 'corrupt',
        action: 'punchIn' as const,
        at: at(8).toISOString(),
      };
      await service.replay([tap]);
      await db.query(
        isPostgresDatabase(db)
          ? 'UPDATE attendance_replays SET outcome = $1 WHERE tenant_id = $2'
          : 'UPDATE attendance_replays SET outcome = ? WHERE tenant_id = ?',
        'null',
        actor.tenantId,
      );
      await expect(service.replay([tap])).rejects.toThrow(
        'Invalid stored attendance replay outcome',
      );
      await service.punchOut(at(9));
    });
  });
}
