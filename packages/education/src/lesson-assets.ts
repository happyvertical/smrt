import { AssetCollection } from '@happyvertical/smrt-assets';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  type SmrtSaveOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export type LessonAssetRelationship =
  | 'printable'
  | 'answer-key'
  | 'video'
  | 'attachment';

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
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options)) {
      if (Object.hasOwn(this, key)) {
        (this as unknown as Record<string, unknown>)[key] = value;
      }
    }
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
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
    const course = section
      ? await this.db.get('courses', {
          id: section.course_id,
          tenant_id: this.tenantId,
        })
      : null;
    if (!course) throw new Error('education asset course does not exist');
    if (
      this.relationship === 'answer-key' ||
      course.license_kind === 'personal-use-copy'
    ) {
      // Guarded get proves the host supplied the exact actor/owner/asset
      // capability. Never infer authorization from a raw Asset row.
      const assets = await AssetCollection.create({ db: this.db });
      const asset = await assets.get(this.assetId, { cache: false });
      if (
        !this.tenantId ||
        !asset ||
        asset.tenantId !== this.tenantId ||
        asset.accessMode !== 'private' ||
        !asset.ownerProfileId
      )
        throw new Error(
          'Private lesson material requires an authorized private asset',
        );
    }
    return await super.save(options);
  }
}
