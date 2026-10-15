import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

const closed = { api: false, mcp: false, cli: false } as const;

function applyOptions(target: object, options: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
  }
}

function requireEnum(value: string, allowed: readonly string[]): void {
  if (!allowed.includes(value)) throw new Error('Invalid education status');
}

async function immutableIdentity(
  object: SmrtObject & { tenantId: string },
  identity: Record<string, unknown>,
): Promise<void> {
  if (!object.tenantId?.trim()) throw new Error('Education requires a tenant');
  if (object.id && (await object.db.get(object.tableName, { id: object.id }))) {
    if (
      !(await object.db.get(object.tableName, {
        id: object.id,
        tenant_id: object.tenantId,
        ...identity,
      }))
    )
      throw new Error('Education record identity cannot change');
  }
}

/** A learner is a real user/profile identity with active family membership. */
@TenantScoped({ mode: 'required' })
@smrt({ ...closed })
export class Learner extends SmrtObject {
  @tenantId() tenantId = '';
  @crossPackageRef('@happyvertical/smrt-users:User', { required: true })
  userId = '';
  @crossPackageRef('@happyvertical/smrt-profiles:Profile', { required: true })
  profileId = '';
  displayName = '';
  birthDate: Date | null = null;
  level = 0;
  settings = '{}';

  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }

  getSettings(): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(this.settings);
      return parsed !== null &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }

  setSettings(value: Record<string, unknown>): void {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new Error('Learner settings must be an object');
    this.settings = JSON.stringify(value);
  }

  override async save(): Promise<this> {
    await immutableIdentity(this, {
      user_id: this.userId,
      profile_id: this.profileId,
    });
    if (
      !this.userId ||
      !this.profileId ||
      !(await this.db.get('users', {
        id: this.userId,
        profile_id: this.profileId,
      })) ||
      !(await this.db.get('profiles', {
        id: this.profileId,
        _meta_type: '@happyvertical/smrt-profiles:Person',
      })) ||
      !(await this.db.get('memberships', {
        user_id: this.userId,
        tenant_id: this.tenantId,
        status: 'active',
      }))
    )
      throw new Error(
        'Learner requires a linked user/profile and active tenant membership',
      );
    if (!Number.isSafeInteger(this.level) || this.level < 0)
      throw new Error('Learner level must be a nonnegative integer');
    return super.save();
  }
}

/** A distinct plan retains its own enrollment history. */
@TenantScoped({ mode: 'required' })
@smrt({ ...closed, tableName: 'curricula' })
export class Curriculum extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @field({ required: true }) title = '';
  startsOn: Date | null = null;
  endsOn: Date | null = null;
  status: 'planned' | 'active' | 'completed' | 'archived' = 'planned';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(): Promise<this> {
    await immutableIdentity(this, { learner_id: this.learnerId });
    requireEnum(this.status, ['planned', 'active', 'completed', 'archived']);
    if (
      !(await this.db.get('learners', {
        id: this.learnerId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Curriculum requires its tenant learner');
    return super.save();
  }
}

export type EnrollmentStatus =
  | 'planned'
  | 'active'
  | 'paused'
  | 'completed'
  | 'dropped';

/** One course in one curriculum; a new curriculum means a new enrollment. */
@TenantScoped({ mode: 'required' })
@smrt({
  ...closed,
  conflictColumns: ['tenant_id', 'curriculum_id', 'course_id'],
})
export class Enrollment extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Curriculum', { required: true }) curriculumId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  status: EnrollmentStatus = 'planned';
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  targetMinutesPerWeek = 0;
  sortOrder = 0;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(): Promise<this> {
    await immutableIdentity(this, {
      curriculum_id: this.curriculumId,
      learner_id: this.learnerId,
      course_id: this.courseId,
    });
    requireEnum(this.status, [
      'planned',
      'active',
      'paused',
      'completed',
      'dropped',
    ]);
    if (
      !(await this.db.get('curricula', {
        id: this.curriculumId,
        learner_id: this.learnerId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('Enrollment learner must match its tenant curriculum');
    if (
      !Number.isSafeInteger(this.targetMinutesPerWeek) ||
      this.targetMinutesPerWeek < 0
    )
      throw new Error('Target minutes must be a nonnegative integer');
    return super.save();
  }
}

export type LessonProgressStatus =
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'needs_review'
  | 'complete'
  | 'skipped';

/** Progress identity is enrollment + lesson, never learner + lesson. */
@TenantScoped({ mode: 'required' })
@smrt({
  ...closed,
  tableName: 'lesson_progress',
  conflictColumns: ['tenant_id', 'enrollment_id', 'lesson_id'],
})
export class LessonProgress extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  status: LessonProgressStatus = 'not_started';
  startedAt: Date | null = null;
  completedAt: Date | null = null;
  timeSpentSeconds = 0;
  attempts = 0;
  @field({ type: 'decimal', nullable: true }) bestScore: number | null = null;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyOptions(this, options);
  }
  override async save(): Promise<this> {
    await immutableIdentity(this, {
      enrollment_id: this.enrollmentId,
      learner_id: this.learnerId,
      lesson_id: this.lessonId,
    });
    requireEnum(this.status, [
      'not_started',
      'in_progress',
      'submitted',
      'needs_review',
      'complete',
      'skipped',
    ]);
    const enrollment = await this.db.get('enrollments', {
      id: this.enrollmentId,
      learner_id: this.learnerId,
      tenant_id: this.tenantId,
    });
    const lesson = await this.db.get('lessons', { id: this.lessonId });
    if (
      !enrollment ||
      !lesson ||
      !(await this.db.get('course_sections', {
        id: lesson.section_id,
        course_id: enrollment.course_id,
      }))
    )
      throw new Error(
        'Progress requires its enrollment learner and course lesson',
      );
    for (const value of [this.attempts, this.timeSpentSeconds])
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Progress counters must be nonnegative integers');
    if (
      this.bestScore !== null &&
      (!Number.isFinite(this.bestScore) ||
        this.bestScore < 0 ||
        this.bestScore > 1)
    )
      throw new Error('Score must be null or a number from zero to one');
    return super.save();
  }
}
