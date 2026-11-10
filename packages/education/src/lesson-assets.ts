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

/**
 * What a material file is relative to a rendering: `original` (an editable
 * Word/PowerPoint file kept beside its rendering: always guardian-only) or
 * `rendered` (the PDF rendered from an original). `''` is a file as supplied.
 */
export const MATERIAL_RENDITIONS = ['original', 'rendered'] as const;
export type MaterialRendition = (typeof MATERIAL_RENDITIONS)[number];

/** Most characters of a lesson step key. */
export const LESSON_STEP_KEY_MAX = 32;
/** Most characters of a lesson step label. */
export const LESSON_STEP_LABEL_MAX = 200;
/** Largest absolute step order a bundle may declare. */
export const LESSON_STEP_ORDER_MAX = 1_000_000;

/**
 * The step of a lesson a material belongs to (SMRT #4656): a short key shared by
 * every material of the step, a finite order (fractions allow `1b` after `1`) and
 * an optional readable label.
 */
export interface LessonStepDeclaration {
  key: string;
  order: number;
  label?: string;
}

/** Throws unless the key, order and label of a stored step are valid together. */
function checkStep(
  key: string | null,
  rawOrder: number | string | null,
  label: string | null,
) {
  if (key === null && rawOrder === null && label === null) return;
  // A decimal column may load as a string on some engines.
  const order = rawOrder === null ? null : Number(rawOrder);
  if (
    typeof key !== 'string' ||
    !key.trim() ||
    key.length > LESSON_STEP_KEY_MAX ||
    typeof order !== 'number' ||
    !Number.isFinite(order) ||
    Math.abs(order) > LESSON_STEP_ORDER_MAX ||
    (label !== null &&
      (typeof label !== 'string' || label.length > LESSON_STEP_LABEL_MAX))
  )
    throw new Error('Invalid lesson step');
}

