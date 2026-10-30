import {
  field,
  foreignKey,
  SmrtCollection,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { CourseLicenseKind } from './catalog.js';

const closed = { api: false, mcp: false, cli: false } as const;
const LICENSES = [
  'own-work',
  'open-license',
  'personal-use-copy',
  'licensed-for-sharing',
];
const PROVENANCES = ['supplied', 'generated', 'edited', 'extracted'];

function adopt(target: object, options: Record<string, unknown>) {
  for (const [key, value] of Object.entries(options))
    if (Object.hasOwn(target, key))
      (target as Record<string, unknown>)[key] = value;
}
function requireText(value: unknown, message: string, max = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(message);
}
function requireJson(value: string, shape: 'array' | 'object', what: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${what} must be JSON`);
  }
  if (
    shape === 'array'
      ? !Array.isArray(parsed)
      : !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
  )
    throw new Error(`${what} must be a JSON ${shape}`);
}
/** Append-only rows reject any rewrite of an existing id; replays are service-level. */
async function requireInsert(row: SmrtObject & { tenantId: string }) {
  if (!row.tenantId?.trim())
    throw new Error('Course authoring requires a tenant');
  if (row.id && (await row.db.get(row.tableName, { id: row.id })))
    throw new Error('Course authoring history is immutable');
}
async function requireOwned(
  row: SmrtObject & { tenantId: string },
  table: string,
  id: string,
  extra: Record<string, unknown> = {},
) {
  if (!(await row.db.get(table, { id, tenant_id: row.tenantId, ...extra })))
    throw new Error('Course authoring parent ownership mismatch');
}
function noDelete(): never {
  throw new Error(
    'Authored course history is immutable; erasure requires an owning retention operation',
  );
}
function validDate(value: Date) {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime()))
    throw new Error('Invalid course authoring timestamp');
}

/** Immutable snapshot of one authored course draft. The head row selects the draft. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_revisions',
  conflictColumns: ['tenant_id', 'course_id', 'request_key'],
  ...closed,
})
export class CourseRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRevision', { nullable: true }) parentRevisionId:
    | string
    | null = null;
  sequence = 1;
  authorUserId = '';
  delegatingGuardianUserId = '';
  provenance = 'supplied';
  @field({ type: 'text' }) fieldProvenanceJson = '{}';
  title = '';
  @field({ type: 'text' }) summary = '';
  subject = '';
  theme = '';
  levelMin = 0;
  levelMax = 0;
  @field({ type: 'text' }) objectivesJson = '[]';
  @field({ type: 'text' }) sectionsJson = '[]';
  licenseKind: CourseLicenseKind = 'own-work';
  requestKey = '';
  payloadDigest = '';
  contentDigest = '';
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
    await requireOwned(this, 'courses', this.courseId);
    if (this.parentRevisionId)
      await requireOwned(this, 'course_revisions', this.parentRevisionId, {
        course_id: this.courseId,
      });
    requireText(this.authorUserId, 'Revision requires an author');
    requireText(this.title, 'Revision requires a title');
    requireText(this.requestKey, 'Revision requires a request key');
    if (
      !PROVENANCES.includes(this.provenance) ||
      !LICENSES.includes(this.licenseKind) ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1 ||
      !Number.isSafeInteger(this.levelMin) ||
      !Number.isSafeInteger(this.levelMax) ||
      this.levelMin < 0 ||
      this.levelMax < this.levelMin
    )
      throw new Error('Invalid course revision');
    requireJson(this.fieldProvenanceJson, 'object', 'Field provenance');
    requireJson(this.objectivesJson, 'array', 'Objectives');
    requireJson(this.sectionsJson, 'array', 'Sections');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseRevisionCollection extends SmrtCollection<CourseRevision> {
  static readonly _itemClass = CourseRevision;
}

/** Immutable lesson snapshot with a stable cross-version `lessonKey`. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'lesson_revisions',
  conflictColumns: ['tenant_id', 'course_id', 'lesson_key', 'content_digest'],
  ...closed,
})
export class LessonRevision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  lessonKey = '';
  @foreignKey('LessonRevision', { nullable: true }) parentRevisionId:
    | string
    | null = null;
  title = '';
  @field({ type: 'text' }) body = '';
  lessonType = 'reading';
  completionRule = 'attest';
  estimatedMinutes = 0;
  difficulty = 0.0;
  modality = 'online';
  externalRef = '';
  externalUrl = '';
  licenseKind: CourseLicenseKind = 'own-work';
  @field({ type: 'text' }) materialsJson = '[]';
  provenance = 'supplied';
  @field({ type: 'text' }) fieldProvenanceJson = '{}';
  authorUserId = '';
  delegatingGuardianUserId = '';
  contentDigest = '';
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
    await requireOwned(this, 'courses', this.courseId);
    if (this.parentRevisionId)
      await requireOwned(this, 'lesson_revisions', this.parentRevisionId, {
        course_id: this.courseId,
        lesson_key: this.lessonKey,
      });
    requireText(this.lessonKey, 'Lesson revision requires a lesson key');
    requireText(this.title, 'Lesson revision requires a title');
    requireText(this.authorUserId, 'Lesson revision requires an author');
    if (
      !['reading', 'video', 'worksheet', 'exercise'].includes(
        this.lessonType,
      ) ||
      !['attest', 'submit', 'score', 'external'].includes(
        this.completionRule,
      ) ||
      !PROVENANCES.includes(this.provenance) ||
      !LICENSES.includes(this.licenseKind) ||
      !Number.isSafeInteger(this.estimatedMinutes) ||
      this.estimatedMinutes < 0 ||
      !Number.isFinite(this.difficulty)
    )
      throw new Error('Invalid lesson revision');
    requireJson(this.materialsJson, 'array', 'Materials');
    requireJson(this.fieldProvenanceJson, 'object', 'Field provenance');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class LessonRevisionCollection extends SmrtCollection<LessonRevision> {
  static readonly _itemClass = LessonRevision;
}

/**
 * The only mutable authoring row: the draft head. It moves solely through the
 * service's expected-head compare-and-swap; its identity never changes.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_draft_heads',
  conflictColumns: ['tenant_id', 'course_id'],
  ...closed,
})
export class CourseDraftHead extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRevision', { required: true }) headRevisionId = '';
  version = 1;
  updatedByUserId = '';
  updatedAt = new Date();
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (!this.tenantId?.trim())
      throw new Error('Course head requires a tenant');
    await requireOwned(this, 'courses', this.courseId);
    await requireOwned(this, 'course_revisions', this.headRevisionId, {
      course_id: this.courseId,
    });
    if (
      this.id &&
      (await this.db.get(this.tableName, { id: this.id })) &&
      !(await this.db.get(this.tableName, {
        id: this.id,
        tenant_id: this.tenantId,
        course_id: this.courseId,
      }))
    )
      throw new Error('Course head identity cannot change');
    if (!Number.isSafeInteger(this.version) || this.version < 1)
      throw new Error('Invalid course head version');
    requireText(this.updatedByUserId, 'Course head requires an actor');
    return super.save(options);
  }
}
export class CourseDraftHeadCollection extends SmrtCollection<CourseDraftHead> {
  static readonly _itemClass = CourseDraftHead;
}

/** Append-only release decision bound to one revision and the review that allowed it. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_releases',
  conflictColumns: ['tenant_id', 'course_id', 'request_key'],
  ...closed,
})
export class CourseRelease extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRevision', { required: true }) revisionId = '';
  /** The immutable Course row materialized for this release. */
  @foreignKey('Course', { required: true }) releaseCourseId = '';
  releaseNumber = 1;
  reviewId = '';
  actorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
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
    await requireOwned(this, 'courses', this.courseId);
    await requireOwned(this, 'courses', this.releaseCourseId);
    await requireOwned(this, 'course_revisions', this.revisionId, {
      course_id: this.courseId,
    });
    requireText(this.actorUserId, 'Release requires an actor');
    requireText(this.requestKey, 'Release requires a request key');
    if (!Number.isSafeInteger(this.releaseNumber) || this.releaseNumber < 1)
      throw new Error('Invalid release number');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseReleaseCollection extends SmrtCollection<CourseRelease> {
  static readonly _itemClass = CourseRelease;
}

/** Stable lesson identity for one release's immutable Lesson row. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'released_lessons',
  conflictColumns: ['tenant_id', 'release_id', 'lesson_key'],
  ...closed,
})
export class ReleasedLesson extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRelease', { required: true }) releaseId = '';
  lessonKey = '';
  @foreignKey('LessonRevision', { required: true }) lessonRevisionId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  @foreignKey('CourseSection', { required: true }) sectionId = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    adopt(this, options);
  }
  override async delete(): Promise<void> {
    noDelete();
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireInsert(this);
    await requireOwned(this, 'course_releases', this.releaseId, {
      course_id: this.courseId,
    });
    await requireOwned(this, 'lesson_revisions', this.lessonRevisionId, {
      course_id: this.courseId,
      lesson_key: this.lessonKey,
    });
    await requireOwned(this, 'lessons', this.lessonId);
    requireText(this.lessonKey, 'Released lesson requires a lesson key');
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class ReleasedLessonCollection extends SmrtCollection<ReleasedLesson> {
  static readonly _itemClass = ReleasedLesson;
}

/** Reversible archive/unarchive decisions; the latest sequence is the state. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_archive_decisions',
  conflictColumns: ['tenant_id', 'course_id', 'request_key'],
  ...closed,
})
export class CourseArchiveDecision extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  action = 'archive';
  sequence = 1;
  actorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
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
    await requireOwned(this, 'courses', this.courseId);
    requireText(this.actorUserId, 'Archive decision requires an actor');
    requireText(this.requestKey, 'Archive decision requires a request key');
    if (
      !['archive', 'unarchive'].includes(this.action) ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1
    )
      throw new Error('Invalid archive decision');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseArchiveDecisionCollection extends SmrtCollection<CourseArchiveDecision> {
  static readonly _itemClass = CourseArchiveDecision;
}

/** Audit record left when an unreferenced draft is discarded. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_discard_tombstones',
  conflictColumns: ['tenant_id', 'course_id'],
  ...closed,
})
export class CourseDiscardTombstone extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  title = '';
  headRevisionId = '';
  revisionCount = 0;
  reason = '';
  actorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
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
    await requireOwned(this, 'courses', this.courseId);
    requireText(this.actorUserId, 'Discard requires an actor');
    requireText(this.requestKey, 'Discard requires a request key');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseDiscardTombstoneCollection extends SmrtCollection<CourseDiscardTombstone> {
  static readonly _itemClass = CourseDiscardTombstone;
}

/**
 * Append-only record of which release an enrollment follows. Enrollment keeps
 * its immutable course id (the release Course row it was assigned); the latest
 * pin by sequence is the enrollment's current release.
 */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'enrollment_release_pins',
  conflictColumns: ['tenant_id', 'enrollment_id', 'request_key'],
  ...closed,
})
export class EnrollmentReleasePin extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Enrollment', { required: true }) enrollmentId = '';
  @foreignKey('Learner', { required: true }) learnerId = '';
  /** Authored course identity. */
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('CourseRelease', { required: true }) releaseId = '';
  @foreignKey('CourseRelease', { nullable: true }) previousReleaseId:
    | string
    | null = null;
  kind = 'initial';
  sequence = 1;
  /** Empty for automatic moves, which have no actor. */
  actorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
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
    await requireOwned(this, 'enrollments', this.enrollmentId, {
      learner_id: this.learnerId,
    });
    await requireOwned(this, 'course_releases', this.releaseId, {
      course_id: this.courseId,
    });
    if (this.previousReleaseId)
      await requireOwned(this, 'course_releases', this.previousReleaseId, {
        course_id: this.courseId,
      });
    requireText(this.requestKey, 'Enrollment pin requires a request key', 300);
    if (
      !['initial', 'explicit', 'auto'].includes(this.kind) ||
      (this.kind !== 'auto' && !this.actorUserId) ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1
    )
      throw new Error('Invalid enrollment pin');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class EnrollmentReleasePinCollection extends SmrtCollection<EnrollmentReleasePin> {
  static readonly _itemClass = EnrollmentReleasePin;
}

/** Recorded opt-in/out of auto-upgrade at course or enrollment scope. */
@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'course_upgrade_choices',
  conflictColumns: ['tenant_id', 'course_id', 'request_key'],
  ...closed,
})
export class CourseUpgradeChoice extends SmrtObject {
  @tenantId() tenantId = '';
  @foreignKey('Course', { required: true }) courseId = '';
  /** Empty for a course-level choice. */
  enrollmentId = '';
  enabled = false;
  sequence = 1;
  actorUserId = '';
  delegatingGuardianUserId = '';
  requestKey = '';
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
    await requireOwned(this, 'courses', this.courseId);
    if (this.enrollmentId)
      await requireOwned(this, 'enrollments', this.enrollmentId);
    requireText(this.actorUserId, 'Upgrade choice requires an actor');
    requireText(this.requestKey, 'Upgrade choice requires a request key');
    if (
      typeof this.enabled !== 'boolean' ||
      !Number.isSafeInteger(this.sequence) ||
      this.sequence < 1
    )
      throw new Error('Invalid upgrade choice');
    validDate(this.recordedAt);
    this.requireInsertOnSave();
    return super.save(options);
  }
}
export class CourseUpgradeChoiceCollection extends SmrtCollection<CourseUpgradeChoice> {
  static readonly _itemClass = CourseUpgradeChoice;
}
