import { isPostgresDatabase } from '@happyvertical/smrt-core';
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

/**
 * Where a punch was captured: a consumer-owned type (for example a class name
 * such as a station or tablet) and that device's id. Both or neither.
 */
export interface AttendanceDeviceRef {
  type: string;
  id: string;
}

/** Optional provenance recorded when a punch opens. */
export interface AttendancePunchOptions {
  /** Short consumer-owned label such as `device`, `web`, `import`, `correction`. */
  source?: string;
  /** The device that captured the punch. */
  device?: AttendanceDeviceRef;
}

/** Optional detail recorded when a break starts. */
export interface AttendanceBreakOptions {
  /** Short consumer-owned label such as `meal` or `rest`. */
  kind?: string;
}

const MAX_LABEL = 64;

/** Validate an optional short label (`source`, `kind`, device type); returns the stored form. */
export function attendanceLabel(value: unknown, name: string): string {
  if (value === undefined || value === null) return '';
  if (
    typeof value !== 'string' ||
    value !== value.trim() ||
    value.length > MAX_LABEL
  )
    throw new AttendanceConflict(
      `${name} must be a trimmed string of at most ${MAX_LABEL} characters.`,
      'invalid',
    );
  return value;
}

/** Validate punch provenance; returns the stored column values. */
export function attendanceProvenance(options?: AttendancePunchOptions): {
  source: string;
  deviceRefType: string;
  deviceRefId: string;
} {
  const source = attendanceLabel(options?.source, 'source');
  const device = options?.device;
  if (device !== undefined && (!device || typeof device !== 'object'))
    throw new AttendanceConflict('device must be { type, id }.', 'invalid');
  const deviceRefType = attendanceLabel(device?.type, 'device.type');
  const deviceRefId = device?.id ?? '';
  if (typeof deviceRefId !== 'string' || !!deviceRefType !== !!deviceRefId)
    throw new AttendanceConflict(
      'device.type and device.id must be provided together.',
      'invalid',
    );
  return { source, deviceRefType, deviceRefId };
}

/** Expected state conflict, distinct from retryable database failures. */
export class AttendanceConflict extends Error {
  /**
   * Stable machine-readable reason (see {@link AttendanceRefusalCode}); stored
   * on a refused replay outcome so a device screen can say why.
   */
  readonly code: AttendanceRefusalCode;
  constructor(message: string, code: AttendanceRefusalCode = 'conflict') {
    super(message);
    this.code = code;
  }
}

/**
 * Built-in refusal codes. Consumers may store any other string through the
 * `refusalCode` replay hook.
 */
export type AttendanceRefusalCode =
  | 'conflict'
  | 'invalid'
  | 'predates_committed'
  | 'punch_open'
  | 'no_open_punch'
  | 'break_open'
  | 'no_open_break'
  | 'during_break'
  | 'work_open'
  | 'no_open_work'
  | 'no_resumable_work'
  | (string & {});

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

/** Canonicalize a tenant/profile id: PostgreSQL requires UUIDs, other adapters take it verbatim. */
export function attendanceIdentity(
  db: DatabaseInterface,
  value: string,
): string {
  if (!isPostgresDatabase(db)) return value;
  const hex = value.replace(/[{}-]/g, '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex))
    throw new Error('PostgreSQL attendance identities must be UUIDs.');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
