import {
  crossPackageRef,
  field,
  foreignKey,
  isEmbeddedDatabase,
  isPostgresDatabase,
  SmrtCollection,
  SmrtObject,
  smrt,
  withEmbeddedWriteTransaction,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseTimesheetJson } from '../models/json.js';
import { isAutoCloseWrite, isCorrectionWrite } from './write.js';

// Punch closes and break writes share one atomic parent boundary, including direct ORM saves.
async function saveWithPunchLock<T extends SmrtObject>(
  model: T,
  punchId: string | null | undefined,
  tenant: string,
  save: () => Promise<T>,
): Promise<T> {
  return withEmbeddedWriteTransaction(
    model.db,
    isEmbeddedDatabase(model.db),
    (db) =>
      model.withDatabase(db, async () => {
        if (punchId && isPostgresDatabase(db))
          await db.query(
            'SELECT id FROM attendance_punches WHERE id = $1 AND tenant_id = $2 FOR UPDATE',
            punchId,
            tenant,
          );
        return save();
      }),
    true,
  );
}

/** A tenant-scoped interval of attendance, independent of billable work. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'attendance_punches',
  indexes: [
    {
      name: 'attendance_punches_open_owner_key',
      columns: ['tenantId', 'profileId', 'openSlot'],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class AttendancePunch extends SmrtObject {
  @tenantId() tenantId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile') profileId = '';
  startedAt: Date = new Date();
  endedAt: Date | null = null;
  durationSeconds = 0;
  unpaidBreakSeconds = 0;
  reviewRequired = false;
  /** Why the scheduler closed this punch; empty unless `autoClose` did. Write-once. */
  autoCloseReason = '';
  recordedOffline = false;
  // Resolve the active table family, including smrt-support's same-named subtype.
  @foreignKey('ServiceTimeEntry', { nullable: true }) serviceTimeEntryId:
    | string
    | null = null;
  /** Unique while open; closed rows retain independent non-null slots on every dialect. */
  @field({ required: true }) openSlot = '';

  override async save(): Promise<this> {
    return saveWithPunchLock(this, this.id, this.tenantId, () =>
      this.saveConsistent(),
    );
  }

  private async saveConsistent(): Promise<this> {
    if (!this.tenantId || !this.profileId)
      throw new Error('Attendance requires tenantId and profileId.');
    if (
      !Number.isFinite(this.startedAt?.getTime()) ||
      (this.endedAt &&
        (!Number.isFinite(this.endedAt.getTime()) ||
          this.endedAt < this.startedAt))
    )
      throw new Error('Invalid attendance interval.');
    if (
      ![this.durationSeconds, this.unpaidBreakSeconds].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
    )
      throw new Error(
        'Attendance durations must be nonnegative safe integer seconds.',
      );
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    const corrected = isCorrectionWrite(this);
    if (
      typeof this.autoCloseReason !== 'string' ||
      this.autoCloseReason.length > 200
    )
      throw new Error(
        'autoCloseReason must be a string of at most 200 characters.',
      );
    if (
      this.autoCloseReason !== ((prior?.auto_close_reason as string) ?? '') &&
      (!isAutoCloseWrite(this) || (prior && prior.auto_close_reason))
    )
      throw new Error('autoCloseReason is written only by autoClose, once.');
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.profile_id !== this.profileId ||
        (!corrected &&
          new Date(prior.started_at as string).getTime() !==
            this.startedAt.getTime()))
    )
      throw new Error('Attendance ownership and start are immutable.');
    if (
      !corrected &&
      prior?.ended_at &&
      (new Date(prior.ended_at as string).getTime() !==
        this.endedAt?.getTime() ||
        Number(prior.duration_seconds) !== this.durationSeconds ||
        Number(prior.unpaid_break_seconds) !== this.unpaidBreakSeconds)
    )
      throw new Error('Closed attendance evidence is immutable.');
    if (this.id && this.endedAt) {
      const segments = await this.db.list('attendance_segments', {
        tenant_id: this.tenantId,
        punch_id: this.id,
      });
      if (
        segments.some(
          (item) =>
            !item.ended_at ||
            new Date(item.started_at as string).getTime() <
              this.startedAt.getTime() ||
            new Date(item.ended_at as string).getTime() >
              this.endedAt!.getTime(),
        )
      )
        throw new Error('Work segment must be inside its tenant-owned punch.');
      const breaks = await this.db.list('attendance_breaks', {
        tenant_id: this.tenantId,
        punch_id: this.id,
      });
      if (
        breaks.some(
          (item) =>
            !item.ended_at ||
            new Date(item.started_at as string).getTime() <
              this.startedAt.getTime() ||
            new Date(item.ended_at as string).getTime() >
              this.endedAt!.getTime(),
        )
      )
        throw new Error('Break must be inside its tenant-owned punch.');
    }
    this.id ??= crypto.randomUUID();
    this.openSlot = this.endedAt ? JSON.stringify(['closed', this.id]) : 'open';
    return super.save();
  }
}

