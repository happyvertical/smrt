import { isPostgresDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AttendanceCorrectionService,
  AttendanceService,
  SERVICE_DURATION_HOURS_EVIDENCE,
  ServiceTimeEntryCollection,
} from '../index.js';
import {
  confirmedTimecardGuard,
  PeriodRollupService,
  type PeriodRulesResolver,
  PeriodTimecardCollection,
  TimecardAdjustmentCollection,
  TimecardReopening,
} from '../rollup.js';

const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
const half = (hour: number) => new Date(at(hour).getTime() + 30 * 60_000);
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
    it('rejects decimal-hours-only sources without creating a zero-second card', async () => {
      await entry(0, {
        durationSeconds: null,
        startedAt: null,
        endedAt: null,
        evidence: JSON.stringify([
          { kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '1.0005' },
        ]),
      });
      await expect(service.rollup(at(12))).rejects.toThrow(
        /no measured durationSeconds/,
      );
      expect(
        await (await PeriodTimecardCollection.create({ db })).count({
          where: { tenantId: actor.tenantId },
        }),
      ).toBe(0);
    });
    it('does not let hours-only evidence outside the period block its rollup', async () => {
      await entry(0, {
        durationSeconds: null,
        startedAt: null,
        endedAt: null,
        approvedAt: at(-1),
        evidence: JSON.stringify([
          { kind: SERVICE_DURATION_HOURS_EVIDENCE, hours: '1.0005' },
        ]),
      });
      expect((await service.rollup(at(12))).totalSeconds).toBe(0);
    });
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
    it('attributes end-only entries to approval without blocking unrelated periods', async () => {
      const source = await entry(61, {
        startedAt: null,
        endedAt: at(-2),
        approvedAt: at(12),
      });
      const card = await service.rollup(at(12));
      expect(card.totalSeconds).toBe(61);
      expect(card.getSources()).toEqual([
        expect.objectContaining({
          id: source.id,
          startsAt: at(12).toISOString(),
          endsAt: at(12).toISOString(),
          seconds: 61,
        }),
      ]);
      resolver.periodFor = async () => ({
        startsAt: at(-24),
        endsAt: at(0),
        timezone: 'UTC',
        version: 'configured-v1',
        rules: {},
      });
      expect((await service.rollup(at(-12))).totalSeconds).toBe(0);
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
    it.each([
      false,
      true,
    ])('retains late replay flags across online taps (separate batches: %s)', async (separate) => {
      const attendance = new AttendanceService(db, actor);
      const taps = [
        {
          clientId: 'late-in',
          action: 'punchIn' as const,
          at: at(8).toISOString(),
        },
        {
          clientId: 'online-out',
          action: 'punchOut' as const,
          at: at(10).toISOString(),
        },
      ];
      const options = {
        resolveAt: ({ deviceAt }: { deviceAt: Date }) => ({
          at: deviceAt,
          reviewRequired: deviceAt.getTime() === at(8).getTime(),
          recordedOffline: deviceAt.getTime() === at(8).getTime(),
        }),
      };
      const outcomes = separate
        ? [
            ...(await attendance.replay([taps[0]], options)),
            ...(await attendance.replay([taps[1]], options)),
          ]
        : await attendance.replay(taps, options);
      expect(outcomes.every((outcome) => !outcome.error)).toBe(true);
      const read = () =>
        attendance.withTransaction((tx) =>
          tx.punches.get(outcomes[0].punchId!),
        );
      expect(await read()).toMatchObject({
        reviewRequired: true,
        recordedOffline: true,
      });
      const enabled = new PeriodRollupService(db, actor, resolver, {
        attendance: true,
      });
      expect((await enabled.rollup(at(12))).totalSeconds).toBe(0);
      expect(
        await attendance.replay(taps, {
          resolveAt: () => {
            throw new Error('A receipt retry must not resolve time again.');
          },
        }),
      ).toEqual(outcomes);
      await new AttendanceCorrectionService(db, actor).correctPunch({
        subjectProfileId: actor.profileId,
        punchId: outcomes[0].punchId!,
        startedAt: at(8),
        reason: 'Reviewed the late clock-in',
      });
      expect(await read()).toMatchObject({
        reviewRequired: false,
        recordedOffline: true,
      });
      expect((await enabled.rollup(at(12))).totalSeconds).toBe(7200);
    });
    it('rolls up fractional-second attendance using integer elapsed milliseconds', async () => {
      const attendance = new AttendanceService(db, actor);
      const instant = (ms: number) => new Date(at(8).getTime() + ms);
      await attendance.punchIn(instant(0));
      await attendance.startBreak(instant(1000));
      await attendance.endBreak(instant(1600));
      const punch = await attendance.punchOut(instant(4100));
      const enabled = new PeriodRollupService(db, actor, resolver, {
        attendance: true,
      });
      expect((await enabled.rollup(at(12))).totalSeconds).toBe(4);
      expect(punch.durationSeconds).toBe(4);
      resolver.periodFor = async () => ({
        startsAt: at(24),
        endsAt: at(48),
        timezone: 'UTC',
        version: 'configured-v1',
        rules: {},
      });
      expect((await enabled.rollup(at(36))).totalSeconds).toBe(0);
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
    describe('start attribution', () => {
      const monday = Date.UTC(2026, 9, 5);
      const hourAt = (offset: number) => new Date(monday + offset * 3600_000);
      const weekly = (): PeriodRulesResolver => ({
        periodFor: async (when) => {
          const startsAt = new Date(
            when.getTime() >= monday ? monday : monday - 7 * 86_400_000,
          );
          return {
            startsAt,
            endsAt: new Date(startsAt.getTime() + 7 * 86_400_000),
            timezone: 'UTC',
            version: 'weekly-v1',
            rules: {},
          };
        },
        classify: async (_period, sources) => ({
          regularSeconds: sources.reduce((sum, row) => sum + row.seconds, 0),
          overtimeSeconds: 0,
        }),
      });
      async function crossing(withBreak: boolean) {
        const attendance = new AttendanceService(db, actor);
        await attendance.punchIn(hourAt(-2));
        if (withBreak) {
          await attendance.startBreak(hourAt(1));
          await attendance.endBreak(hourAt(2));
        }
        return attendance.punchOut(hourAt(6));
      }
      const build = (attribution?: 'clip' | 'start') =>
        new PeriodRollupService(db, actor, weekly(), {
          attendance: true,
          attribution,
        });
      const hours = (card: { totalSeconds: number }) =>
        card.totalSeconds / 3600;
      it('clips by default and with attribution clip', async () => {
        await crossing(false);
        for (const attribution of [undefined, 'clip' as const]) {
          const rollup = build(attribution);
          expect(hours(await rollup.rollup(hourAt(-1)))).toBe(2);
          expect(hours(await rollup.rollup(hourAt(1)))).toBe(6);
        }
      });
      it('attributes a crossing punch wholly to the period it started in', async () => {
        const punch = await crossing(false);
        const rollup = build('start');
        const first = await rollup.rollup(hourAt(-1));
        const second = await rollup.rollup(hourAt(1));
        expect(hours(first)).toBe(8);
        expect(hours(second)).toBe(0);
        expect(first.getSources().map((source) => source.id)).toEqual([
          punch.id,
        ]);
        expect(second.getSources()).toHaveLength(0);
      });
      it('keeps breaks with their punch across the boundary', async () => {
        await crossing(true);
        expect(hours(await build('start').rollup(hourAt(-1)))).toBe(7);
        expect(hours(await build('start').rollup(hourAt(1)))).toBe(0);
        const clipped = build('clip');
        expect(hours(await clipped.rollup(hourAt(-1)))).toBe(2);
        expect(hours(await clipped.rollup(hourAt(1)))).toBe(5);
      });
      it('attributes bounded manual evidence by its start', async () => {
        await entry(8 * 3600, {
          startedAt: hourAt(-2),
          endedAt: hourAt(6),
          approvedAt: hourAt(6),
        });
        const rollup = build('start');
        expect(hours(await rollup.rollup(hourAt(-1)))).toBe(8);
        expect(hours(await rollup.rollup(hourAt(1)))).toBe(0);
      });
      it('leaves a confirmed first period undisturbed by the second rollup', async () => {
        await crossing(false);
        const rollup = build('start');
        const first = await rollup.confirm(
          (await rollup.rollup(hourAt(-1))).id!,
        );
        const second = await rollup.rollup(hourAt(1));
        expect(hours(second)).toBe(0);
        const again = await rollup.get(first.id!);
        expect(again.status).toBe('confirmed');
        expect(hours(again)).toBe(8);
        await expect(rollup.rollup(hourAt(-1))).rejects.toThrow('immutable');
      });
      it('rejects an unknown attribution', () => {
        expect(
          () =>
            new PeriodRollupService(db, actor, weekly(), {
              attribution: 'end' as never,
            }),
        ).toThrow('Attribution');
      });
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
    it('refuses attendance corrections inside a confirmed timecard', async () => {
      const attendance = new AttendanceService(db, actor);
      await attendance.punchIn(at(8));
      const punch = await attendance.punchOut(at(10));
      const fix = new AttendanceCorrectionService(
        db,
        { tenantId: actor.tenantId, profileId: actor.profileId },
        { guard: confirmedTimecardGuard },
      );
      const input = {
        subjectProfileId: actor.profileId,
        punchId: punch.id!,
        endedAt: at(9),
        reason: 'left early',
      };
      const card = await service.rollup(at(12));
      await expect(fix.correctPunch(input)).resolves.toBeDefined();
      await service.confirm(card.id!);
      await expect(
        fix.correctPunch({ ...input, endedAt: half(8) }),
      ).rejects.toThrow('confirmed timecard');
    });
    it('submits then confirms, and keeps open -> confirmed by default', async () => {
      await entry();
      const card = await service.rollup(at(12));
      const submitted = await service.submit(card.id!);
      expect(submitted.status).toBe('submitted');
      expect(submitted.submittedByProfileId).toBe(actor.profileId);
      expect((await service.submit(card.id!)).status).toBe('submitted');
      await expect(service.rollup(at(12))).rejects.toThrow('frozen');
      const confirmed = await service.confirm(card.id!);
      expect(confirmed.status).toBe('confirmed');
      await expect(service.submit(card.id!)).rejects.toThrow('open');
      const direct = new PeriodRollupService(db, actor, resolver);
      expect((await direct.get(card.id!)).status).toBe('confirmed');
    });
    it('confirms an open card directly unless submission is required', async () => {
      await entry();
      const card = await service.rollup(at(12));
      const strict = new PeriodRollupService(db, actor, resolver, {
        requireSubmission: true,
      });
      await expect(strict.confirm(card.id!)).rejects.toThrow('submitted');
      await strict.submit(card.id!);
      expect((await strict.confirm(card.id!)).status).toBe('confirmed');
    });
    it('reopens a confirmed card with a reason, audits it, re-rolls and reconfirms', async () => {
      await entry();
      const supervisor = `c${crypto.randomUUID().slice(1)}`;
      const boss = new PeriodRollupService(db, actor, resolver, {
        actorProfileId: supervisor,
      });
      const card = await service.rollup(at(12));
      await service.confirm(card.id!);
      await service.adjust(card.id!, {
        operationId: 'adj',
        regularSeconds: 0,
        overtimeSeconds: 60,
        reason: 'late',
      });
      await expect(
        boss.reopen(card.id!, { operationId: 'r1', reason: ' ' }),
      ).rejects.toThrow('reason');
      await expect(
        boss.reopen(card.id!, { operationId: ' ', reason: 'x' }),
      ).rejects.toThrow('operationId');
      const reopened = await boss.reopen(card.id!, {
        operationId: 'r1',
        reason: 'missed punch',
      });
      expect(reopened.status).toBe('open');
      expect(reopened.confirmedAt).toBeNull();
      const [row] = await boss.reopenings(card.id!);
      expect(row.fromStatus).toBe('confirmed');
      expect(row.actorProfileId).toBe(supervisor);
      expect(row.reason).toBe('missed punch');
      expect(row.getPrevious()).toMatchObject({
        confirmedByProfileId: actor.profileId,
        base: { totalSeconds: 7200 },
        effective: { totalSeconds: 7260 },
        adjustments: { count: 1, overtimeSeconds: 60 },
      });
      // idempotent retry; different payload refused
      await boss.reopen(card.id!, {
        operationId: 'r1',
        reason: 'missed punch',
      });
      await expect(
        boss.reopen(card.id!, { operationId: 'r1', reason: 'other' }),
      ).rejects.toThrow('different payload');
      expect(await boss.reopenings(card.id!)).toHaveLength(1);
      await expect(
        boss.reopen(card.id!, { operationId: 'r2', reason: 'again' }),
      ).rejects.toThrow('submitted or confirmed');
      await expect(
        service.adjust(card.id!, {
          operationId: 'a2',
          regularSeconds: 1,
          overtimeSeconds: 0,
          reason: 'x',
        }),
      ).rejects.toThrow('confirmed');
      // a new source appears; the re-roll reflects it, then confirm again
      await entry(3600, {
        startedAt: at(14),
        endedAt: at(15),
        approvedAt: at(15),
      });
      const rerolled = await boss.rollup(at(12));
      expect(rerolled.id).toBe(card.id);
      expect(rerolled.totalSeconds).toBe(10800);
      expect((await boss.confirm(card.id!)).status).toBe('confirmed');
      await boss.reopen(card.id!, { operationId: 'r2', reason: 'again' });
      expect(await boss.reopenings(card.id!)).toHaveLength(2);
    });
    it('reopens a submitted card and records its prior status', async () => {
      await entry();
      const card = await service.rollup(at(12));
      await service.submit(card.id!);
      const reopened = await service.reopen(card.id!, {
        operationId: 'r',
        reason: 'wrong job',
      });
      expect(reopened.status).toBe('open');
      expect(reopened.submittedAt).toBeNull();
      const [row] = await service.reopenings(card.id!);
      expect(row.fromStatus).toBe('submitted');
      await expect(
        service.reopen(card.id!, { operationId: 'x', reason: 'open' }),
      ).rejects.toThrow('submitted or confirmed');
    });
    it('keeps the reopening ledger append-only and service-only', async () => {
      await entry();
      const card = await service.rollup(at(12));
      await service.confirm(card.id!);
      await service.reopen(card.id!, { operationId: 'r', reason: 'fix' });
      const [row] = await service.reopenings(card.id!);
      await expect(row.save()).rejects.toThrow();
      await expect(row.delete()).rejects.toThrow('cannot be deleted');
      await expect(
        new TimecardReopening({ db, tenantId: actor.tenantId }).save(),
      ).rejects.toThrow();
      const loaded = await service.get(card.id!);
      loaded.status = 'confirmed';
      await expect(loaded.save()).rejects.toThrow();
    });
    it('allows attendance corrections in a reopened period only', async () => {
      const attendance = new AttendanceService(db, actor);
      await attendance.punchIn(at(8));
      const punch = await attendance.punchOut(at(10));
      const fix = new AttendanceCorrectionService(
        db,
        { tenantId: actor.tenantId, profileId: actor.profileId },
        { guard: confirmedTimecardGuard },
      );
      const att = new PeriodRollupService(db, actor, resolver, {
        attendance: true,
      });
      const card = await att.rollup(at(12));
      expect(card.totalSeconds).toBe(7200);
      await att.submit(card.id!);
      await expect(
        fix.correctPunch({
          subjectProfileId: actor.profileId,
          punchId: punch.id!,
          endedAt: at(9),
          reason: 'submitted',
        }),
      ).rejects.toThrow('submitted timecard');
      await att.confirm(card.id!);
      await expect(
        fix.correctPunch({
          subjectProfileId: actor.profileId,
          punchId: punch.id!,
          endedAt: at(9),
          reason: 'confirmed',
        }),
      ).rejects.toThrow('confirmed timecard');
      await att.reopen(card.id!, { operationId: 'r', reason: 'left early' });
      await fix.correctPunch({
        subjectProfileId: actor.profileId,
        punchId: punch.id!,
        endedAt: at(9),
        reason: 'left early',
      });
      const rerolled = await att.rollup(at(12));
      expect(rerolled.totalSeconds).toBe(3600);
      expect((await att.confirm(card.id!)).status).toBe('confirmed');
      expect((await att.totals(card.id!)).totalSeconds).toBe(3600);
    });
  });
}
