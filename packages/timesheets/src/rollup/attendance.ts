import type { DatabaseInterface } from '@happyvertical/sql';
import {
  AttendanceBreakCollection,
  AttendancePunchCollection,
} from '../attendance/models.js';
import { clipSource, instant, integer } from './calculation.js';
import type { TimecardActor, TimecardPeriod, TimecardSource } from './types.js';

/** Optional attendance reader. Called on the rollup's transaction executor. */
export async function attendanceSources(
  db: DatabaseInterface,
  actor: TimecardActor,
  period: TimecardPeriod,
): Promise<{ sources: TimecardSource[]; linkedEntryIds: Set<string> }> {
  const punches = await AttendancePunchCollection.create({ db });
  const breaks = await AttendanceBreakCollection.create({ db });
  const sources: TimecardSource[] = [];
  const linkedEntryIds = new Set<string>();
  for (const punch of await punches.list({ where: { ...actor } })) {
    // A linked punch is authoritative even when pending review: never count its
    // evidence entry behind the review gate, or outside the punch's period.
    if (punch.serviceTimeEntryId) linkedEntryIds.add(punch.serviceTimeEntryId);
    if (!punch.endedAt || punch.reviewRequired) continue;
    const start = instant(punch.startedAt);
    const end = instant(punch.endedAt);
    if (end < start) throw new Error('Invalid attendance interval.');
    let cursor = start;
    let unpaidMs = 0;
    const spans: [number, number][] = [];
    for (const pause of await breaks.list({
      where: { tenantId: actor.tenantId, punchId: punch.id },
      orderBy: 'started_at ASC',
    })) {
      if (!pause.endedAt)
        throw new Error('Closed attendance has an open break.');
      const left = instant(pause.startedAt);
      const right = instant(pause.endedAt);
      if (left < cursor || right < left || right > end)
        throw new Error('Invalid or overlapping attendance breaks.');
      if (!pause.paid) {
        spans.push([cursor, left]);
        unpaidMs += right - left;
      } else {
        spans.push([cursor, right]);
      }
      cursor = right;
    }
    spans.push([cursor, end]);
    const net = Math.round((end - start - unpaidMs) / 1000);
    if (integer(punch.durationSeconds) !== net)
      throw new Error('Attendance duration does not match its breaks.');
    // Round elapsed paid prefixes once, preserving conservation across breaks.
    let paidMs = 0;
    for (const [left, right] of spans) {
      const seconds =
        Math.round((paidMs + right - left) / 1000) - Math.round(paidMs / 1000);
      paidMs += right - left;
      const source = clipSource(
        {
          kind: 'attendance',
          id: String(punch.id),
          startsAt: new Date(left).toISOString(),
          endsAt: new Date(right).toISOString(),
          seconds,
        },
        period,
      );
      if (source?.seconds) sources.push(source);
    }
  }
  return { sources, linkedEntryIds };
}