/** A paid or unpaid break inside one attendance punch. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'attendance_breaks',
  indexes: [
    {
      name: 'attendance_breaks_open_punch_key',
      columns: ['tenantId', 'punchId', 'openSlot'],
      unique: true,
    },
  ],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class AttendanceBreak extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(AttendancePunch) punchId = '';
  startedAt: Date = new Date();
  endedAt: Date | null = null;
  paid = false;
  @field({ required: true }) openSlot = '';

  override async save(): Promise<this> {
    return saveWithPunchLock(this, this.punchId, this.tenantId, () =>
      this.saveConsistent(),
    );
  }

  private async saveConsistent(): Promise<this> {
    if (!this.tenantId || !this.punchId || typeof this.paid !== 'boolean')
      throw new Error('Invalid attendance break.');
    if (
      !Number.isFinite(this.startedAt?.getTime()) ||
      (this.endedAt &&
        (!Number.isFinite(this.endedAt.getTime()) ||
          this.endedAt < this.startedAt))
    )
      throw new Error('Invalid attendance break interval.');
    const parent = await this.db.get('attendance_punches', {
      id: this.punchId,
      tenant_id: this.tenantId,
    });
    if (
      !parent ||
      this.startedAt.getTime() <
        new Date(parent.started_at as string).getTime() ||
      (parent.ended_at &&
        (!this.endedAt ||
          this.endedAt.getTime() >
            new Date(parent.ended_at as string).getTime()))
    )
      throw new Error('Break must be inside its tenant-owned punch.');
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    const corrected = isCorrectionWrite(this);
    if (!prior && parent.ended_at && !corrected)
      throw new Error(
        'A closed punch changes only through AttendanceCorrectionService.',
      );
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.punch_id !== this.punchId ||
        (!corrected &&
          (new Date(prior.started_at as string).getTime() !==
            this.startedAt.getTime() ||
            Boolean(prior.paid) !== this.paid)))
    )
      throw new Error('Break ownership, start and pay policy are immutable.');
    if (
      !corrected &&
      prior?.ended_at &&
      new Date(prior.ended_at as string).getTime() !== this.endedAt?.getTime()
    )
      throw new Error('Closed breaks are immutable.');
    const brStart = this.startedAt.getTime();
    const brEnd = this.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    if (
      (
        await this.db.list('attendance_segments', {
          tenant_id: this.tenantId,
          punch_id: this.punchId,
        })
      ).some(
        (row) =>
          brStart <
            (row.ended_at
              ? new Date(row.ended_at as string).getTime()
              : Number.POSITIVE_INFINITY) &&
          brEnd > new Date(row.started_at as string).getTime(),
      )
    )
      throw new Error('Break must not overlap a work segment.');
    this.id ??= crypto.randomUUID();
    this.openSlot = this.endedAt ? JSON.stringify(['closed', this.id]) : 'open';
    return super.save();
  }

  override async delete(): Promise<void> {
    // Judge the persisted row, not the mutable instance, and do it under the
    // parent punch lock so a concurrent punchOut cannot close the row between
    // the check and the delete.
    await saveWithPunchLock(this, this.punchId, this.tenantId, async () => {
      const prior = this.id
        ? await this.db.get(this.tableName, { id: this.id })
        : null;
      if ((this.endedAt || prior?.ended_at) && !isCorrectionWrite(this))
        throw new Error(
          'Closed breaks are immutable; remove one through AttendanceCorrectionService.',
        );
      await super.delete();
      return this;
    });
  }
}

const SEGMENT_CLOSE_REASONS = ['stop', 'switch', 'break', 'punchOut'] as const;
/** Why a work segment ended; `''` while it is open. */
export type AttendanceSegmentCloseReason =
  | (typeof SEGMENT_CLOSE_REASONS)[number]
  | '';

