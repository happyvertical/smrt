import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ContentCorrection } from './content-correction';

// The collection's own @smrt() surface: its read helpers are published
// operations (the API explorer and the workbench call them). A collection
// inherits only its model's CRUD verbs, so it lists the helpers it opens here.
// The CRUD verbs repeat the model's because a collection decorator's config
// is merged over its model's at runtime.
@smrt({
  // Mirror the model's storage so the collection decorator cannot plan a
  // different table for it.
  tableName: 'content_corrections',
  api: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'listForContent',
      'getPublishedForContent',
    ],
  },
  mcp: {
    include: [
      'list',
      'get',
      'create',
      'update',
      'listForContent',
      'getPublishedForContent',
    ],
  },
})
export class ContentCorrectionCollection extends SmrtCollection<ContentCorrection> {
  static readonly _itemClass = ContentCorrection;

  async listForContent(contentId: string): Promise<ContentCorrection[]> {
    return this.list({
      where: { contentId },
      orderBy: 'created_at DESC',
    });
  }

  async getPublishedForContent(
    contentId: string,
  ): Promise<ContentCorrection[]> {
    return this.list({
      where: { contentId, status: 'published' },
      orderBy: 'published_at DESC',
    });
  }

  async issue(
    options: ConstructorParameters<typeof ContentCorrection>[0],
  ): Promise<ContentCorrection> {
    if (!options) {
      return this.create({});
    }

    return this.create({
      ...options,
      metadata:
        typeof options.metadata === 'string'
          ? options.metadata
          : options.metadata
            ? JSON.stringify(options.metadata)
            : undefined,
    });
  }
}
