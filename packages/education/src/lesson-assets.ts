import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
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
  override async save(): Promise<this> {
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
    return await super.save();
  }
}
