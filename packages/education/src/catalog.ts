import {
  field,
  foreignKey,
  GlobalInterceptors,
  ObjectRegistry,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type CourseLicenseKind =
  | 'own-work'
  | 'open-license'
  | 'personal-use-copy'
  | 'licensed-for-sharing';
export type CourseModality =
  | 'online'
  | 'printable'
  | 'kit'
  | 'video'
  | 'game'
  | 'mixed';
export type CourseStatus = 'draft' | 'published' | 'archived';
export type LessonCompletionRule = 'attest' | 'submit' | 'score' | 'external';

const closed = { api: false, mcp: false, cli: false } as const;

function applyModelOptions(
  target: Record<string, unknown>,
  options: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(options)) {
    if (Object.hasOwn(target, key)) target[key] = value;
  }
}

async function requireParentTenant(
  child: SmrtObject & { tenantId: string | null },
  table: string,
  parentId: string,
): Promise<void> {
  const parent = await child.db.get(table, { id: parentId });
  if (!parent) throw new Error(`education parent ${parentId} does not exist`);
  if (!(await child.db.get(table, { id: parentId, tenant_id: child.tenantId })))
    throw new Error('education children must retain the course tenant');
}

@TenantScoped({ mode: 'optional' })
@smrt({ tableStrategy: 'sti', ...closed })
export class Course extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @field() title = '';
  summary = '';
  description = '';
  sourceKey = 'manual';
  sourceUrl = '';
  sourceRef = '';
  license = '';
  licenseKind: CourseLicenseKind = 'own-work';
  licenseNote = '';
  attestedBy = '';
  subject = '';
  tags = '';
  levelMin = 0;
  levelMax = 0;
  difficulty = 0.0;
  estimatedMinutes = 0;
  modality: CourseModality = 'online';
  status: CourseStatus = 'draft';
  /**
   * Optional physical-book identity: '' means the course is not a book. A
   * family holds at most one course per book key; the key never changes.
   */
  bookKey = '';
  /** Printed edition of the book; '' means unknown. */
  bookEdition = '';
  /** Course work policy: learners see AI marks only after a guardian release. */
  workReviewRequired = true;
  /** Compare-and-swap version of the work policy; captures snapshot it. */
  workPolicyVersion = 1;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }

  /** A personal copy remains pinned to its original family and license. */
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (
      typeof this.bookKey !== 'string' ||
      this.bookKey.length > 200 ||
      typeof this.bookEdition !== 'string' ||
      this.bookEdition.length > 200 ||
      typeof this.workReviewRequired !== 'boolean' ||
      !Number.isSafeInteger(this.workPolicyVersion) ||
      this.workPolicyVersion < 1
    )
      throw new Error('Invalid course book identity or work policy');
    if (this.bookKey) {
      if (!this.tenantId)
        throw new Error('A book course requires an owning family');
      const holders = await this.db.list(this.tableName, {
        tenant_id: this.tenantId,
        book_key: this.bookKey,
      });
      if (holders.some((row) => String(row.id) !== String(this.id ?? '')))
        throw new Error('The family already has a course for this book');
    }
    if (this.licenseKind === 'personal-use-copy' && !this.tenantId) {
      throw new Error('personal-use-copy courses require an owning tenant');
    }
    if (
      this.licenseKind === 'personal-use-copy' &&
      this.status === 'published'
    ) {
      throw new Error('personal-use-copy courses cannot be published');
    }
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (prior) {
      const row = prior as Record<string, unknown>;
      const priorLicense = row.licenseKind ?? row.license_kind;
      if (
        priorLicense === 'personal-use-copy' &&
        (!(await this.db.get(this.tableName, {
          id: this.id,
          tenant_id: this.tenantId,
        })) ||
          this.licenseKind !== 'personal-use-copy')
      ) {
        throw new Error(
          'personal-use-copy courses cannot change tenant or license kind',
        );
      }
      if (
        !(await this.db.get(this.tableName, {
          id: this.id,
          tenant_id: this.tenantId,
          license_kind: this.licenseKind,
        }))
      )
        throw new Error(
          'Persisted courses require explicit re-authoring to change tenant or license',
        );
      const priorBook = String(row.bookKey ?? row.book_key ?? '');
      if (priorBook && priorBook !== this.bookKey)
        throw new Error('A course book key cannot change');
    }
    return await super.save(options);
  }
}