/** Guarded private-asset check: the host must hold the exact capability. */
async function requirePrivateAsset(
  row: SmrtObject & { tenantId: string | null; assetId: string },
  assetId: string = row.assetId,
) {
  const assets = await AssetCollection.create({ db: row.db });
  const asset = await assets.get(assetId, { cache: false });
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

type MaterialRow = SmrtObject & {
  tenantId: string | null;
  assetId: string;
  relationship: LessonAssetRelationship;
  audience: MaterialAudience | '';
  rendition: MaterialRendition | '';
  renditionOfAssetId: string | null;
  thumbnailAssetId: string | null;
};

/**
 * Rendition and thumbnail rules shared by lesson and course material. An
 * original is never learner-audience; only a rendering names its original; a
 * new thumbnail must be an asset of the same tenant, and a private one when the
 * material itself must be private (checked under the host's capability).
 */
async function checkRendition(row: MaterialRow, privateOnly: boolean) {
  if (
    row.rendition !== '' &&
    !(MATERIAL_RENDITIONS as readonly string[]).includes(row.rendition)
  )
    throw new Error('Invalid material rendition');
  if (
    row.rendition === 'original' &&
    materialAudience(row.relationship, row.audience) !== 'guardian'
  )
    throw new Error('An editable original is guardian-only material');
  if (
    row.renditionOfAssetId &&
    (row.rendition !== 'rendered' || row.renditionOfAssetId === row.assetId)
  )
    throw new Error('Only a rendering names the original it came from');
  if (!row.thumbnailAssetId) return;
  const prior = row.id
    ? await row.db.get(row.tableName, { id: row.id, tenant_id: row.tenantId })
    : null;
  if (prior && prior.thumbnail_asset_id === row.thumbnailAssetId) return;
  if (row.thumbnailAssetId === row.assetId)
    throw new Error('A thumbnail is a separate image asset');
  if (privateOnly) await requirePrivateAsset(row, row.thumbnailAssetId);
  else if (
    !row.tenantId ||
    !(await row.db.get('assets', {
      id: row.thumbnailAssetId,
      tenant_id: row.tenantId,
    }))
  )
    throw new Error('A material thumbnail must be an asset of the same family');
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
  /** `original` / `rendered` for a Word/PowerPoint material, '' for a file as supplied. */
  rendition: MaterialRendition | '' = '';
  /** A rendering: the original asset it was rendered from. */
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { nullable: true })
  renditionOfAssetId: string | null = null;
  /** Optional first-page image of this material, recorded by the rendering step. */
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { nullable: true })
  thumbnailAssetId: string | null = null;
  /**
   * The readable material title the course bundle manifest gave this file
   * (SMRT #4653). Both halves of an original/rendered pair carry it. Null for
   * rows without one: readers fall back to the stored asset's name.
   */
  @field({ type: 'text', nullable: true }) title: string | null = null;
  /**
   * Set when a newer build of the course bundle no longer carries this
   * material (SMRT #4645). A retired row stays (learner work may reference it)
   * but is not part of the current material set. Null when current.
   */
  @field({ type: 'datetime', nullable: true }) retiredAt: Date | null = null;
  /** The course bundle import that wrote this row, null for any other source. */
  @field({ type: 'text', nullable: true }) sourceImportId: string | null = null;
  /** The lesson step this material belongs to (SMRT #4656); null when it is not part of one. */
  @field({ type: 'text', nullable: true }) stepKey: string | null = null;
  /** Position of the step in the lesson; fractions order `1b` after `1`. */
  @field({ type: 'decimal', nullable: true }) stepOrder: number | null = null;
  @field({ type: 'text', nullable: true }) stepLabel: string | null = null;
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
    if (
      this.title !== null &&
      (typeof this.title !== 'string' || this.title.length > 200)
    )
      throw new Error('Invalid lesson material title');
    checkStep(this.stepKey, this.stepOrder, this.stepLabel);
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
    const privateOnly =
      GUARDIAN_ONLY_RELATIONSHIPS.has(this.relationship) ||
      course.license_kind === 'personal-use-copy';
    if (privateOnly) await requirePrivateAsset(this);
    await checkRendition(this, privateOnly);
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
  /** `original` / `rendered` for a Word/PowerPoint material, '' for a file as supplied. */
  rendition: MaterialRendition | '' = '';
  /** A rendering: the original asset it was rendered from. */
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { nullable: true })
  renditionOfAssetId: string | null = null;
  /** Optional first-page image of this material, recorded by the rendering step. */
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { nullable: true })
  thumbnailAssetId: string | null = null;
  /**
   * Set when a newer build of the course bundle no longer carries this
   * material (SMRT #4645). A retired row stays (learner work may reference it)
   * but is not part of the current material set. Null when current.
   */
  @field({ type: 'datetime', nullable: true }) retiredAt: Date | null = null;
  /** The course bundle import that wrote this row, null for any other source. */
  @field({ type: 'text', nullable: true }) sourceImportId: string | null = null;
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
    const privateOnly =
      GUARDIAN_ONLY_RELATIONSHIPS.has(this.relationship) ||
      course.license_kind === 'personal-use-copy';
    if (privateOnly) await requirePrivateAsset(this);
    await checkRendition(this, privateOnly);
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
  /**
   * Set when a newer build of the course bundle no longer carries this
   * material (SMRT #4645). A retired row stays (learner work may reference it)
   * but is not part of the current material set. Null when current.
   */
  @field({ type: 'datetime', nullable: true }) retiredAt: Date | null = null;
  /** The course bundle import that wrote this row, null for any other source. */
  @field({ type: 'text', nullable: true }) sourceImportId: string | null = null;
  /** The lesson step this video belongs to (SMRT #4656); null when it is not part of one. */
  @field({ type: 'text', nullable: true }) stepKey: string | null = null;
  /**
   * Position of the step in the lesson; fractions order `1b` after `1`.
   * (`stepOrder` stays the whole-number rank videos have always carried.)
   */
  @field({ type: 'decimal', nullable: true }) stepPosition: number | null =
    null;
  @field({ type: 'text', nullable: true }) stepLabel: string | null = null;
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
    checkStep(this.stepKey, this.stepPosition, this.stepLabel);
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
