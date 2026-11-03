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

const closed = { api: false, mcp: false, cli: false } as const;

/** Bounded printable key: 1-200 characters, no control characters. */
export function validLessonPageKey(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= 200 &&
    !Array.from(value).some((c) => {
      const code = c.charCodeAt(0);
      return code < 32 || code === 127;
    })
  );
}

/**
 * One printed page of a lesson: a stable key within the lesson (`p12`,
 * `p12-back`), a display label, its order, and optionally the source file and
 * one-based page it came from. Course structure, not learner history: it is
 * family-owned (or global with its lesson) and never names a learner.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'lesson_pages',
  conflictColumns: ['tenant_id', 'lesson_id', 'page_key'],
  ...closed,
})
export class LessonPage extends SmrtObject {
  @tenantId({ nullable: true }) tenantId: string | null = null;
  @foreignKey('Course', { required: true }) courseId = '';
  @foreignKey('Lesson', { required: true }) lessonId = '';
  pageKey = '';
  label = '';
  sortOrder = 0;
  @crossPackageRef('@happyvertical/smrt-assets:Asset', { nullable: true })
  sourceAssetId: string | null = null;
  @field({ type: 'integer', nullable: true }) sourcePageNumber: number | null =
    null;
  constructor(options: Record<string, unknown> = {}) {
    super(options);
    for (const [key, value] of Object.entries(options))
      if (Object.hasOwn(this, key))
        (this as unknown as Record<string, unknown>)[key] = value;
  }
  override async delete(): Promise<void> {
    throw new Error('Lesson pages are retained with their lesson');
  }
  override async save(options?: SmrtSaveOptions): Promise<this> {
    if (
      !validLessonPageKey(this.pageKey) ||
      typeof this.label !== 'string' ||
      this.label.length > 200 ||
      !Number.isSafeInteger(this.sortOrder) ||
      (this.sourcePageNumber !== null &&
        (!Number.isSafeInteger(this.sourcePageNumber) ||
          this.sourcePageNumber < 1)) ||
      (this.sourcePageNumber !== null && !this.sourceAssetId)
    )
      throw new Error('Invalid lesson page');
    const lesson = await this.db.get('lessons', {
      id: this.lessonId,
      tenant_id: this.tenantId,
    });
    const section =
      lesson &&
      (await this.db.get('course_sections', {
        id: lesson.section_id,
        tenant_id: this.tenantId,
        course_id: this.courseId,
      }));
    if (!section) throw new Error('Lesson page must name its own lesson');
    if (this.sourceAssetId) {
      if (!this.tenantId)
        throw new Error('A page source file requires an owning family');
      if (
        !(await this.db.get('assets', {
          id: this.sourceAssetId,
          tenant_id: this.tenantId,
        }))
      )
        throw new Error('Lesson page source must be a family file');
    }
    if (
      this.id &&
      (await this.db.get(this.tableName, { id: this.id })) &&
      !(await this.db.get(this.tableName, {
        id: this.id,
        tenant_id: this.tenantId,
        course_id: this.courseId,
        lesson_id: this.lessonId,
        page_key: this.pageKey,
      }))
    )
      throw new Error('Lesson page identity cannot change');
    return super.save(options);
  }
}
export class LessonPageCollection extends SmrtCollection<LessonPage> {
  static readonly _itemClass = LessonPage;
}

export interface LessonPageView {
  id: string;
  lessonId: string;
  pageKey: string;
  label: string;
  sortOrder: number;
  sourcePageNumber: number | null;
  hasSource: boolean;
}

export function lessonPageView(row: LessonPage): LessonPageView {
  return {
    id: String(row.id),
    lessonId: row.lessonId,
    pageKey: row.pageKey,
    label: row.label,
    sortOrder: row.sortOrder,
    sourcePageNumber: row.sourcePageNumber,
    hasSource: Boolean(row.sourceAssetId),
  };
}
