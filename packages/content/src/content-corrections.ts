import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentCorrection } from './content-correction';

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
