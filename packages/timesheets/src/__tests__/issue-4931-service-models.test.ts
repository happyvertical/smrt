import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { snapshotObjectRegistryState } from '../../../core/src/test-utils.js';
import { AttendanceCorrection } from '../attendance/correction-models.js';
import { AttendanceCorrectionService } from '../attendance/correction-service.js';
import { AttendanceBreak, AttendanceSegment } from '../attendance/models.js';
import { AttendanceService } from '../attendance/service.js';
import {
  PeriodTimecard,
  TimecardAdjustment,
  TimecardReopening,
} from '../rollup/models.js';
import { PeriodRollupService } from '../rollup/service.js';

const at = (hour: number) => new Date(Date.UTC(2026, 9, 1, hour));
const work = {
  workRefType: '@fixture/work:WorkPackage',
  workRefId: 'work-1',
  description: 'Framing',
};

for (const replaced of [false, true]) {
  describe(`service models, app replacement=${replaced}`, () => {
    let restore: () => void;
    let db: DatabaseInterface;
    let expected = {
      AttendanceBreak,
      AttendanceSegment,
      AttendanceCorrection,
      PeriodTimecard,
      TimecardAdjustment,
      TimecardReopening,
    };
    const actor = {
      tenantId: crypto.randomUUID(),
      profileId: crypto.randomUUID(),
    };
    const request = {
      subjectProfileId: actor.profileId,
      reason: 'reviewed correction',
    };

    beforeAll(async () => {
      restore = snapshotObjectRegistryState();
      // Bootstrap the original package schema before registering the app.
      db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
      if (replaced) expected = await import('./issue-4931-app.fixture.js');
    });
    afterAll(async () => {
      await db?.close?.();
      restore();
    });
    beforeEach(() => {
      actor.tenantId = crypto.randomUUID();
      actor.profileId = crypto.randomUUID();
      request.subjectProfileId = actor.profileId;
    });
    afterEach(() => vi.restoreAllMocks());

    it('saveBreak and saveSegment construct effective children and correction ledger rows on the transaction', async () => {
      const attendance = new AttendanceService(db, actor);
      const punch = await attendance.punchIn(at(8));
      let executor: DatabaseInterface | undefined;
      const corrections = new AttendanceCorrectionService(db, actor, {
        guard: async (tx) => {
          executor = tx.db;
          return null;
        },
      });
      const breaks = vi.spyOn(AttendanceBreak.prototype, 'save');
      const segments = vi.spyOn(AttendanceSegment.prototype, 'save');
      const ledger = vi.spyOn(AttendanceCorrection.prototype, 'save');
      const addedBreak = await corrections.saveBreak({
        ...request,
        punchId: punch.id!,
        startedAt: at(10),
        endedAt: at(11),
      });
      expect(breaks.mock.contexts).toHaveLength(1);
      expect(breaks.mock.contexts[0].constructor).toBe(
        expected.AttendanceBreak,
      );
      expect(breaks.mock.contexts[0].db).toBe(executor);
      expect(addedBreak.constructor).toBe(expected.AttendanceCorrection);
      const addedSegment = await corrections.saveSegment({
        ...request,
        punchId: punch.id!,
        startedAt: at(8),
        endedAt: at(10),
        work,
      });
      expect(segments.mock.contexts).toHaveLength(1);
      expect(segments.mock.contexts[0].constructor).toBe(
        expected.AttendanceSegment,
      );
      expect(segments.mock.contexts[0].db).toBe(executor);
      expect(addedSegment.constructor).toBe(expected.AttendanceCorrection);
      expect(ledger.mock.contexts).toHaveLength(2);
      for (const row of ledger.mock.contexts)
        expect(row.constructor).toBe(expected.AttendanceCorrection);
    });

    it('addPunch(open) constructs effective break/segment rows and a correction ledger row', async () => {
      const corrections = new AttendanceCorrectionService(db, actor);
      const breaks = vi.spyOn(AttendanceBreak.prototype, 'save');
      const segments = vi.spyOn(AttendanceSegment.prototype, 'save');
      const row = await corrections.addPunch({
        ...request,
        open: true,
        startedAt: at(8),
        breaks: [{ startedAt: at(12), endedAt: at(13) }],
        segments: [{ startedAt: at(8), endedAt: at(12), work }],
      });
      expect(row.constructor).toBe(expected.AttendanceCorrection);
      expect(breaks.mock.contexts).toHaveLength(1);
      expect(breaks.mock.contexts[0].constructor).toBe(
        expected.AttendanceBreak,
      );
      expect(segments.mock.contexts).toHaveLength(1);
      expect(segments.mock.contexts[0].constructor).toBe(
        expected.AttendanceSegment,
      );
    });

    it('rollup, adjust and reopen construct the effective card and ledger classes', async () => {
      const service = new PeriodRollupService(db, actor, {
        periodFor: async () => ({
          startsAt: at(0),
          endsAt: at(24),
          timezone: 'UTC',
          version: 'v1',
          rules: {},
        }),
        classify: async () => ({ regularSeconds: 0, overtimeSeconds: 0 }),
      });
      const cards = vi.spyOn(PeriodTimecard.prototype, 'save');
      const adjustments = vi.spyOn(TimecardAdjustment.prototype, 'save');
      const reopenings = vi.spyOn(TimecardReopening.prototype, 'save');
      const card = await service.rollup(at(12));
      expect(card.constructor).toBe(expected.PeriodTimecard);
      expect(cards.mock.contexts[0].constructor).toBe(expected.PeriodTimecard);
      await service.confirm(card.id!);
      const adjustment = await service.adjust(card.id!, {
        operationId: 'adjust',
        regularSeconds: 60,
        overtimeSeconds: 0,
        reason: 'reviewed',
      });
      expect(adjustment.constructor).toBe(expected.TimecardAdjustment);
      expect(adjustments.mock.contexts).toHaveLength(1);
      expect(adjustments.mock.contexts[0].constructor).toBe(
        expected.TimecardAdjustment,
      );
      await service.reopen(card.id!, {
        operationId: 'reopen',
        reason: 'reviewed',
      });
      expect(reopenings.mock.contexts).toHaveLength(1);
      expect(reopenings.mock.contexts[0].constructor).toBe(
        expected.TimecardReopening,
      );
    });
  });
}
