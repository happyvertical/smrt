import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { parseInterestTheme } from './learner-interest-theme.js';
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
export type LessonProgressTransitionKind = 'put-back' | 'start' | 'complete';

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
      !['put-back', 'start', 'complete'].includes(this.kind)
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

/**
 * Append-only record that a learner (or an authorized guardian acting through
 * the same path) completed one lesson via `LearnerService.completeOwnLesson`:
 * the actor, the host policy setting relied on and the optional evidence
 * submission. At most one row exists per progress row, which is also how a
 * replay is recognised as already done through this path.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'lesson_completion_records',
  conflictColumns: ['tenant_id', 'progress_id'],
  ...closed,
})
export class LessonCompletionRecord extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('LessonProgress', { required: true }) progressId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  /** Progress status before completion. */
  fromStatus: LessonProgressStatus = 'not_started';
  actorUserId = '';
  /** Host setting value that let this actor complete the lesson. */
  policyBasis = '';
  /** Optional evidence `Submission` of this learner and lesson. */
  @field({ type: 'text', nullable: true }) submissionId: string | null = null;
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
      throw new Error('Completion history requires its tenant progress');
    if (
      this.submissionId !== null &&
      !(await this.db.get('submissions', {
        id: this.submissionId,
        tenant_id: this.tenantId,
        learner_id: this.learnerId,
        lesson_id: this.lessonId,
        progress_id: this.progressId,
      }))
    )
      throw new Error('Completion evidence must belong to the same progress');
    if (!PROGRESS_STATUSES.includes(this.fromStatus))
      throw new Error('Invalid completion record');
    requireText(this.actorUserId, 'Completion history requires an actor');
    requireText(this.policyBasis, 'Completion history requires a policy basis');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class LessonCompletionRecordCollection extends SmrtCollection<LessonCompletionRecord> {
  static readonly _itemClass = LessonCompletionRecord;
}

/**
 * Append-only audit of one enrollment pace change made through
 * `LearnerService.setEnrollmentPace`: the actor, the host policy setting
 * relied on and the previous and new lessons per week (`0` means no pace).
 */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'enrollment_pace_changes', ...closed })
export class EnrollmentPaceChange extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  previousLessonsPerWeek = 0;
  newLessonsPerWeek = 0;
  actorUserId = '';
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
      throw new Error('Pace history requires its tenant enrollment');
    for (const value of [this.previousLessonsPerWeek, this.newLessonsPerWeek])
      if (!Number.isSafeInteger(value) || value < 0 || value > 14)
        throw new Error('Invalid enrollment pace change');
    if (this.previousLessonsPerWeek === this.newLessonsPerWeek)
      throw new Error('Invalid enrollment pace change');
    requireText(this.actorUserId, 'Pace history requires an actor');
    requireText(this.policyBasis, 'Pace history requires a policy basis');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class EnrollmentPaceChangeCollection extends SmrtCollection<EnrollmentPaceChange> {
  static readonly _itemClass = EnrollmentPaceChange;
}

/**
 * Append-only audit of one learner interest theme change made through
 * `LearnerService.setInterestTheme`: the actor, the host policy setting relied
 * on and the previous and new theme (empty label = none). It stores only the
 * learner-safe label and key.
 */
@TenantScoped({ mode: 'required' })
@smrt({ tableName: 'learner_interest_theme_changes', ...closed })
export class LearnerInterestThemeChange extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  previousLabel = '';
  previousKey = '';
  newLabel = '';
  newKey = '';
  actorUserId = '';
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
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Interest theme history requires its tenant learner');
    for (const [label, key] of [
      [this.previousLabel, this.previousKey],
      [this.newLabel, this.newKey],
    ]) {
      if (!label && !key) continue;
      const theme = parseInterestTheme({ label, key });
      if (!theme || theme.label !== label || theme.key !== key)
        throw new Error('Invalid interest theme change');
    }
    if (
      this.previousLabel === this.newLabel &&
      this.previousKey === this.newKey
    )
      throw new Error('Invalid interest theme change');
    requireText(this.actorUserId, 'Theme history requires an actor');
    requireText(this.policyBasis, 'Theme history requires a policy basis');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class LearnerInterestThemeChangeCollection extends SmrtCollection<LearnerInterestThemeChange> {
  static readonly _itemClass = LearnerInterestThemeChange;
}
