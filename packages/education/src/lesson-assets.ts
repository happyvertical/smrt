import { AssetCollection } from '@happyvertical/smrt-assets';
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

/** The role a material plays for a lesson or a course. */
export const LESSON_ASSET_RELATIONSHIPS = [
  'teacher-guide',
  'slides',
  'learner-pages',
  'assessment',
  'assessment-guidance',
  'handout',
  'printable',
  'answer-key',
  'video',
  'attachment',
] as const;
export type LessonAssetRelationship =
  (typeof LESSON_ASSET_RELATIONSHIPS)[number];

/** Who a material is for: the learner, or the guardian only. */
export type MaterialAudience = 'learner' | 'guardian';

/** The audience a role gets unless the family chooses otherwise. */
export const LESSON_ASSET_DEFAULT_AUDIENCE: Readonly<
  Record<LessonAssetRelationship, MaterialAudience>
> = Object.freeze({
  'teacher-guide': 'guardian',
  slides: 'guardian',
  'learner-pages': 'learner',
  assessment: 'learner',
  'assessment-guidance': 'guardian',
  handout: 'learner',
  printable: 'learner',
  'answer-key': 'guardian',
  video: 'learner',
  attachment: 'learner',
});

/** Keys and marking guidance: never learner-visible, always private files. */
export const GUARDIAN_ONLY_RELATIONSHIPS: ReadonlySet<LessonAssetRelationship> =
  new Set(['answer-key', 'assessment-guidance']);

/**
 * The effective audience of a material: its stored audience, or the role
 * default when none was stored. Throws for an unknown role or audience, and
 * for a learner audience on a guardian-only role.
 */
export function materialAudience(
  relationship: string,
  audience?: string | null,
): MaterialAudience {
  if (!(LESSON_ASSET_RELATIONSHIPS as readonly string[]).includes(relationship))
    throw new Error('Unknown material role');
  const role = relationship as LessonAssetRelationship;
  const effective = audience || LESSON_ASSET_DEFAULT_AUDIENCE[role];
  if (effective !== 'learner' && effective !== 'guardian')
    throw new Error('Unknown material audience');
  if (effective === 'learner' && GUARDIAN_ONLY_RELATIONSHIPS.has(role))
    throw new Error('Keys and assessment guidance are guardian-only');
  return effective;
}

/** Guarded private-asset check: the host must hold the exact capability. */
async function requirePrivateAsset(
  row: SmrtObject & { tenantId: string | null; assetId: string },
) {
  const assets = await AssetCollection.create({ db: row.db });
  const asset = await assets.get(row.assetId, { cache: false });
  if (
    !row.tenantId ||
    !asset ||
    asset.tenantId !== row.tenantId ||
    asset.accessMode !== 'private' ||
    !asset.ownerProfileId
  )
    throw new Error(
      'Private lesson material requires an authorized private asset',
    );
}

