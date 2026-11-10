import {
  AttendanceConflict,
  type AttendanceContext,
  type AttendanceWork,
  validateAttendanceWork,
} from './context.js';
import type {
  AttendancePunch,
  AttendanceSegment,
  AttendanceSegmentCloseReason,
} from './models.js';

/*
 * Segment transitions on an already-open punch, run on the caller's transaction
 * context. `AttendanceService` composes them; corrections and replay call them
 * inside `AttendanceService.withTransaction`. Callers own the actor lock and
 * punch lookup; these helpers own break and one-open-segment rules.
 */

/** The open segment of a punch, or null. */
export async function openSegment(
  tx: AttendanceContext,
  punch: AttendancePunch,
): Promise<AttendanceSegment | null> {
  const [segment] = await tx.segments.list({
    where: { tenantId: punch.tenantId, punchId: punch.id, endedAt: null },
    limit: 1,
  });
  return segment ?? null;
}

/** All segments of a punch, oldest first. */
export async function listSegments(
  tx: AttendanceContext,
  punch: AttendancePunch,
): Promise<AttendanceSegment[]> {
  return tx.segments.list({
    where: { tenantId: punch.tenantId, punchId: punch.id },
    orderBy: 'started_at ASC',
  });
}

/** Close the punch's open segment, if any. Returns it, or null when none was open. */
export async function closeOpenSegment(
  tx: AttendanceContext,
  punch: AttendancePunch,
  at: Date,
  reason: Exclude<AttendanceSegmentCloseReason, ''>,
): Promise<AttendanceSegment | null> {
  const segment = await openSegment(tx, punch);
  if (!segment) return null;
  if (at < segment.startedAt)
    throw new AttendanceConflict('Segment cannot end before it starts.');
  segment.endedAt = at;
  segment.closedReason = reason;
  await segment.save();
  return segment;
}

/** Open a segment; refuses while a break or another segment is open. */
export async function beginSegment(
  tx: AttendanceContext,
  punch: AttendancePunch,
  at: Date,
  work: AttendanceWork,
): Promise<AttendanceSegment> {
  validateAttendanceWork(work);
  if (punch.endedAt) throw new AttendanceConflict('Punch is closed.');
  const breaks = await tx.breaks.list({
    where: { tenantId: punch.tenantId, punchId: punch.id },
  });
  if (breaks.some((b) => !b.endedAt))
    throw new AttendanceConflict(
      'Cannot work during an open break.',
      'during_break',
    );
  if (await openSegment(tx, punch))
    throw new AttendanceConflict(
      'A work segment is already open.',
      'work_open',
    );
  return tx.segments.create({
    tenantId: punch.tenantId,
    punchId: punch.id ?? undefined,
    profileId: punch.profileId,
    workRefType: work.workRefType,
    workRefId: work.workRefId,
    taskRefType: work.taskRefType ?? '',
    taskRefId: work.taskRefId ?? '',
    kind: work.kind ?? '',
    description: work.description,
    startedAt: at,
    _insertOnly: true,
  });
}

/** Atomically close the open segment and open the next at the same instant. */
export async function replaceSegment(
  tx: AttendanceContext,
  punch: AttendancePunch,
  at: Date,
  work: AttendanceWork,
): Promise<AttendanceSegment> {
  validateAttendanceWork(work);
  if (!(await closeOpenSegment(tx, punch, at, 'switch')))
    throw new AttendanceConflict(
      'No open work segment to switch.',
      'no_open_work',
    );
  return beginSegment(tx, punch, at, work);
}

/** Close the open segment (`stop`); refuses when none is open. */
export async function endSegment(
  tx: AttendanceContext,
  punch: AttendancePunch,
  at: Date,
): Promise<AttendanceSegment> {
  const segment = await closeOpenSegment(tx, punch, at, 'stop');
  if (!segment)
    throw new AttendanceConflict('No open work segment.', 'no_open_work');
  return segment;
}

/**
 * Reopen the work a break interrupted: a new segment with the same references
 * as the latest segment, which must have been closed by `startBreak`.
 */
export async function continueSegment(
  tx: AttendanceContext,
  punch: AttendancePunch,
  at: Date,
): Promise<AttendanceSegment> {
  const all = await listSegments(tx, punch);
  const last = all[all.length - 1];
  // Only the latest break may be the one that interrupted the work: a later,
  // idle break (taken after the work was left unresumed) must not reopen it.
  const breaks = await tx.breaks.list({
    where: { tenantId: punch.tenantId, punchId: punch.id },
    orderBy: 'started_at DESC',
    limit: 1,
  });
  if (
    last?.closedReason !== 'break' ||
    !last.endedAt ||
    last.endedAt.getTime() !== breaks[0]?.startedAt.getTime()
  )
    throw new AttendanceConflict(
      'No work interrupted by a break to resume.',
      'no_resumable_work',
    );
  return beginSegment(tx, punch, at, last);
}
