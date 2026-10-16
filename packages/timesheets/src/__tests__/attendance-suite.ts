import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { beginSegment } from '../attendance/segments.js';
import {
  AttendanceBreakCollection,
  AttendanceCorrection,
  AttendanceCorrectionCollection,
  AttendanceCorrectionService,
  AttendancePunchCollection,
  AttendanceReplayCollection,
  AttendanceSegmentCollection,
  AttendanceService,
  ServiceTimeEntryCollection,
} from '../index.js';

const actor = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  profileId: '22222222-2222-4222-8222-222222222222',
};
const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
const half = (hour: number) => new Date(at(hour).getTime() + 30 * 60_000);
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
    it('runs work segments through switches and breaks, one open per punch', async () => {
      const wo = (id: string, op: string) => ({
        workRefType: '@fixture/work:WorkOrder',
        workRefId: id,
        taskRefType: '@fixture/work:Operation',
        taskRefId: op,
        kind: 'shop',
        description: op,
      });
      await service.punchIn(at(8));
      await expect(service.stopWork(at(8))).rejects.toThrow('No open work');
      await service.startWork(at(8), wo('WO-1', 'SHEAR'));
      await expect(
        service.startWork(at(9), wo('WO-2', 'WELD')),
      ).rejects.toThrow('already open');
      expect((await service.currentWork())?.workRefId).toBe('WO-1');
      await service.switchWork(at(10), wo('WO-2', 'WELD'));
      await service.startBreak(at(12));
      await expect(service.startWork(at(12), wo('WO-3', 'X'))).rejects.toThrow(
        'open break',
      );
      expect(await service.currentWork()).toBeNull();
      await service.endBreak(at(13), { resumeWork: true });
      expect((await service.currentWork())?.workRefId).toBe('WO-2');
      await expect(service.switchWork(at(12), wo('WO-3', 'X'))).rejects.toThrow(
        'predates',
      );
      const punch = await service.punchOut(at(16));
      expect(await service.currentWork()).toBeNull();
      const segments = await service.segments(punch.id!);
      expect(
        segments.map((g) => [
          g.workRefId,
          g.taskRefId,
          g.durationSeconds / 3600,
          g.closedReason,
        ]),
      ).toEqual([
        ['WO-1', 'SHEAR', 2, 'switch'],
        ['WO-2', 'WELD', 2, 'break'],
        ['WO-2', 'WELD', 3, 'punchOut'],
      ]);
      expect(punch.durationSeconds).toBe(7 * 3600);
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const collection = await AttendanceSegmentCollection.create({ db });
        const byTask = await collection.list({
          where: {
            tenantId: actor.tenantId,
            taskRefType: '@fixture/work:Operation',
            taskRefId: 'WELD',
          },
        });
        expect(byTask).toHaveLength(2);
        const closed = byTask[0];
        closed.description = 'edited';
        await expect(closed.save()).rejects.toThrow('immutable');
        closed.description = 'WELD';
        closed.endedAt = at(11);
        await expect(closed.save()).rejects.toThrow('immutable');
      });
    });
    it('refuses resume without an interrupting break, half task refs and work outside a punch', async () => {
      await expect(service.startWork(at(8), work)).rejects.toThrow(
        'No open punch',
      );
      await service.punchIn(at(8));
      await service.startWork(at(8), work);
      await service.stopWork(at(9));
      await expect(service.resumeWork(at(9))).rejects.toThrow(
        'No work interrupted',
      );
      await expect(
        service.startWork(at(9), { ...work, taskRefType: 'x:Op' }),
      ).rejects.toThrow('together');
      await service.startWork(at(9), work);
      // The punch punchOut returns: an unfiltered list also sees other tests' rows on PostgreSQL.
      const punch = await service.punchOut(at(10), work);
      expect((await service.segments(punch.id!)).at(-1)?.closedReason).toBe(
        'punchOut',
      );
    });
    it('closes segments on replayed break and punch-out taps and keeps punchOut work compatible', async () => {
      await service.punchIn(at(8));
      await service.startWork(at(8), work);
      const outcomes = await service.replay([
        { clientId: 'b', action: 'startBreak', at: at(9).toISOString() },
        { clientId: 'e', action: 'endBreak', at: at(10).toISOString() },
        { clientId: 'o', action: 'punchOut', at: at(11).toISOString(), work },
      ]);
      expect(outcomes.every((o) => !o.error)).toBe(true);
      const segments = await service.segments(outcomes[2].punchId!);
      expect(segments.map((g) => g.closedReason)).toEqual(['break']);
    });
    it('replays work actions with the punch changes and stores refusal codes', async () => {
      const t = (clientId: string, hour: number, action: string, extra = {}) =>
        ({
          clientId,
          action,
          at: at(hour).toISOString(),
          ...extra,
        }) as never;
      const outcomes = await service.replay([
        t('w-in', 8, 'punchIn'),
        t('w-start', 9, 'startWork', { work }),
        t('w-switch', 10, 'switchWork', {
          work: { ...work, workRefId: 'work-2' },
        }),
        t('w-break', 11, 'startBreak'),
        t('w-back', 12, 'endBreak'),
        t('w-resume', 13, 'resumeWork'),
        t('w-stop', 14, 'stopWork'),
      ]);
      expect(outcomes.every((o) => !o.error)).toBe(true);
      const kinds = (await service.segments(outcomes[0].punchId!)).map(
        (g) => [g.workRefId, g.closedReason] as const,
      );
      expect(kinds).toEqual([
        ['work-1', 'switch'],
        ['work-2', 'break'],
        ['work-2', 'stop'],
      ]);
      expect(outcomes[1].segmentId).toBeTruthy();
      await expect(
        service.replay([t('w-none', 15, 'startWork')]),
      ).rejects.toThrow('Malformed');
      const [refused] = await service.replay([t('w-dup', 15, 'resumeWork')]);
      expect(refused).toMatchObject({ code: 'no_resumable_work' });
      expect(refused.error).toBeTruthy();
      expect(await service.replay([t('w-dup', 15, 'resumeWork')])).toEqual([
        refused,
      ]);
      const [custom] = await service.replay([t('w-c', 16, 'stopWork')], {
        refusal: (_tap, error) => ({
          code: 'device_busy',
          message: `busy: ${error.code}`,
        }),
      });
      expect(custom).toMatchObject({
        code: 'device_busy',
        error: 'busy: no_open_work',
      });
    });
    it('resolves replay time by policy, hashing the tap as sent', async () => {
      const serverNow = at(20);
      const resolveAt = vi.fn(({ deviceAt, waitedMs }) =>
        waitedMs > 3 * 3600_000
          ? {
              at: new Date(deviceAt.getTime() + 3600_000),
              reviewRequired: true,
            }
          : { at: deviceAt },
      );
      const taps = [
        {
          clientId: 'r-in',
          action: 'punchIn' as const,
          at: at(8).toISOString(),
        },
        {
          clientId: 'r-w',
          action: 'startWork' as const,
          at: at(9).toISOString(),
          work,
        },
      ];
      const result = await service.replay(taps, {
        resolveAt,
        now: () => serverNow,
      });
      expect(resolveAt.mock.calls[0][0]).toMatchObject({
        waitedMs: 12 * 3600_000,
        actor,
      });
      expect(result[0].resolvedAt).toBe(at(9).toISOString());
      const segment = await service.currentWork();
      expect(segment?.startedAt).toEqual(at(10));
      expect(segment?.reviewRequired).toBe(true);
      // Retrying the same tap hits the receipt without consulting the policy.
      resolveAt.mockClear();
      expect(
        await service.replay(taps, { resolveAt, now: () => serverNow }),
      ).toEqual(result);
      expect(resolveAt).not.toHaveBeenCalled();
      await expect(
        service.replay([{ ...taps[1], at: at(11).toISOString() }]),
      ).rejects.toThrow('different content');
    });
    it('lets resolveAt decide the punch flags, defaulting both to true', async () => {
      const flags = async (
        clientId: string,
        hour: number,
        resolved?: { recordedOffline?: boolean; reviewRequired?: boolean },
      ) => {
        const [out] = await service.replay(
          [{ clientId, action: 'punchIn', at: at(hour).toISOString() }],
          resolved
            ? { resolveAt: ({ deviceAt }) => ({ at: deviceAt, ...resolved }) }
            : {},
        );
        const punch = await withTenant({ tenantId: actor.tenantId }, async () =>
          (await AttendancePunchCollection.create({ db })).get(out.punchId!),
        );
        const result = [punch?.recordedOffline, punch?.reviewRequired];
        await service.punchOut(at(hour + 1));
        return result;
      };
      expect(await flags('f-none', 8)).toEqual([true, true]);
      expect(await flags('f-empty', 10, {})).toEqual([true, true]);
      expect(
        await flags('f-online', 12, {
          recordedOffline: false,
          reviewRequired: false,
        }),
      ).toEqual([false, false]);
      expect(await flags('f-late', 14, { reviewRequired: true })).toEqual([
        true,
        true,
      ]);
    });
    it('composes segment helpers inside one transaction and rolls back together', async () => {
      await service.punchIn(at(8));
      await expect(
        service.withTransaction(async (tx) => {
          const [punch] = await tx.punches.list({
            where: { ...actor, endedAt: null },
          });
          await beginSegment(tx, punch, at(9), work);
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');
      expect(await service.currentWork()).toBeNull();
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
    it('auto closes at a per-punch deadline with a reason, closing segment and break', async () => {
      await service.punchIn(at(8));
      await service.startWork(at(8), work);
      await service.startBreak(at(9));
      const seen: string[] = [];
      const resolver = (punch: { id?: string | null }) => {
        seen.push(punch.id ?? '');
        return { deadline: at(10), reason: 'shiftEnd' };
      };
      expect(await service.autoClose(at(9), () => null)).toBeNull();
      expect(
        await service.autoClose(at(9), () => ({ deadline: at(10) })),
      ).toBeNull();
      const punch = await service.autoClose(at(12), resolver);
      expect(seen).toHaveLength(1);
      expect(punch).toMatchObject({
        reviewRequired: true,
        autoCloseReason: 'shiftEnd',
        endedAt: at(10),
      });
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const segments = await AttendanceSegmentCollection.create({ db });
        const rows = await segments.list({
          where: { tenantId: actor.tenantId, punchId: punch!.id! },
        });
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          endedAt: at(9),
          closedReason: 'break',
        });
        const breaks = await AttendanceBreakCollection.create({ db });
        const [b] = await breaks.list({
          where: { tenantId: actor.tenantId, punchId: punch!.id! },
        });
        expect(b.endedAt).toEqual(at(10));
      });
      expect(await service.autoClose(at(12), resolver)).toBeNull();
      expect(seen).toHaveLength(1);
    });
    it('records maxDuration for the fixed form and rejects bad deadlines', async () => {
      await service.punchIn(at(8));
      await expect(
        service.autoClose(at(12), () => ({ deadline: at(7) })),
      ).rejects.toThrow('predates');
      await expect(
        service.autoClose(at(12), () => new Date('x')),
      ).rejects.toThrow('invalid');
      await expect(
        service.autoClose(at(12), () => ({ deadline: at(9), reason: ' ' })),
      ).rejects.toThrow('reason');
      const punch = await service.autoClose(at(12), 3600);
      expect(punch).toMatchObject({
        autoCloseReason: 'maxDuration',
        endedAt: at(9),
      });
      punch!.autoCloseReason = 'edited';
      await expect(punch!.save()).rejects.toThrow('autoCloseReason');
    });
    it('bounds the device id like the other provenance labels', async () => {
      const type = '@fixture/shop:Station';
      await expect(
        service.punchIn(at(8), { device: { type, id: 'x'.repeat(65) } }),
      ).rejects.toThrow('device.id');
      await expect(
        service.punchIn(at(8), { device: { type, id: ' padded ' } }),
      ).rejects.toThrow('device.id');
      const punch = await service.punchIn(at(8), {
        device: { type, id: 'x'.repeat(64) },
      });
      expect(punch.deviceRefId).toHaveLength(64);
    });
    it('closes a punch whose new provenance columns are NULL on an older row', async () => {
      await service.punchIn(at(8));
      await db.query(
        `UPDATE attendance_punches SET source = NULL, device_ref_type = NULL, device_ref_id = NULL, auto_close_reason = NULL WHERE tenant_id = ${isPostgresDatabase(db) ? '$1' : '?'}`,
        actor.tenantId,
      );
      const closed = await service.punchOut(at(9));
      expect(closed.durationSeconds).toBe(3600);
    });
    it('refuses untrimmed provenance written straight through the model', async () => {
      await service.punchIn(at(8));
      await service.startBreak(at(9));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const punches = await AttendancePunchCollection.create({ db });
        const [open] = await punches.list({
          where: { tenantId: actor.tenantId, profileId: actor.profileId },
        });
        await expect(
          punches.create({
            tenantId: actor.tenantId,
            profileId: crypto.randomUUID(),
            startedAt: at(1),
            source: ' device ',
          }),
        ).rejects.toThrow('source or device');
        const breaks = await AttendanceBreakCollection.create({ db });
        const [pause] = await breaks.list({
          where: { tenantId: actor.tenantId, punchId: open.id },
        });
        pause.kind = ' meal ';
        await expect(pause.save()).rejects.toThrow('break');
      });
    });
    it('refuses a forged autoCloseReason and a deadline before a committed break', async () => {
      await service.punchIn(at(8), { source: 'device' });
      await service.startBreak(at(9));
      await expect(
        service.autoClose(at(12), () => ({ deadline: at(8) })),
      ).rejects.toThrow('predates committed');
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const punches = await AttendancePunchCollection.create({ db });
        const [open] = await punches.list({
          where: { tenantId: actor.tenantId, profileId: actor.profileId },
        });
        expect(open.endedAt).toBeNull();
        expect(open.autoCloseReason).toBe('');
        open.autoCloseReason = 'forged';
        await expect(open.save()).rejects.toThrow('autoCloseReason');
        await expect(
          punches.create({
            tenantId: actor.tenantId,
            profileId: crypto.randomUUID(),
            startedAt: at(1),
            autoCloseReason: 'forged',
          }),
        ).rejects.toThrow('autoCloseReason');
      });
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
    it.each([
      { total: 4100, unpaid: 600, expected: 4 },
      { total: 4100, unpaid: 3600, expected: 1 },
    ])('subtracts integer milliseconds before rounding linked net duration ($unpaid ms unpaid)', async ({
      total,
      unpaid,
      expected,
    }) => {
      const start = at(8).getTime();
      await service.punchIn(new Date(start));
      await service.startBreak(new Date(start));
      await service.endBreak(new Date(start + unpaid));
      const punch = await service.punchOut(new Date(start + total), work);
      expect(punch.durationSeconds).toBe(expected);
      expect(punch.unpaidBreakSeconds).toBe(Math.round(unpaid / 1000));
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const entries = await ServiceTimeEntryCollection.create({ db });
        expect(
          (await entries.get(punch.serviceTimeEntryId!))!.durationSeconds,
        ).toBe(expected);
      });
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

    it('records punch source and device and break kind, queryable and immutable', async () => {
      const device = { type: '@fixture/shop:Station', id: 'station-7' };
      const first = await service.punchIn(at(8), { source: 'device', device });
      expect(first).toMatchObject({
        source: 'device',
        deviceRefType: device.type,
        deviceRefId: 'station-7',
      });
      await service.startBreak(at(10), false, { kind: 'meal' });
      await service.endBreak(at(11));
      await service.startBreak(at(12), true);
      await service.endBreak(half(12));
      const closed = await service.punchOut(at(16));
      const plain = await service.punchIn(at(17));
      expect(plain).toMatchObject({
        source: '',
        deviceRefType: '',
        deviceRefId: '',
      });
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const punches = await AttendancePunchCollection.create({ db });
        const byDevice = await punches.list({
          where: {
            tenantId: actor.tenantId,
            deviceRefType: device.type,
            deviceRefId: 'station-7',
          },
        });
        expect(byDevice.map((p) => p.id)).toEqual([closed.id]);
        expect(
          await punches.list({
            where: { tenantId: actor.tenantId, source: 'device' },
          }),
        ).toHaveLength(1);
        const breaks = await AttendanceBreakCollection.create({ db });
        const meals = await breaks.list({
          where: { tenantId: actor.tenantId, punchId: closed.id, kind: 'meal' },
        });
        expect(meals).toHaveLength(1);
        const all = await breaks.list({
          where: { tenantId: actor.tenantId, punchId: closed.id },
        });
        expect(all.map((b) => b.kind).sort()).toEqual(['', 'meal']);
        closed.source = 'web';
        await expect(closed.save()).rejects.toThrow('immutable');
        meals[0].kind = 'rest';
        await expect(meals[0].save()).rejects.toThrow('immutable');
      });
    });
    it('refuses malformed source, device and kind', async () => {
      await expect(
        service.punchIn(at(8), { source: 'x'.repeat(65) }),
      ).rejects.toThrow('source');
      await expect(
        service.punchIn(at(8), { device: { type: 'T', id: '' } }),
      ).rejects.toThrow('together');
      await expect(service.punchIn(at(8), { source: ' web' })).rejects.toThrow(
        'trimmed',
      );
      await service.punchIn(at(8));
      await expect(
        service.startBreak(at(9), false, { kind: 5 as unknown as string }),
      ).rejects.toThrow('kind');
      expect(
        await service
          .replay([
            {
              clientId: 'bad',
              action: 'punchIn',
              at: at(9).toISOString(),
              device: { type: 'T', id: '' },
            },
          ])
          .catch((e: Error) => e.message),
      ).toContain('together');
    });
    it('replays provenance, hashing it only when present', async () => {
      const device = { type: '@fixture/shop:Station', id: 'station-7' };
      const taps = [
        {
          clientId: 'in',
          action: 'punchIn' as const,
          at: at(8).toISOString(),
          source: 'device',
          device,
        },
        {
          clientId: 'br',
          action: 'startBreak' as const,
          at: at(10).toISOString(),
          kind: 'meal',
        },
      ];
      const result = await service.replay(taps);
      expect(result.every((r) => r.punchId && !r.error)).toBe(true);
      expect(await service.replay(taps)).toEqual(result);
      await expect(
        service.replay([{ ...taps[0], source: 'web' }]),
      ).rejects.toThrow('different content');
      const [punch] = await service.withTransaction((tx) =>
        tx.punches.list({
          where: { ...actor, id: result[0].punchId },
          limit: 1,
        }),
      );
      expect(punch).toMatchObject({
        source: 'device',
        deviceRefId: 'station-7',
      });
      const [stored] = await service.withTransaction((tx) =>
        tx.replays.list({
          where: {
            tenantId: actor.tenantId,
            replayKey: JSON.stringify([actor.tenantId, actor.profileId, 'in']),
          },
          limit: 1,
        }),
      );
      expect(JSON.parse(stored.content)).toEqual([
        'punchIn',
        at(8).toISOString(),
        false,
        null,
        null,
        null,
        {
          source: 'device',
          deviceType: device.type,
          deviceId: 'station-7',
          kind: '',
        },
      ]);
      const [legacy] = await service.replay([
        { clientId: 'legacy', action: 'endBreak', at: at(11).toISOString() },
      ]);
      const [row] = await service.withTransaction((tx) =>
        tx.replays.list({
          where: {
            tenantId: actor.tenantId,
            replayKey: JSON.stringify([
              actor.tenantId,
              actor.profileId,
              legacy.clientId,
            ]),
          },
          limit: 1,
        }),
      );
      expect(JSON.parse(row.content)).toEqual([
        'endBreak',
        at(11).toISOString(),
        false,
        null,
        null,
        null,
      ]);
    });
    describe('corrections', () => {
      const foreman = crypto.randomUUID();
      let fix: AttendanceCorrectionService;
      beforeEach(() => {
        fix = new AttendanceCorrectionService(db, {
          tenantId: actor.tenantId,
          profileId: foreman,
        });
      });
      const base = () => ({
        subjectProfileId: actor.profileId,
        reason: 'forgot to clock out',
      });
      async function day() {
        await service.punchIn(at(8));
        await service.startWork(at(8), work);
        await service.startBreak(at(12));
        await service.endBreak(at(13));
        return service.punchOut(at(16));
      }
      const ledger = (punchId: string) => fix.listForPunch(punchId);
      it('corrects a closed punch end, recomputes and writes the ledger', async () => {
        const punch = await day();
        expect(punch.durationSeconds).toBe(7 * 3600);
        punch.endedAt = at(15);
        await expect(punch.save()).rejects.toThrow('immutable');
        const row = await fix.correctPunch({
          ...base(),
          punchId: punch.id!,
          endedAt: half(15),
          acknowledgementRequired: true,
        });
        const [fresh] = await new AttendanceService(db, actor).withTransaction(
          (tx) =>
            tx.punches.list({ where: { ...actor, id: punch.id }, limit: 1 }),
        );
        expect(fresh.durationSeconds).toBe(6.5 * 3600);
        expect(fresh.unpaidBreakSeconds).toBe(3600);
        expect(row).toMatchObject({
          kind: 'punch.corrected',
          actorProfileId: foreman,
          subjectProfileId: actor.profileId,
          punchId: punch.id,
          reason: 'forgot to clock out',
          acknowledgementRequired: true,
          acknowledgedAt: null,
        });
        expect(row.getBefore()).toMatchObject({
          endedAt: at(16).toISOString(),
          durationSeconds: 7 * 3600,
        });
        expect(row.getAfter()).toMatchObject({ durationSeconds: 6.5 * 3600 });
        expect(await ledger(punch.id!)).toHaveLength(1);
      });
      it('requires a reason and refuses invalid layouts and overlaps', async () => {
        const punch = await day();
        const id = punch.id!;
        await expect(
          fix.correctPunch({
            ...base(),
            reason: '  ',
            punchId: id,
            endedAt: at(15),
          }),
        ).rejects.toThrow('reason');
        await expect(
          fix.correctPunch({ ...base(), punchId: id, endedAt: at(12) }),
        ).rejects.toThrow('inside its punch');
        await expect(
          fix.correctPunch({ ...base(), punchId: id, startedAt: at(17) }),
        ).rejects.toThrow('after it starts');
        await expect(
          fix.correctPunch({
            ...base(),
            subjectProfileId: crypto.randomUUID(),
            punchId: id,
            endedAt: at(15),
          }),
        ).rejects.toThrow('not found');
        await expect(
          fix.saveBreak({
            ...base(),
            punchId: id,
            startedAt: at(12),
            endedAt: at(14),
          }),
        ).rejects.toThrow('overlap');
        await expect(
          fix.saveSegment({
            ...base(),
            punchId: id,
            startedAt: at(11),
            endedAt: at(12),
            work,
          }),
        ).rejects.toThrow('overlap');
        await expect(
          fix.saveBreak({
            ...base(),
            punchId: id,
            startedAt: at(7),
            endedAt: at(9),
          }),
        ).rejects.toThrow('inside its punch');
        expect(await ledger(id)).toHaveLength(0);
        await service.punchIn(at(17));
        await expect(
          fix.addPunch({ ...base(), startedAt: half(16), endedAt: at(18) }),
        ).rejects.toThrow('Punches must not overlap');
        await expect(
          fix.correctPunch({ ...base(), punchId: id, endedAt: at(18) }),
        ).rejects.toThrow('Punches must not overlap');
        await expect(
          fix.correctPunch({
            ...base(),
            punchId: (await service.punchOut(at(18))).id!,
            endedAt: at(19),
          }),
        ).resolves.toBeDefined();
      });
      it('adds a missed punch retroactively', async () => {
        await day();
        const row = await fix.addPunch({
          ...base(),
          reason: 'missed Friday',
          startedAt: at(-24),
          endedAt: at(-16),
        });
        expect(row.kind).toBe('punch.added');
        expect(row.getBefore()).toBeNull();
        expect(row.getAfter()).toMatchObject({ durationSeconds: 8 * 3600 });
        await expect(
          fix.addPunch({ ...base(), startedAt: at(-20), endedAt: at(-18) }),
        ).rejects.toThrow('Punches must not overlap');
        // the open-slot is unaffected: a normal punch in still works
        await service.punchIn(at(20));
      });
      it('adds, changes and removes breaks and segments inside a closed punch', async () => {
        const punch = await day();
        const id = punch.id!;
        const added = await fix.saveBreak({
          ...base(),
          punchId: id,
          startedAt: at(14),
          endedAt: half(14),
          paid: false,
        });
        expect(added.kind).toBe('break.added');
        const run = () =>
          new AttendanceService(db, actor).withTransaction(async (tx) => ({
            punch: (
              await tx.punches.list({ where: { ...actor, id }, limit: 1 })
            )[0],
            breaks: await tx.breaks.list({
              where: { tenantId: actor.tenantId, punchId: id },
            }),
            segments: await tx.segments.list({
              where: { tenantId: actor.tenantId, punchId: id },
            }),
          }));
        let state = await run();
        expect(state.punch.unpaidBreakSeconds).toBe(3600 + 1800);
        expect(state.punch.durationSeconds).toBe(7 * 3600 - 1800);
        const changed = await fix.saveBreak({
          ...base(),
          punchId: id,
          breakId: added.targetId,
          paid: true,
        });
        expect(changed.kind).toBe('break.changed');
        expect(changed.getBefore()).toMatchObject({ paid: false });
        state = await run();
        expect(state.punch.durationSeconds).toBe(7 * 3600);
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const rows = await AttendanceBreakCollection.create({ db });
          const stored = await rows.get(state.breaks[0].id!);
          await expect(stored!.delete()).rejects.toThrow('immutable');
          // clearing the in-memory end must not make a closed break deletable
          stored!.endedAt = null;
          await expect(stored!.delete()).rejects.toThrow('immutable');
        });
        expect(await run().then((r) => r.breaks)).toHaveLength(2);
        await fix.removeBreak({ ...base(), breakId: added.targetId });
        state = await run();
        expect(state.breaks).toHaveLength(1);
        expect(state.punch.unpaidBreakSeconds).toBe(3600);
        // segments: trim the morning one, add an afternoon one, drop the morning
        const [morning] = state.segments;
        expect(morning.endedAt).toEqual(at(12));
        const trimmed = await fix.saveSegment({
          ...base(),
          punchId: id,
          segmentId: morning.id!,
          endedAt: at(11),
        });
        expect(trimmed.getAfter()).toMatchObject({ durationSeconds: 3 * 3600 });
        await fix.saveSegment({
          ...base(),
          punchId: id,
          startedAt: at(13),
          endedAt: at(15),
          work: { ...work, workRefId: 'work-2', description: 'Weld' },
        });
        await fix.removeSegment({ ...base(), segmentId: morning.id! });
        state = await run();
        expect(state.segments.map((g) => g.workRefId)).toEqual(['work-2']);
        expect(state.segments[0].durationSeconds).toBe(2 * 3600);
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const rows = await AttendanceSegmentCollection.create({ db });
          const stored = await rows.get(state.segments[0].id!);
          await expect(stored!.delete()).rejects.toThrow('immutable');
          stored!.endedAt = null;
          await expect(stored!.delete()).rejects.toThrow('immutable');
        });
        expect(await run().then((r) => r.segments)).toHaveLength(1);
        expect((await ledger(id)).map((r) => r.kind)).toEqual([
          'break.added',
          'break.changed',
          'break.removed',
          'segment.changed',
          'segment.added',
          'segment.removed',
        ]);
      });
      it('keeps a draft evidence entry in step and refuses a submitted one', async () => {
        await service.punchIn(at(8));
        const punch = await service.punchOut(at(16), work);
        await fix.correctPunch({
          ...base(),
          punchId: punch.id!,
          endedAt: at(15),
        });
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const entries = await ServiceTimeEntryCollection.create({ db });
          const entry = await entries.get(punch.serviceTimeEntryId!);
          expect(entry).toMatchObject({ durationSeconds: 7 * 3600 });
          expect(entry!.endedAt).toEqual(at(15));
          entry!.status = 'submitted';
          await entry!.save();
        });
        await expect(
          fix.correctPunch({ ...base(), punchId: punch.id!, endedAt: at(14) }),
        ).rejects.toThrow('ServiceEvidenceService');
      });
      it('lets only the subject acknowledge, once, and keeps the ledger append-only', async () => {
        const punch = await day();
        const row = await fix.correctPunch({
          ...base(),
          punchId: punch.id!,
          endedAt: at(15),
          acknowledgementRequired: true,
        });
        const mine = new AttendanceCorrectionService(db, actor);
        expect((await mine.pendingAcknowledgements()).map((r) => r.id)).toEqual(
          [row.id],
        );
        await expect(fix.acknowledge(row.id!)).rejects.toThrow(
          'Only the subject',
        );
        const done = await mine.acknowledge(row.id!, at(17));
        expect(done.acknowledgedAt).toEqual(at(17));
        expect(done.acknowledgedByProfileId).toBe(actor.profileId);
        expect(await mine.pendingAcknowledgements()).toHaveLength(0);
        await expect(mine.acknowledge(row.id!)).rejects.toThrow('already');
        const plain = await fix.correctPunch({
          ...base(),
          punchId: punch.id!,
          endedAt: at(14),
        });
        await expect(mine.acknowledge(plain.id!)).rejects.toThrow(
          'does not require',
        );
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const rows = await AttendanceCorrectionCollection.create({ db });
          const stored = await rows.get(row.id!);
          stored!.reason = 'edited';
          await expect(stored!.save()).rejects.toThrow('only through');
          const unacked = await rows.get(plain.id!);
          // the subject cannot be countersigned for through the ORM either
          unacked!.acknowledgedAt = at(18);
          unacked!.acknowledgedByProfileId = actor.profileId;
          await expect(unacked!.save()).rejects.toThrow('only through');
          // and history cannot be fabricated through collection create
          await expect(
            rows.create({
              tenantId: actor.tenantId,
              subjectProfileId: actor.profileId,
              actorProfileId: foreman,
              kind: 'punch.corrected',
              punchId: punch.id!,
              targetId: punch.id!,
              reason: 'invented',
            }),
          ).rejects.toThrow('only through');
          await expect(stored!.delete()).rejects.toThrow('cannot be deleted');
        });
      });
      it('resumes only the work the latest break interrupted', async () => {
        await service.punchIn(at(8));
        await service.startWork(at(8), work);
        await service.startBreak(at(9));
        await service.endBreak(at(10));
        await service.startBreak(at(11)); // idle: no work was running
        await expect(
          service.endBreak(at(12), { resumeWork: true }),
        ).rejects.toThrow('No work interrupted');
        const punch = await service.punchOut(at(13));
        expect(punch.endedAt).toEqual(at(13));
      });
      it('refuses a direct break that overlaps a work segment', async () => {
        const punch = await service.punchIn(at(8));
        await service.startWork(at(8), work);
        await withTenant({ tenantId: actor.tenantId }, async () => {
          await expect(
            (await AttendanceBreakCollection.create({ db })).create({
              tenantId: actor.tenantId,
              punchId: punch.id!,
              startedAt: at(9),
            }),
          ).rejects.toThrow('overlap a work segment');
        });
      });
      it('refuses to relink evidence with a different task or kind', async () => {
        await service.punchIn(at(8));
        const punch = await service.punchOut(at(16), {
          ...work,
          taskRefType: '@fixture/work:Operation',
          taskRefId: 'op-1',
          kind: 'weld',
        });
        await service.linkServiceTimeEntry(punch.id!, {
          ...work,
          taskRefType: '@fixture/work:Operation',
          taskRefId: 'op-1',
          kind: 'weld',
        });
        for (const change of [{ taskRefId: 'op-2' }, { kind: 'bend' }] as const)
          await expect(
            service.linkServiceTimeEntry(punch.id!, {
              ...work,
              taskRefType: '@fixture/work:Operation',
              taskRefId: 'op-1',
              kind: 'weld',
              ...change,
            }),
          ).rejects.toThrow('different work');
      });
      it('refuses a generic insert of a break or segment into a closed punch', async () => {
        const punch = await day();
        await withTenant({ tenantId: actor.tenantId }, async () => {
          await expect(
            (await AttendanceBreakCollection.create({ db })).create({
              tenantId: actor.tenantId,
              punchId: punch.id!,
              startedAt: at(15),
              endedAt: half(15),
            }),
          ).rejects.toThrow('closed punch');
          await expect(
            (await AttendanceSegmentCollection.create({ db })).create({
              tenantId: actor.tenantId,
              punchId: punch.id!,
              ...work,
              startedAt: at(15),
              endedAt: at(16),
              closedReason: 'stop',
            }),
          ).rejects.toThrow('closed punch');
        });
        expect(await ledger(punch.id!)).toHaveLength(0);
      });
      it('refuses a correction a guard locks, before any write', async () => {
        const punch = await day();
        const guarded = new AttendanceCorrectionService(
          db,
          { tenantId: actor.tenantId, profileId: foreman },
          { guard: async () => 'period is confirmed' },
        );
        await expect(
          guarded.correctPunch({
            ...base(),
            punchId: punch.id!,
            endedAt: at(15),
          }),
        ).rejects.toThrow('period is confirmed');
        expect(await ledger(punch.id!)).toHaveLength(0);
      });
      describe('open punches', () => {
        const load = (id: string) =>
          new AttendanceService(db, actor).withTransaction(async (tx) => ({
            punch: (
              await tx.punches.list({ where: { ...actor, id }, limit: 1 })
            )[0],
            breaks: await tx.breaks.list({
              where: { tenantId: actor.tenantId, punchId: id },
              orderBy: 'started_at ASC',
            }),
            segments: await tx.segments.list({
              where: { tenantId: actor.tenantId, punchId: id },
              orderBy: 'started_at ASC',
            }),
          }));
        it('corrects only the start of an open punch, never past its first interval', async () => {
          const open = await service.punchIn(at(8));
          await service.startWork(at(9), work);
          await service.stopWork(at(10));
          const row = await fix.correctPunch({
            ...base(),
            punchId: open.id!,
            startedAt: at(7),
          });
          expect(row).toMatchObject({
            kind: 'punch.corrected',
            actorProfileId: foreman,
          });
          expect(row.getBefore()).toMatchObject({
            startedAt: at(8).toISOString(),
            endedAt: null,
          });
          const { punch } = await load(open.id!);
          expect(punch.startedAt).toEqual(at(7));
          expect(punch.endedAt).toBeNull();
          await expect(
            fix.correctPunch({ ...base(), punchId: open.id!, endedAt: at(11) }),
          ).rejects.toThrow('cannot be closed');
          await expect(
            fix.correctPunch({
              ...base(),
              punchId: open.id!,
              startedAt: half(9),
            }),
          ).rejects.toThrow('inside its punch');
          expect(await ledger(open.id!)).toHaveLength(1);
          const closed = await service.punchOut(at(11));
          expect(closed.durationSeconds).toBe(4 * 3600);
        });
        it('saves and removes closed breaks and segments inside an open punch', async () => {
          const open = await service.punchIn(at(8));
          const id = open.id!;
          await fix.saveBreak({
            ...base(),
            punchId: id,
            startedAt: at(10),
            endedAt: half(10),
            paid: false,
          });
          await fix.saveSegment({
            ...base(),
            punchId: id,
            startedAt: at(8),
            endedAt: at(10),
            work,
          });
          let state = await load(id);
          expect(state.breaks).toHaveLength(1);
          expect(state.segments).toHaveLength(1);
          await fix.saveBreak({
            ...base(),
            punchId: id,
            breakId: state.breaks[0].id!,
            endedAt: at(11),
          });
          await service.startWork(at(11), work);
          state = await load(id);
          // The open segment stays service-owned and bounds closed edits.
          const openSegment = state.segments.find((x) => !x.endedAt)!;
          await expect(
            fix.saveSegment({
              ...base(),
              punchId: id,
              segmentId: openSegment.id!,
              endedAt: at(12),
            }),
          ).rejects.toThrow('AttendanceService');
          await expect(
            fix.removeSegment({ ...base(), segmentId: openSegment.id! }),
          ).rejects.toThrow('AttendanceService');
          await expect(
            fix.saveBreak({
              ...base(),
              punchId: id,
              startedAt: half(11),
              endedAt: at(12),
            }),
          ).rejects.toThrow('overlap');
          await fix.removeBreak({ ...base(), breakId: state.breaks[0].id! });
          await fix.removeSegment({
            ...base(),
            segmentId: state.segments.find((x) => x.endedAt)!.id!,
          });
          state = await load(id);
          expect(state.breaks).toHaveLength(0);
          expect(state.segments).toHaveLength(1);
          expect(state.punch.endedAt).toBeNull();
          expect(await ledger(id)).toHaveLength(5);
        });
        it('adds an open punch with closed breaks and segments and a ledger row', async () => {
          const detailedWork = {
            ...work,
            taskRefType: 'test:Task',
            taskRefId: crypto.randomUUID(),
            kind: 'installation',
            description: 'Install the replacement pump',
          };
          const row = await fix.addPunch({
            ...base(),
            open: true,
            startedAt: at(8),
            breaks: [{ startedAt: at(12), endedAt: at(13), paid: false }],
            segments: [
              { startedAt: at(8), endedAt: at(12), work: detailedWork },
            ],
          });
          expect(row).toMatchObject({
            kind: 'punch.added',
            actorProfileId: foreman,
          });
          const { punch, breaks, segments } = await load(row.punchId!);
          expect(punch.endedAt).toBeNull();
          expect(breaks).toHaveLength(1);
          expect(segments).toHaveLength(1);
          const expectedSegment = {
            ...detailedWork,
            startedAt: at(8).toISOString(),
            endedAt: at(12).toISOString(),
            durationSeconds: 4 * 3600,
            closedReason: 'stop',
          };
          expect(segments[0]).toMatchObject({
            ...expectedSegment,
            startedAt: at(8),
            endedAt: at(12),
          });
          const [storedCorrection] = await ledger(punch.id!);
          expect(storedCorrection.getAfter()).toMatchObject({
            segments: [expectedSegment],
          });
          await expect(
            fix.addPunch({ ...base(), open: true, startedAt: at(14) }),
          ).rejects.toThrow('already open');
          const closed = await service.punchOut(at(16));
          expect(closed.id).toBe(punch.id);
          expect(closed.durationSeconds).toBe(7 * 3600);
        });
        it('rolls back an added open punch and its children if its ledger write fails', async () => {
          const write = vi
            .spyOn(AttendanceCorrection.prototype, 'save')
            .mockRejectedValueOnce(new Error('ledger unavailable'));
          const input = {
            ...base(),
            open: true as const,
            startedAt: at(8),
            breaks: [{ startedAt: at(12), endedAt: at(13), paid: false }],
            segments: [{ startedAt: at(8), endedAt: at(12), work }],
          };
          await expect(fix.addPunch(input)).rejects.toThrow(
            'ledger unavailable',
          );
          write.mockRestore();
          await service.withTransaction(async (tx) => {
            expect(await tx.punches.list({ where: actor })).toHaveLength(0);
            expect(
              await tx.breaks.list({ where: { tenantId: actor.tenantId } }),
            ).toHaveLength(0);
            expect(
              await tx.segments.list({ where: { tenantId: actor.tenantId } }),
            ).toHaveLength(0);
          });
          const row = await fix.addPunch(input);
          expect(await ledger(row.punchId!)).toHaveLength(1);
          expect((await service.punchOut(at(16))).durationSeconds).toBe(
            7 * 3600,
          );
        });
        it('honours the correction guard and subject ownership for open punches', async () => {
          const punch = await service.punchIn(at(8));
          const guarded = new AttendanceCorrectionService(
            db,
            { tenantId: actor.tenantId, profileId: foreman },
            { guard: async () => 'period is confirmed' },
          );
          await expect(
            guarded.correctPunch({
              ...base(),
              punchId: punch.id!,
              startedAt: at(7),
            }),
          ).rejects.toThrow('period is confirmed');
          await expect(
            fix.correctPunch({
              ...base(),
              subjectProfileId: crypto.randomUUID(),
              punchId: punch.id!,
              startedAt: at(7),
            }),
          ).rejects.toThrow('not found');
          expect((await load(punch.id!)).punch.startedAt).toEqual(at(8));
          expect(await ledger(punch.id!)).toHaveLength(0);
        });
        it('refuses an added open punch that overlaps or has a bad layout', async () => {
          await day();
          await expect(
            fix.addPunch({ ...base(), open: true, startedAt: at(9) }),
          ).rejects.toThrow('overlap');
          await expect(
            fix.addPunch({
              ...base(),
              open: true,
              startedAt: at(20),
              breaks: [{ startedAt: at(19), endedAt: at(21) }],
            }),
          ).rejects.toThrow('inside its punch');
        });
      });
      it('keeps auto-close reason and provenance when an auto-closed punch is corrected', async () => {
        await service.punchIn(at(8), {
          source: 'device',
          device: { type: '@fixture/shop:Station', id: 'station-1' },
        });
        const closed = await service.autoClose(at(20), () => ({
          deadline: at(16),
          reason: 'shiftEnd',
        }));
        await fix.correctPunch({
          ...base(),
          punchId: closed!.id!,
          endedAt: at(15),
        });
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const punches = await AttendancePunchCollection.create({ db });
          const [row] = await punches.list({
            where: { tenantId: actor.tenantId, id: closed!.id! },
          });
          expect(row).toMatchObject({
            endedAt: at(15),
            autoCloseReason: 'shiftEnd',
            source: 'device',
            deviceRefId: 'station-1',
          });
        });
        expect(await service.autoClose(at(21), () => at(17))).toBeNull();
      });
      it('sets punch provenance and break kind through corrections', async () => {
        const device = { type: '@fixture/shop:Station', id: 'station-9' };
        await fix.addPunch({
          ...base(),
          startedAt: at(6),
          endedAt: at(7),
          source: 'correction',
          device,
        });
        const punch = await day();
        const added = await fix.saveBreak({
          ...base(),
          punchId: punch.id!,
          startedAt: at(14),
          endedAt: half(14),
          kind: 'rest',
        });
        expect(added.getAfter()).toMatchObject({ kind: 'rest' });
        const changed = await fix.saveBreak({
          ...base(),
          punchId: punch.id!,
          breakId: added.targetId,
          kind: 'meal',
        });
        expect(changed.getBefore()).toMatchObject({ kind: 'rest' });
        expect(changed.getAfter()).toMatchObject({ kind: 'meal' });
        const kept = await fix.saveBreak({
          ...base(),
          punchId: punch.id!,
          breakId: added.targetId,
          endedAt: at(15),
        });
        expect(kept.getAfter()).toMatchObject({ kind: 'meal' });
        await withTenant({ tenantId: actor.tenantId }, async () => {
          const punches = await AttendancePunchCollection.create({ db });
          const found = await punches.list({
            where: { tenantId: actor.tenantId, source: 'correction' },
          });
          expect(found).toHaveLength(1);
          expect(found[0]).toMatchObject({ deviceRefId: 'station-9' });
        });
      });
    });
  });
}