async function courseOf(
  row: SmrtObject & { tenantId: string | null },
  courseId: string,
) {
  const course = await row.db.get('courses', {
    id: courseId,
    tenant_id: row.tenantId,
  });
  if (!course) throw new Error('education asset course does not exist');
  return course;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'lesson_assets',
  conflictColumns: ['tenant_id', 'lesson_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class LessonAsset extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('Lesson', { required: true }) lessonId = '';
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';
  @field({ required: true }) relationship: LessonAssetRelationship =
    'attachment';
  sortOrder = 0;
  /** '' reads as the role default (`materialAudience`). */
  audience: MaterialAudience | '' = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options)) {
      if (Object.hasOwn(this, key)) {
        (this as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    materialAudience(this.relationship, this.audience);
    const lesson = await this.db.get('lessons', { id: this.lessonId });
    if (!lesson)
      throw new Error(`education lesson ${this.lessonId} does not exist`);
    if (
      !(await this.db.get('lessons', {
        id: this.lessonId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('education assets must retain the course tenant');
    const section = await this.db.get('course_sections', {
      id: lesson.section_id,
      tenant_id: this.tenantId,
    });
    if (!section) throw new Error('education asset course does not exist');
    const course = await courseOf(this, String(section.course_id));
    // Guarded get proves the host supplied the exact actor/owner/asset
    // capability. Never infer authorization from a raw Asset row.
    if (
      GUARDIAN_ONLY_RELATIONSHIPS.has(this.relationship) ||
      course.license_kind === 'personal-use-copy'
    )
      await requirePrivateAsset(this);
    return await super.save(options);
  }
}

/**
 * Course-level material (a supply list, posters): the same roles and
 * audience as lesson material, owned by the course rather than a lesson.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'course_assets',
  conflictColumns: ['tenant_id', 'course_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class CourseAsset extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('Course', { required: true }) courseId = '';
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';
  @field({ required: true }) relationship: LessonAssetRelationship =
    'attachment';
  audience: MaterialAudience | '' = '';
  title = '';
  sortOrder = 0;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options))
      if (Object.hasOwn(this, key))
        (this as unknown as Record<string, unknown>)[key] = value;
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    materialAudience(this.relationship, this.audience);
    if (typeof this.title !== 'string' || this.title.length > 200)
      throw new Error('Invalid course material title');
    const course = await courseOf(this, this.courseId);
    if (
      GUARDIAN_ONLY_RELATIONSHIPS.has(this.relationship) ||
      course.license_kind === 'personal-use-copy'
    )
      await requirePrivateAsset(this);
    return await super.save(options);
  }
}
export class CourseAssetCollection extends SmrtCollection<CourseAsset> {
  static readonly _itemClass = CourseAsset;
}

/** External video providers whose references a lesson may carry. */
export const EXTERNAL_VIDEO_PROVIDERS = ['youtube'] as const;
export type ExternalVideoProvider = (typeof EXTERNAL_VIDEO_PROVIDERS)[number];

const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtube-nocookie.com',
  'youtube-nocookie.com',
]);

/**
 * The 11-character YouTube video id named by a bare id or an allowlisted
 * youtube.com / youtu.be URL (watch, embed, shorts, live); null otherwise.
 * Nothing is fetched.
 */
export function parseYouTubeReference(input: string): string | null {
  if (typeof input !== 'string' || input.length > 2000) return null;
  const value = input.trim();
  if (YOUTUBE_ID.test(value)) return value;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !YOUTUBE_HOSTS.has(url.hostname))
    return null;
  const parts = url.pathname.split('/').filter(Boolean);
  const id =
    url.hostname === 'youtu.be'
      ? parts[0]
      : parts[0] === 'watch'
        ? url.searchParams.get('v')
        : ['embed', 'shorts', 'live', 'v'].includes(parts[0] ?? '')
          ? parts[1]
          : null;
  return id && YOUTUBE_ID.test(id) ? id : null;
}

/** The privacy-enhanced embed URL for a stored reference. */
export function externalVideoEmbedUrl(
  provider: ExternalVideoProvider,
  videoId: string,
): string {
  if (provider !== 'youtube' || !YOUTUBE_ID.test(videoId))
    throw new Error('Unsupported external video');
  return `https://www.youtube-nocookie.com/embed/${videoId}`;
}

/**
 * A lesson video that lives with an allowlisted provider (YouTube): a
 * reference with a title and its step order in the lesson. It is never
 * downloaded and has no Asset row.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'lesson_external_videos',
  conflictColumns: ['tenant_id', 'lesson_id', 'provider', 'video_id'],
  api: false,
  mcp: false,
  cli: false,
})
export class LessonExternalVideo extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('Lesson', { required: true }) lessonId = '';
  provider: ExternalVideoProvider = 'youtube';
  videoId = '';
  title = '';
  stepOrder = 0;
  audience: MaterialAudience | '' = '';
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options))
      if (Object.hasOwn(this, key))
        (this as unknown as Record<string, unknown>)[key] = value;
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    materialAudience('video', this.audience);
    if (
      !(EXTERNAL_VIDEO_PROVIDERS as readonly string[]).includes(
        this.provider,
      ) ||
      !YOUTUBE_ID.test(this.videoId) ||
      typeof this.title !== 'string' ||
      !this.title.trim() ||
      this.title.length > 200 ||
      !Number.isSafeInteger(this.stepOrder) ||
      this.stepOrder < 0
    )
      throw new Error('Invalid external video reference');
    if (
      !(await this.db.get('lessons', {
        id: this.lessonId,
        tenant_id: this.tenantId,
      }))
    )
      throw new Error('External videos must retain the lesson tenant');
    return await super.save(options);
  }
}
export class LessonExternalVideoCollection extends SmrtCollection<LessonExternalVideo> {
  static readonly _itemClass = LessonExternalVideo;
}