/**
 * A running unit of work inside one attendance punch: a work reference plus an
 * optional second (task) reference as queryable columns, so job costing can
 * index and join them. At most one segment is open per punch (`openSlot`). A
 * segment never spans a break; `startBreak` and `punchOut` close it. Segments
 * are attendance evidence and are not themselves service time entries.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'attendance_segments',
  indexes: [
    {
      name: 'attendance_segments_open_punch_key',
      columns: ['tenantId', 'punchId', 'openSlot'],
      unique: true,
    },
    {
      name: 'attendance_segments_work_idx',
      columns: ['tenantId', 'workRefType', 'workRefId'],
    },
    {
      name: 'attendance_segments_task_idx',
      columns: ['tenantId', 'taskRefType', 'taskRefId'],
    },
  ],
  api: { include: ['list', 'get'] },
  cli: { include: ['list', 'get'] },
  mcp: { include: ['list', 'get'] },
})
export class AttendanceSegment extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey(AttendancePunch) punchId = '';
  /** Qualified class name of the work context (for example a work order). */
  workRefType = '';
  workRefId = '';
  /** Optional second reference (for example an operation); both or neither. */
  taskRefType = '';
  taskRefId = '';
  /** Optional short consumer lane label. */
  kind = '';
  description = '';
  startedAt: Date = new Date();
  endedAt: Date | null = null;
  /** Elapsed whole seconds, set when the segment closes. */
  durationSeconds = 0;
  /** `stop`, `switch`, `break` or `punchOut` once closed; `''` while open. */
  closedReason: AttendanceSegmentCloseReason = '';
  /** Set when a replay time policy asked for review of this segment's boundary. */
  reviewRequired = false;
  @field({ required: true }) openSlot = '';

  override async save(): Promise<this> {
    return saveWithPunchLock(this, this.punchId, this.tenantId, () =>
      this.saveConsistent(),
    );
  }

  private async saveConsistent(): Promise<this> {
    if (
      !this.tenantId ||
      !this.punchId ||
      !this.workRefType ||
      !this.workRefId ||
      !!this.taskRefType !== !!this.taskRefId
    )
      throw new Error('Invalid attendance work segment.');
    if (
      !Number.isFinite(this.startedAt?.getTime()) ||
      (this.endedAt &&
        (!Number.isFinite(this.endedAt.getTime()) ||
          this.endedAt < this.startedAt))
    )
      throw new Error('Invalid attendance segment interval.');
    if (!this.endedAt !== !this.closedReason)
      throw new Error(
        'A segment has a close reason exactly when it is closed.',
      );
    if (this.closedReason && !SEGMENT_CLOSE_REASONS.includes(this.closedReason))
      throw new Error('Invalid segment close reason.');
    const parent = await this.db.get('attendance_punches', {
      id: this.punchId,
      tenant_id: this.tenantId,
    });
    if (
      !parent ||
      this.startedAt.getTime() <
        new Date(parent.started_at as string).getTime() ||
      (parent.ended_at &&
        (!this.endedAt ||
          this.endedAt.getTime() >
            new Date(parent.ended_at as string).getTime()))
    )
      throw new Error('Segment must be inside its tenant-owned punch.');
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    const corrected = isCorrectionWrite(this);
    if (!prior && parent.ended_at && !corrected)
      throw new Error(
        'A closed punch changes only through AttendanceCorrectionService.',
      );
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.punch_id !== this.punchId ||
        (!corrected &&
          (prior.work_ref_type !== this.workRefType ||
            prior.work_ref_id !== this.workRefId ||
            prior.task_ref_type !== this.taskRefType ||
            prior.task_ref_id !== this.taskRefId ||
            prior.kind !== this.kind ||
            prior.description !== this.description ||
            new Date(prior.started_at as string).getTime() !==
              this.startedAt.getTime())))
    )
      throw new Error('Segment ownership, references and start are immutable.');
    if (
      !corrected &&
      prior?.ended_at &&
      (new Date(prior.ended_at as string).getTime() !==
        this.endedAt?.getTime() ||
        prior.closed_reason !== this.closedReason)
    )
      throw new Error('Closed segments are immutable.');
    const start = this.startedAt.getTime();
    const end = this.endedAt?.getTime() ?? Number.POSITIVE_INFINITY;
    const overlaps = (row: Record<string, unknown>) =>
      start <
        (row.ended_at
          ? new Date(row.ended_at as string).getTime()
          : Number.POSITIVE_INFINITY) &&
      end > new Date(row.started_at as string).getTime();
    const where = { tenant_id: this.tenantId, punch_id: this.punchId };
    if ((await this.db.list('attendance_breaks', where)).some(overlaps))
      throw new Error('Segment must not overlap a break.');
    if (
      (await this.db.list(this.tableName, where)).some(
        (row) => row.id !== this.id && overlaps(row),
      )
    )
      throw new Error('Segments must not overlap.');
    this.durationSeconds = this.endedAt ? Math.round((end - start) / 1000) : 0;
    this.id ??= crypto.randomUUID();
    this.openSlot = this.endedAt ? JSON.stringify(['closed', this.id]) : 'open';
    return super.save();
  }

  override async delete(): Promise<void> {
    // Judge the persisted row, not the mutable instance, and do it under the
    // parent punch lock so a concurrent punchOut cannot close the row between
    // the check and the delete.
    await saveWithPunchLock(this, this.punchId, this.tenantId, async () => {
      const prior = this.id
        ? await this.db.get(this.tableName, { id: this.id })
        : null;
      if ((this.endedAt || prior?.ended_at) && !isCorrectionWrite(this))
        throw new Error(
          'Closed segments are immutable; remove one through AttendanceCorrectionService.',
        );
      await super.delete();
      return this;
    });
  }
}

