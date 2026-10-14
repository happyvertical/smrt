import type { DatabaseInterface } from '@happyvertical/sql';
import type {
  AttendanceBreakCollection,
  AttendancePunchCollection,
  AttendanceReplayCollection,
  AttendanceSegmentCollection,
} from './models.js';

/** Resolve these identifiers from the authenticated session, never from tap input. */
export interface AttendanceActor {
  tenantId: string;
  profileId: string;
}
/**
 * Explicit work attribution for a closed punch's draft evidence entry or for a
 * running work segment. `taskRefType`/`taskRefId` (both or neither) name an
 * optional second reference such as an operation; `kind` is an optional short
 * consumer lane label.
 */
export interface AttendanceWork {
  workRefType: string;
  workRefId: string;
  description: string;
  taskRefType?: string;
  taskRefId?: string;
  kind?: string;
}

/** Expected state conflict, distinct from retryable database failures. */
export class AttendanceConflict extends Error {}

/**
 * Collections bound to one transaction executor. Handed to
 * `AttendanceService.withTransaction` callbacks and to the segment helpers so
 * corrections and replay can compose several mutations atomically.
 */
export type AttendanceContext = {
  db: DatabaseInterface;
  punches: AttendancePunchCollection;
  breaks: AttendanceBreakCollection;
  segments: AttendanceSegmentCollection;
  replays: AttendanceReplayCollection;
};

/** Validate a work reference; throws {@link AttendanceConflict}. */
export function validateAttendanceWork(work: AttendanceWork): void {
  if (
    !work ||
    typeof work.workRefType !== 'string' ||
    !work.workRefType ||
    typeof work.workRefId !== 'string' ||
    !work.workRefId ||
    typeof work.description !== 'string'
  )
    throw new AttendanceConflict(
      'A complete work reference and description are required.',
    );
  for (const key of ['taskRefType', 'taskRefId', 'kind'] as const)
    if (work[key] !== undefined && typeof work[key] !== 'string')
      throw new AttendanceConflict(`${key} must be a string.`);
  if (!!work.taskRefType !== !!work.taskRefId)
    throw new AttendanceConflict(
      'taskRefType and taskRefId must be provided together.',
    );
}