@smrt({ tableName: 'courses', ...closed })
export class ExternalCourse extends Course {}

/** Who an authored course is meant for: its family, its family's groups, a public listing label. */
export const COURSE_VISIBILITIES = ['family', 'groups', 'public'] as const;
export type CourseVisibility = (typeof COURSE_VISIBILITIES)[number];

@smrt({ tableName: 'courses', ...closed })
export class AuthoredCourse extends Course {
  /**
   * Authored-course visibility; '' means never set (reads as 'family'). Only the
   * course-authoring service writes it, with an append-only change row.
   */
  visibility: CourseVisibility | '' = '';
  /** Education-owned image asset shown as the course cover; '' means none. */
  coverAssetId = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (
      this.licenseKind === 'personal-use-copy' &&
      (this.visibility === 'groups' || this.visibility === 'public')
    )
      throw new Error('personal-use-copy courses can only be family-visible');
    return await super.save(options);
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({ ...closed })
export class CourseSection extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('Course', { required: true, requiredFor: 'identity' }) courseId =
    '';
  @field() title = '';
  sortOrder = 0;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireParentTenant(this, 'courses', this.courseId);
    const prior = this.id
      ? await this.db.get('course_sections', { id: this.id })
      : null;
    if (
      prior &&
      !(await this.db.get('course_sections', {
        id: this.id,
        course_id: this.courseId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error(
        'Persisted sections require explicit re-authoring to change parent',
      );

    return await super.save(options);
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({ tableStrategy: 'sti', ...closed })
export class Lesson extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('CourseSection', { required: true, requiredFor: 'identity' })
  sectionId = '';
  @field() title = '';
  body = '';
  sortOrder = 0;
  estimatedMinutes = 0;
  difficulty = 0.0;
  modality: CourseModality = 'online';
  completionRule: LessonCompletionRule = 'attest';
  externalRef = '';
  externalUrl = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    await requireParentTenant(this, 'course_sections', this.sectionId);
    const prior = this.id
      ? await this.db.get('lessons', { id: this.id })
      : null;
    if (
      prior &&
      !(await this.db.get('lessons', {
        id: this.id,
        section_id: this.sectionId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error(
        'Persisted lessons require explicit re-authoring to change parent',
      );

    return await super.save(options);
  }
}

@smrt({ tableName: 'lessons', ...closed })
export class Reading extends Lesson {}
@smrt({ tableName: 'lessons', ...closed })
export class Video extends Lesson {
  videoUrl = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }
}
@smrt({ tableName: 'lessons', ...closed })
export class Worksheet extends Lesson {
  printableUrl = '';
  answerUrl = '';
  pages = 0;
  override completionRule: LessonCompletionRule = 'submit';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }
}
@smrt({ tableName: 'lessons', ...closed })
export class Exercise extends Lesson {}

// Pin classification and ancestry at the final database write, including
// natural-key adoption and races after pre-save validation. Content remains mutable.
GlobalInterceptors.register({
  name: 'education-catalog-identity',
  writeGuard(instance, context) {
    // Module reloads may replace this interceptor while older instances remain
    // live. Registry identity, not constructor identity, owns the invariant.
    const identity = context.qualifiedClassName ?? context.className;
    const base =
      ObjectRegistry.getSTIBase(identity) ??
      ObjectRegistry.getClass(identity)?.qualifiedName;
    if (base === '@happyvertical/smrt-education:Course') {
      const course = instance as Course;
      return { tenant_id: course.tenantId, license_kind: course.licenseKind };
    }
    if (base === '@happyvertical/smrt-education:CourseSection') {
      const section = instance as CourseSection;
      return { tenant_id: section.tenantId, course_id: section.courseId };
    }
    if (base === '@happyvertical/smrt-education:Lesson') {
      const lesson = instance as Lesson;
      return { tenant_id: lesson.tenantId, section_id: lesson.sectionId };
    }
  },
});
