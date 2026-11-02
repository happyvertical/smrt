import {
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { EnrollmentStatus, LessonProgressStatus } from './learners.js';

const closed = { api: false, mcp: false, cli: false } as const;
const PROGRESS_STATUSES: readonly LessonProgressStatus[] = [
  'not_started',
  'in_progress',
  'submitted',
  'needs_review',
  'complete',
  'skipped',
];

function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
/** History rows are insert-only: any rewrite of an existing id fails. */
async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim()) throw new Error('Education requires a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error('Education learner history is immutable');
}
function noDelete(): never {
  throw new Error('Education learner history is immutable');
}
function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid education history timestamp');
}

/** Service operation that moved one lesson's progress status. */
export type LessonProgressTransitionKind = 'put-back' | 'start';

/**
 * Append-only status history for one `LessonProgress` row. The progress row
 * keeps one identity per enrollment and lesson, so earlier states live here.
 * Written by `LearnerService` in the same transaction as the status change.
 */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'lesson_progress_transitions', ...closed })
export class LessonProgressTransition extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LessonProgress', { required: true }) progressId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  fromStatus: LessonProgressStatus = 'not_started';
  toStatus: LessonProgressStatus = 'not_started';
  kind: LessonProgressTransitionKind = 'put-back';
  actorUserId = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    if (
      !(await this.db.get('lesson_progress', {
        id: this.progressId,
        tenant_id: this.tenantId,
        enrollment_id: this.enrollmentId,
        learner_id: this.learnerId,
        lesson_id: this.lessonId,
      }))
    )
      throw new Error('Progress history requires its tenant progress');
    if (
      !PROGRESS_STATUSES.includes(this.fromStatus) ||
      !PROGRESS_STATUSES.includes(this.toStatus) ||
      !['put-back', 'start'].includes(this.kind)
    )
      throw new Error('Invalid progress transition');
    requireText(this.actorUserId, 'Progress history requires an actor');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class LessonProgressTransitionCollection extends SmrtCollection<LessonProgressTransition> {
  static readonly _itemClass = LessonProgressTransition;
}

const ENROLLMENT_STATUSES: readonly EnrollmentStatus[] = [
  'planned',
  'active',
  'paused',
  'completed',
  'dropped',
];

/**
 * Append-only audit of one enrollment status change made through
 * `LearnerService.setEnrollmentStatus`: who changed it and the host policy
 * setting relied on, in the same transaction as the change.
 */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'enrollment_status_changes', ...closed })
export class EnrollmentStatusChange extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  fromStatus: EnrollmentStatus = 'planned';
  toStatus: EnrollmentStatus = 'planned';
  actorUserId = '';
  /** Host setting value that allowed this actor to change the status. */
  policyBasis = '';
  recordedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    if (
      !(await this.db.get('enrollments', {
        id: this.enrollmentId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
      }))
    )
      throw new Error('Enrollment history requires its tenant enrollment');
    if (
      !ENROLLMENT_STATUSES.includes(this.fromStatus) ||
      !ENROLLMENT_STATUSES.includes(this.toStatus) ||
      this.fromStatus === this.toStatus
    )
      throw new Error('Invalid enrollment status change');
    requireText(this.actorUserId, 'Enrollment history requires an actor');
    requireText(this.policyBasis, 'Enrollment history requires a policy basis');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class EnrollmentStatusChangeCollection extends SmrtCollection<EnrollmentStatusChange> {
  static readonly _itemClass = EnrollmentStatusChange;
}
