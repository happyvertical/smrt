import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseTimesheetJson } from '../models/json.js';
import { AttendancePunch } from './models.js';
import { isCorrectionWrite } from './write.js';

/** What a correction did. Punch kinds target the punch itself. */
export const ATTENDANCE_CORRECTION_KINDS = [
  'punch.corrected',
  'punch.added',
  'break.added',
  'break.changed',
  'break.removed',
  'segment.added',
  'segment.changed',
  'segment.removed',
] as const;
export type AttendanceCorrectionKind =
  (typeof ATTENDANCE_CORRECTION_KINDS)[number];

const IMMUTABLE_COLUMNS = [
  'tenant_id',
  'subject_profile_id',
  'actor_profile_id',
  'kind',
  'punch_id',
  'target_id',
  'before_state',
  'after_state',
  'reason',
] as const;

/**
 * One append-only change to closed attendance: who changed whose time, why, and
 * the before/after values as JSON (`null` for an addition's before or a
 * removal's after). Written only by `AttendanceCorrectionService`, in the same
 * transaction as the change. After insert only the acknowledgement may be set,
 * once, by the subject; rows are never deleted.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'attendance_corrections',
  sensitive: true,
  indexes: [
    {
      name: 'attendance_corrections_punch_idx',
      columns: ['tenantId', 'punchId'],
    },
    {
      name: 'attendance_corrections_subject_idx',
      columns: ['tenantId', 'subjectProfileId'],
    },
  ],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class AttendanceCorrection extends SmrtObject {
  @tenantId() tenantId = '';
  /** Whose time was corrected. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  subjectProfileId = '';
  /** Who made the correction. */
  @crossPackageRef('@happyvertical/smrt-profiles:Profile')
  actorProfileId = '';
  @field({ type: 'text' }) kind: AttendanceCorrectionKind = 'punch.corrected';
  @foreignKey(AttendancePunch) punchId = '';
  /** The break or segment id for those kinds; the punch id for punch kinds. */
  targetId = '';
  @field({ type: 'text' }) beforeState = 'null';
  @field({ type: 'text' }) afterState = 'null';
  @field({ type: 'text' }) reason = '';
  acknowledgementRequired = false;
  acknowledgedAt: Date | null = null;
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { nullable: true })
  acknowledgedByProfileId: string | null = null;

  /** The values before the change, or null for an addition. */
  getBefore<T = Record<string, unknown>>(): T | null {
    return parseTimesheetJson<T | null>(this.beforeState, null);
  }
  /** The values after the change, or null for a removal. */
  getAfter<T = Record<string, unknown>>(): T | null {
    return parseTimesheetJson<T | null>(this.afterState, null);
  }

  override async save(options?: SmrtSaveOptions): Promise<this> {
    // Insert and acknowledgement are both service-only: a generic save() or
    // collection create() must not fabricate or countersign ledger history.
    if (!isCorrectionWrite(this))
      throw new Error(
        'Attendance corrections are writable only through AttendanceCorrectionService.',
      );
    if (
      !this.tenantId ||
      !this.subjectProfileId ||
      !this.actorProfileId ||
      !this.punchId ||
      !this.targetId ||
      !ATTENDANCE_CORRECTION_KINDS.includes(this.kind) ||
      typeof this.reason !== 'string' ||
      !this.reason.trim() ||
      typeof this.acknowledgementRequired !== 'boolean'
    )
      throw new Error('Invalid attendance correction.');
    for (const json of [this.beforeState, this.afterState]) JSON.parse(json);
    if (!!this.acknowledgedAt !== !!this.acknowledgedByProfileId)
      throw new Error('Acknowledgement needs both a time and a profile.');
    if (this.acknowledgedAt) {
      if (!this.acknowledgementRequired)
        throw new Error('This correction does not require acknowledgement.');
      if (this.acknowledgedByProfileId !== this.subjectProfileId)
        throw new Error('Only the subject can acknowledge a correction.');
    }
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (prior) {
      const row = this as unknown as Record<string, unknown>;
      const camel = (column: string) =>
        column.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      if (
        IMMUTABLE_COLUMNS.some(
          (column) => prior[column] !== row[camel(column)],
        ) ||
        Boolean(prior.acknowledgement_required) !==
          this.acknowledgementRequired ||
        (prior.acknowledged_at &&
          (new Date(prior.acknowledged_at as string).getTime() !==
            this.acknowledgedAt?.getTime() ||
            prior.acknowledged_by_profile_id !== this.acknowledgedByProfileId))
      )
        throw new Error(
          'Attendance corrections are append-only; only a first acknowledgement may change.',
        );
    }
    this.id ??= crypto.randomUUID();
    return super.save(options);
  }

  override async delete(): Promise<void> {
    throw new Error('Attendance correction history cannot be deleted.');
  }
}

/** The correction ledger. */
export class AttendanceCorrectionCollection extends SmrtCollection<AttendanceCorrection> {
  static readonly _itemClass = AttendanceCorrection;
}
