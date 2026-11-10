import type { AttendanceCorrectionGuard } from '../attendance/correction-service.js';
import { PeriodTimecardCollection } from './models.js';

/**
 * An `AttendanceCorrectionService` guard that refuses to change attendance
 * inside a period a `PeriodTimecard` has confirmed. A confirmed card never
 * changes, so correcting its sources would leave card and attendance
 * disagreeing; reopen the card first (`PeriodRollupService.reopen`), correct,
 * then roll up again. A submitted card is frozen too. A reopened card is `open`
 * again, so corrections inside it are allowed.
 * Needs the `period_timecards` table, which is why it is opt-in.
 */
export const confirmedTimecardGuard: AttendanceCorrectionGuard = async (
  tx,
  subject,
  intervals,
) => {
  const cards = await PeriodTimecardCollection.create({ db: tx.db });
  const locked = (
    await cards.list({
      where: { tenantId: subject.tenantId, profileId: subject.profileId },
    })
  ).filter(
    (card) => card.status === 'confirmed' || card.status === 'submitted',
  );
  const hit = locked.find((card) =>
    intervals.some(
      (i) =>
        i.startsAt.getTime() < card.endsAt.getTime() &&
        card.startsAt.getTime() < i.endsAt.getTime(),
    ),
  );
  return hit
    ? `Attendance overlaps ${hit.status} timecard ${hit.id}; reopen it before correcting.`
    : null;
};
