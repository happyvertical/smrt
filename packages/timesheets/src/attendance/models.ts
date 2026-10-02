import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

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
  recordedOffline = false;
  // Resolve the active table family, including smrt-support's same-named subtype.
  @foreignKey('ServiceTimeEntry', { nullable: true }) serviceTimeEntryId:
    | string
    | null = null;
  /** Unique while open; closed rows retain independent non-null slots on every dialect. */
  @field({ required: true }) openSlot = '';

  override async save(): Promise<this> {
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
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.profile_id !== this.profileId ||
        new Date(prior.started_at as string).getTime() !==
          this.startedAt.getTime())
    )
      throw new Error('Attendance ownership and start are immutable.');
    if (
      prior?.ended_at &&
      (new Date(prior.ended_at as string).getTime() !==
        this.endedAt?.getTime() ||
        Number(prior.duration_seconds) !== this.durationSeconds ||
        Number(prior.unpaid_break_seconds) !== this.unpaidBreakSeconds)
    )
      throw new Error('Closed attendance evidence is immutable.');
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
    if (
      prior &&
      (prior.tenant_id !== this.tenantId ||
        prior.punch_id !== this.punchId ||
        new Date(prior.started_at as string).getTime() !==
          this.startedAt.getTime() ||
        Boolean(prior.paid) !== this.paid)
    )
      throw new Error('Break ownership, start and pay policy are immutable.');
    if (
      prior?.ended_at &&
      new Date(prior.ended_at as string).getTime() !== this.endedAt?.getTime()
    )
      throw new Error('Closed breaks are immutable.');
    this.id ??= crypto.randomUUID();
    this.openSlot = this.endedAt ? JSON.stringify(['closed', this.id]) : 'open';
    return super.save();
  }
}

/** Durable offline-tap outcome; never exposed through generated operations. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'attendance_replays',
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class AttendanceReplay extends SmrtObject {
  @tenantId() tenantId = '';
  @field({ required: true, unique: true }) replayKey = '';
  @field({ type: 'text' }) content = '';
  @field({ type: 'text' }) outcome = '{}';
}

/** Punches for attendance and period rollup. */
export class AttendancePunchCollection extends SmrtCollection<AttendancePunch> {
  static readonly _itemClass = AttendancePunch;
}
/** Break intervals for net duration and period clipping. */
export class AttendanceBreakCollection extends SmrtCollection<AttendanceBreak> {
  static readonly _itemClass = AttendanceBreak;
}
/** Internal durable replay ledger. */
export class AttendanceReplayCollection extends SmrtCollection<AttendanceReplay> {
  static readonly _itemClass = AttendanceReplay;
}
