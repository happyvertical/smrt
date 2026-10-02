import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttendanceService, ServiceTimeEntryCollection } from '../index.js';
import {
  PeriodRollupService,
  type PeriodRulesResolver,
  PeriodTimecardCollection,
  TimecardAdjustmentCollection,
} from '../rollup.js';

const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
export function rollupSuite(
  name: string,
  create: () => Promise<DatabaseInterface>,
  cleanup: () => Promise<void>,
) {
  describe(name, () => {
    let db: DatabaseInterface;
    let actor: { tenantId: string; profileId: string };
    let resolver: PeriodRulesResolver;
    let service: PeriodRollupService;
    beforeEach(async () => {
      db = await create();
      actor = {
        tenantId: `a${crypto.randomUUID().slice(1)}`,
        profileId: `b${crypto.randomUUID().slice(1)}`,
      };
      resolver = {
        periodFor: async () => ({
          startsAt: at(0),
          endsAt: at(24),
          timezone: 'America/Edmonton',
          version: 'configured-v1',
          rules: { thresholdSeconds: 3600, holidays: ['2026-10-01'] },
        }),
        classify: async (_period, sources) => {
          const total = sources.reduce((sum, row) => sum + row.seconds, 0);
          return {
            regularSeconds: Math.min(3600, total),
            overtimeSeconds: Math.max(0, total - 3600),
          };
        },
      };
      service = new PeriodRollupService(db, actor, resolver);
    });
    afterEach(async () => {
      vi.restoreAllMocks();
      await cleanup();
    });
    async function entry(
      durationSeconds = 7200,
      overrides: Record<string, unknown> = {},
    ) {
      return withTenant({ tenantId: actor.tenantId }, async () => {
        const collection = await ServiceTimeEntryCollection.create({ db });
        return collection.create({
          tenantId: actor.tenantId,
          participantProfileId: actor.profileId,
          participantKind: 'human',
          workRefType: '@fixture/Work',
          workRefId: 'work',
          startedAt: at(8),
          endedAt: at(10),
          durationSeconds,
          status: 'approved',
          approvedAt: at(10),
          ...overrides,
        });
      });
    }
    it('rolls up approved person evidence with integer classification and repeat identity', async () => {
      const source = await entry();
      await entry(300, { status: 'draft' });
      await entry(300, { participantProfileId: crypto.randomUUID() });
      await entry(300, { participantKind: 'agent', agentRef: 'agent' });
      const card = await service.rollup(at(12));
      expect(card).toMatchObject({
        ...actor,
        status: 'open',
        regularSeconds: 3600,
        overtimeSeconds: 3600,
        totalSeconds: 7200,
      });
      expect(card.getSources()).toEqual([
        expect.objectContaining({
          id: source.id,
          seconds: 7200,
          kind: 'entry',
        }),
      ]);
      expect(card.getRules()).toEqual({
        thresholdSeconds: 3600,
        holidays: ['2026-10-01'],
      });
      const repeated = await service.rollup(at(12));
      expect(repeated.id).toBe(card.id);
      await entry(60);
      expect((await service.rollup(at(12))).totalSeconds).toBe(7260);
    });
    it('clips half-open intervals and allocates duration-only entries to approval time', async () => {
      await entry(7200, { startedAt: at(-1), endedAt: at(1) });
      await entry(61, { startedAt: null, endedAt: null, approvedAt: at(12) });
      await entry(70, { startedAt: at(24), endedAt: at(25) });
      expect((await service.rollup(at(12))).totalSeconds).toBe(3661);
    });
    it('uses only approved corrections and rejects forged cross-person ancestry', async () => {
      const original = await entry(7200, { status: 'corrected' });
      await entry(3600, { correctionOfId: original.id });
      expect((await service.rollup(at(12))).totalSeconds).toBe(3600);
      const other = await entry(10, {
        participantProfileId: crypto.randomUUID(),
        status: 'corrected',
      });
      await entry(10, { correctionOfId: other.id });
      await expect(service.rollup(at(12))).rejects.toThrow('same actor scope');
    });
    it('rejects two approved corrections of the same evidence root', async () => {
      const original = await entry(7200, { status: 'corrected' });
      await entry(3600, { correctionOfId: original.id });
      await entry(3600, { correctionOfId: original.id });
      await expect(service.rollup(at(12))).rejects.toThrow(
        'Ambiguous approved',
      );
    });
    it('isolates all reads and mutations by tenant/person and active context', async () => {
      await entry();
      const card = await service.rollup(at(12));
      const stranger = new PeriodRollupService(
        db,
        { ...actor, profileId: crypto.randomUUID() },
        resolver,
      );
      await expect(stranger.get(card.id!)).rejects.toThrow('actor scope');
      await expect(stranger.confirm(card.id!)).rejects.toThrow('actor scope');
      const foreign = new PeriodRollupService(
        db,
        { ...actor, tenantId: crypto.randomUUID() },
        resolver,
      );
      await expect(foreign.get(card.id!)).rejects.toThrow('actor scope');
      expect((await foreign.rollup(at(12))).totalSeconds).toBe(0);
      expect((await stranger.rollup(at(12))).totalSeconds).toBe(0);
      await expect(
        stranger.adjust(card.id!, {
          operationId: 'forbidden',
          regularSeconds: 1,
          overtimeSeconds: 0,
          reason: 'Denied',
        }),
      ).rejects.toThrow('actor scope');
      await withTenant({ tenantId: crypto.randomUUID() }, async () => {
        await expect(service.rollup(at(12))).rejects.toThrow('active tenant');
        await expect(service.get(card.id!)).rejects.toThrow('active tenant');
      });
    });
    it('freezes confirmation and blocks model and collection save/delete paths', async () => {
      await entry();
      const card = await service.rollup(at(12));
      const confirmed = await service.confirm(card.id!);
      expect(confirmed).toMatchObject({
        status: 'confirmed',
        confirmedByProfileId: actor.profileId,
      });
      expect((await service.confirm(card.id!)).confirmedAt).toEqual(
        confirmed.confirmedAt,
      );
      await expect(service.rollup(at(12))).rejects.toThrow('immutable');
      await withTenant({ tenantId: actor.tenantId }, async () => {
        confirmed.totalSeconds = 1;
        await expect(confirmed.save()).rejects.toThrow('PeriodRollupService');
        await expect(confirmed.delete()).rejects.toThrow('cannot be deleted');
        const cards = await PeriodTimecardCollection.create({ db });
        await expect(cards.delete(card.id!)).rejects.toThrow(
          'cannot be deleted',
        );
        await expect(
          cards.create({ id: card.id, ...actor, totalSeconds: 1 }),
        ).rejects.toThrow('PeriodRollupService');
      });
      expect((await service.get(card.id!)).totalSeconds).toBe(7200);
    });
    it('appends attributed adjustments with idempotency and effective totals', async () => {
      await entry();
      const card = await service.rollup(at(12));
      const input = {
        operationId: 'correction-1',
        regularSeconds: -60,
        overtimeSeconds: 120,
        reason: 'Reviewed timesheet correction',
      };
      await expect(service.adjust(card.id!, input)).rejects.toThrow(
        'confirmed',
      );
      await service.confirm(card.id!);
      const adjustment = await service.adjust(card.id!, input);
      expect(adjustment).toMatchObject({
        ...actor,
        ...input,
        actorProfileId: actor.profileId,
      });
      expect((await service.adjust(card.id!, input)).id).toBe(adjustment.id);
      await expect(
        service.adjust(card.id!, { ...input, reason: 'different' }),
      ).rejects.toThrow('different payload');
      await expect(
        service.adjust(card.id!, {
          ...input,
          operationId: 'negative',
          regularSeconds: -99999,
        }),
      ).rejects.toThrow('nonnegative');
      expect(await service.totals(card.id!)).toEqual({
        regularSeconds: 3540,
        overtimeSeconds: 3720,
        totalSeconds: 7260,
      });
      expect((await service.get(card.id!)).totalSeconds).toBe(7200);
      await withTenant({ tenantId: actor.tenantId }, async () => {
        adjustment.reason = 'tamper';
        await expect(adjustment.save()).rejects.toThrow('PeriodRollupService');
        const adjustments = await TimecardAdjustmentCollection.create({ db });
        await expect(adjustments.delete(adjustment.id!)).rejects.toThrow(
          'cannot be deleted',
        );
        await expect(
          adjustments.create({ id: adjustment.id, ...actor }),
        ).rejects.toThrow('PeriodRollupService');
      });
    });
    it('computes safe effective totals independently of adjustment query order', async () => {
      const card = await service.rollup(at(12));
      await service.confirm(card.id!);
      for (const [operationId, seconds] of [
        ['add', Number.MAX_SAFE_INTEGER],
        ['undo', -Number.MAX_SAFE_INTEGER],
        ['again', Number.MAX_SAFE_INTEGER],
      ] as const) {
        await service.adjust(card.id!, {
          operationId,
          regularSeconds: seconds,
          overtimeSeconds: 0,
          reason: 'Boundary arithmetic',
        });
      }
      const list = TimecardAdjustmentCollection.prototype.list;
      vi.spyOn(
        TimecardAdjustmentCollection.prototype,
        'list',
      ).mockImplementation(async function (
        this: TimecardAdjustmentCollection,
        options,
      ) {
        const rows = await list.call(this, options);
        return rows.sort((a, b) => b.regularSeconds - a.regularSeconds);
      });
      expect((await service.totals(card.id!)).regularSeconds).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });
    it('serializes concurrent rollups and duplicate adjustment retries', async () => {
      await entry();
      const cards = await Promise.all([
        service.rollup(at(12)),
        service.rollup(at(12)),
      ]);
      expect(cards[0].id).toBe(cards[1].id);
      await service.confirm(cards[0].id!);
      const input = {
        operationId: 'parallel',
        regularSeconds: 10,
        overtimeSeconds: 0,
        reason: 'Fix',
      };
      const adjustments = await Promise.all([
        service.adjust(cards[0].id!, input),
        service.adjust(cards[0].id!, input),
      ]);
      expect(adjustments[0].id).toBe(adjustments[1].id);
      expect((await service.totals(cards[0].id!)).totalSeconds).toBe(7210);
    });
    it('respects native UUID identity on PostgreSQL and text identity on SQLite', async () => {
      await entry();
      const variant = new PeriodRollupService(
        db,
        {
          tenantId: actor.tenantId.toUpperCase(),
          profileId: actor.profileId.toUpperCase(),
        },
        resolver,
      );
      const [normal, upper] = await Promise.all([
        service.rollup(at(12)),
        variant.rollup(at(12)),
      ]);
      if (isPostgresDatabase(db)) {
        expect(upper.id).toBe(normal.id);
        expect(upper.totalSeconds).toBe(7200);
      } else {
        expect(upper.id).not.toBe(normal.id);
        expect(upper.totalSeconds).toBe(0);
      }
    });
    it('rejects malformed resolver output and preserves the prior card on failure', async () => {
      await entry();
      const card = await service.rollup(at(12));
      const classify = resolver.classify;
      resolver.classify = async () => ({
        regularSeconds: 0.5,
        overtimeSeconds: 0,
      });
      await expect(service.rollup(at(12))).rejects.toThrow('safe integers');
      resolver.classify = async () => ({
        regularSeconds: 1,
        overtimeSeconds: 0,
      });
      await expect(service.rollup(at(12))).rejects.toThrow('conserve');
      resolver.classify = async () => {
        throw new Error('Upstream unavailable');
      };
      await expect(service.rollup(at(12))).rejects.toThrow('Upstream');
      resolver.classify = classify;
      resolver.periodFor = async () => ({
        startsAt: at(24),
        endsAt: at(48),
        timezone: 'UTC',
        version: 'v2',
        rules: {},
      });
      await expect(service.rollup(at(12))).rejects.toThrow('contain');
      resolver.periodFor = async () => ({
        startsAt: at(0),
        endsAt: at(24),
        timezone: 'not-a-timezone',
        version: 'v2',
        rules: {},
      });
      await expect(service.rollup(at(12))).rejects.toThrow();
      resolver.periodFor = async () => ({
        startsAt: at(0),
        endsAt: at(24),
        timezone: 'UTC',
        version: 'v2',
        rules: { threshold: Number.NaN },
      });
      await expect(service.rollup(at(12))).rejects.toThrow('JSON serializable');
      resolver.periodFor = async () => ({
        startsAt: at(0),
        endsAt: at(24),
        timezone: 'UTC',
        version: '',
        rules: {},
      });
      await expect(service.rollup(at(12))).rejects.toThrow('policy version');
      expect((await service.get(card.id!)).totalSeconds).toBe(7200);
    });
    it('rolls back a saved timecard when the enclosing transaction fails', async () => {
      await entry();
      const original = db.transaction!.bind(db);
      const spy = vi
        .spyOn(db, 'transaction')
        .mockImplementation(async (callback) =>
          original(async (transaction) => {
            await callback(transaction);
            throw new Error('Injected transaction failure');
          }),
        );
      await expect(service.rollup(at(12))).rejects.toThrow('Injected');
      spy.mockRestore();
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const cards = await PeriodTimecardCollection.create({ db });
        expect(await cards.list({ where: actor })).toHaveLength(0);
      });
      expect((await service.rollup(at(12))).totalSeconds).toBe(7200);
    });
    it('optionally clips attendance breaks and deduplicates linked evidence', async () => {
      const attendance = new AttendanceService(db, actor);
      await attendance.punchIn(at(-1));
      await attendance.startBreak(at(0));
      await attendance.endBreak(at(1));
      await attendance.startBreak(at(1), true);
      await attendance.endBreak(new Date(at(1).getTime() + 1800000));
      const punch = await attendance.punchOut(at(2), {
        workRefType: '@fixture/Work',
        workRefId: 'work',
        description: 'Work',
      });
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const entries = await ServiceTimeEntryCollection.create({ db });
        const linked = await entries.get(punch.serviceTimeEntryId!);
        linked!.status = 'submitted';
        await linked!.save();
        linked!.status = 'approved';
        linked!.approvedAt = at(2);
        await linked!.save();
      });
      const enabled = new PeriodRollupService(db, actor, resolver, {
        attendance: true,
      });
      const card = await enabled.rollup(at(12));
      expect(card.totalSeconds).toBe(3600);
      expect(card.getSources()).toHaveLength(2);
      expect(
        card
          .getSources()
          .every(
            (source) =>
              source.kind === 'attendance' &&
              source.id === punch.id &&
              source.seconds === 1800,
          ),
      ).toBe(true);
    });
    it('supports an explicitly resolved 25-hour DST period and supervisor attribution', async () => {
      const start = new Date('2026-11-01T06:00:00Z');
      const end = new Date('2026-11-02T07:00:00Z');
      await entry(25 * 3600, { startedAt: start, endedAt: end });
      resolver.periodFor = async () => ({
        startsAt: start,
        endsAt: end,
        timezone: 'America/Edmonton',
        version: 'local-day-v1',
        rules: { lengthDays: 1, startDay: 0, holiday: false },
      });
      const supervisor = crypto.randomUUID();
      const supervised = new PeriodRollupService(db, actor, resolver, {
        actorProfileId: supervisor,
      });
      const card = await supervised.rollup(new Date('2026-11-01T12:00:00Z'));
      expect(card.totalSeconds).toBe(90000);
      expect((await supervised.confirm(card.id!)).confirmedByProfileId).toBe(
        supervisor,
      );
      const adjustment = await supervised.adjust(card.id!, {
        operationId: 'supervisor',
        regularSeconds: 1,
        overtimeSeconds: 0,
        reason: 'Correction',
      });
      expect(adjustment.actorProfileId).toBe(supervisor);
      await expect(
        service.adjust(card.id!, {
          operationId: 'supervisor',
          regularSeconds: 1,
          overtimeSeconds: 0,
          reason: 'Correction',
        }),
      ).rejects.toThrow('different payload');
    });
    it('rejects overlapping calendar revisions and detached input mutation', async () => {
      await entry();
      const first = await service.rollup(at(12));
      resolver.periodFor = async () => ({
        startsAt: at(-1),
        endsAt: at(24),
        timezone: 'UTC',
        version: 'v2',
        rules: {},
      });
      await expect(service.rollup(at(12))).rejects.toThrow('overlaps');
      resolver.periodFor = async () => ({
        startsAt: at(0),
        endsAt: at(24),
        timezone: 'UTC',
        version: 'v3',
        rules: { marker: 'original' },
      });
      resolver.classify = async (period, sources) => {
        (period.rules as Record<string, unknown>).marker = 'mutated';
        (sources[0] as { seconds: number }).seconds = 0;
        return { regularSeconds: 3600, overtimeSeconds: 3600 };
      };
      const card = await service.rollup(at(12));
      expect(card.id).toBe(first.id);
      expect(card.getSources()[0].seconds).toBe(7200);
      expect(card.getRules()).toEqual({ marker: 'original' });
    });
    it('excludes open and review-required attendance and linked correction descendants', async () => {
      const attendance = new AttendanceService(db, actor);
      await attendance.punchIn(at(1));
      const punch = await attendance.punchOut(at(3), {
        workRefType: '@fixture/Work',
        workRefId: 'work',
        description: 'Work',
      });
      await withTenant({ tenantId: actor.tenantId }, async () => {
        const entries = await ServiceTimeEntryCollection.create({ db });
        const linked = await entries.get(punch.serviceTimeEntryId!);
        linked!.status = 'submitted';
        await linked!.save();
        linked!.status = 'approved';
        await linked!.save();
        linked!.status = 'corrected';
        await linked!.save();
      });
      await entry(1800, { correctionOfId: punch.serviceTimeEntryId });
      await attendance.punchIn(at(4));
      await attendance.autoClose(at(6), 3600);
      await attendance.punchIn(at(7));
      const enabled = new PeriodRollupService(db, actor, resolver, {
        attendance: true,
      });
      expect((await enabled.rollup(at(12))).totalSeconds).toBe(7200);
    });
    it('rolls back an adjustment and permits the same operation retry', async () => {
      await entry();
      const card = await service.rollup(at(12));
      await service.confirm(card.id!);
      const original = db.transaction!.bind(db);
      const spy = vi
        .spyOn(db, 'transaction')
        .mockImplementation(async (callback) =>
          original(async (transaction) => {
            await callback(transaction);
            throw new Error('Adjustment commit failed');
          }),
        );
      const input = {
        operationId: 'rollback',
        regularSeconds: 60,
        overtimeSeconds: 0,
        reason: 'Retry',
      };
      await expect(service.adjust(card.id!, input)).rejects.toThrow(
        'Adjustment commit failed',
      );
      spy.mockRestore();
      expect((await service.totals(card.id!)).totalSeconds).toBe(7200);
      await service.adjust(card.id!, input);
      expect((await service.totals(card.id!)).totalSeconds).toBe(7260);
    });
  });
}
