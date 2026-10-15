import { field, foreignKey, SmrtObject, smrt } from '@happyvertical/smrt-core';
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

@TenantScoped({ mode: 'optional' })
@smrt({ tableStrategy: 'sti', ...closed })
export class Course extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @field({ required: true }) title = '';
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
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }

  /** A personal copy remains pinned to its original family and license. */
  override async save(): Promise<this> {
    if (this.licenseKind === 'personal-use-copy' && !this.tenantId) {
      throw new Error('personal-use-copy courses require a family tenant');
    }
    const prior = this.id
      ? await this.db.get(this.tableName, { id: this.id })
      : null;
    if (prior) {
      const row = prior as Record<string, unknown>;
      const priorLicense = row.licenseKind ?? row.license_kind;
      const priorTenant = row.tenantId ?? row.tenant_id;
      if (
        priorLicense === 'personal-use-copy' &&
        (priorTenant !== this.tenantId ||
          this.licenseKind !== 'personal-use-copy')
      ) {
        throw new Error(
          'personal-use-copy courses cannot change tenant or license kind',
        );
      }
    }
    return await super.save();
  }
}

@smrt({ tableName: 'courses', ...closed })
export class ExternalCourse extends Course {}

@smrt({ tableName: 'courses', ...closed })
export class AuthoredCourse extends Course {}

@TenantScoped({ mode: 'optional' })
@smrt({ ...closed })
export class CourseSection extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('Course', { required: true }) courseId = '';
  @field({ required: true }) title = '';
  sortOrder = 0;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    applyModelOptions(this as unknown as Record<string, unknown>, options);
  }
}

@TenantScoped({ mode: 'optional' })
@smrt({ tableStrategy: 'sti', ...closed })
export class Lesson extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('CourseSection', { required: true }) sectionId = '';
  @field({ required: true }) title = '';
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
}

@smrt({ tableName: 'lessons', ...closed })
export class Reading extends Lesson {}
@smrt({ tableName: 'lessons', ...closed })
export class Video extends Lesson {
  videoUrl = '';
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