/** Durable success or conflict; conflicts do not mutate attendance. */
export interface AttendanceReplayOutcome {
  clientId: string;
  punchId?: string;
  /** Work segment a replayed work action started, switched to, stopped or resumed. */
  segmentId?: string;
  /** Effective time stored when a `resolveAt` policy changed it (ISO 8601). */
  resolvedAt?: string;
  /** Refusal message (with `code`); present exactly when the tap was refused. */
  error?: string;
  /** Typed refusal reason; see `AttendanceRefusalCode`. */
  code?: string;
}

function validReplayOutcome(value: unknown): value is AttendanceReplayOutcome {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  return (
    typeof result.clientId === 'string' &&
    result.clientId.length > 0 &&
    (result.code === undefined ||
      (typeof result.code === 'string' &&
        result.code.length > 0 &&
        result.error !== undefined)) &&
    (result.segmentId === undefined || typeof result.segmentId === 'string') &&
    (result.resolvedAt === undefined ||
      typeof result.resolvedAt === 'string') &&
    ((typeof result.punchId === 'string' &&
      result.punchId.length > 0 &&
      result.error === undefined) ||
      (typeof result.error === 'string' &&
        result.error.length > 0 &&
        result.punchId === undefined))
  );
}

/** Durable offline-tap outcome; never exposed through generated operations. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'attendance_replays',
  sensitive: true,
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class AttendanceReplay extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ required: true, unique: true }) replayKey = '';
  @field({ type: 'text' }) content = '';
  @field({ type: 'text' }) outcome = '{}';

  /** Read a durable receipt, failing closed rather than re-executing a corrupt tap. */
  getOutcome(): AttendanceReplayOutcome {
    const value = parseTimesheetJson<unknown>(this.outcome, null);
    if (!validReplayOutcome(value))
      throw new Error('Invalid stored attendance replay outcome.');
    return value;
  }

  /** Store the JSON representation of a validated success or refusal. */
  setOutcome(value: AttendanceReplayOutcome): void {
    if (!validReplayOutcome(value))
      throw new Error('Invalid attendance replay outcome.');
    this.outcome = JSON.stringify(value);
  }

  override async save(): Promise<this> {
    this.getOutcome();
    return super.save();
  }
}

/** Punches for attendance and period rollup. */
export class AttendancePunchCollection extends SmrtCollection<AttendancePunch> {
  static readonly _itemClass = AttendancePunch;
}
/** Break intervals for net duration and period clipping. */
export class AttendanceBreakCollection extends SmrtCollection<AttendanceBreak> {
  static readonly _itemClass = AttendanceBreak;
}
/** Work segments for job costing and attendance review. */
export class AttendanceSegmentCollection extends SmrtCollection<AttendanceSegment> {
  static readonly _itemClass = AttendanceSegment;
}
/** Internal durable replay ledger. */
export class AttendanceReplayCollection extends SmrtCollection<AttendanceReplay> {
  static readonly _itemClass = AttendanceReplay;
}
