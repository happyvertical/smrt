import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentReference } from './content-reference';

export interface ContentReferencesOptions extends SmrtCollectionOptions {}

export class ContentReferences extends SmrtCollection<ContentReference> {
  static readonly _itemClass = ContentReference;

  async getForSource(sourceId: string): Promise<ContentReference[]> {
    return (await this.list({
      where: { sourceId },
      orderBy: 'created_at ASC',
    })) as ContentReference[];
  }

  async getForTarget(targetId: string): Promise<ContentReference[]> {
    return (await this.list({
      where: { targetId },
      orderBy: 'created_at ASC',
    })) as ContentReference[];
  }

  async link(
    sourceId: string,
    targetId: string,
    tenantId: string | null = null,
  ): Promise<ContentReference> {
    const existing = (await this.get({
      sourceId,
      targetId,
    })) as ContentReference | null;
    if (existing) {
      return existing;
    }

    return (await this.create({
      sourceId,
      targetId,
      tenantId,
    })) as ContentReference;
  }

  async unlink(sourceId: string, targetId: string): Promise<void> {
    const existing = (await this.get({
      sourceId,
      targetId,
    })) as ContentReference | null;
    if (existing) {
      await existing.delete();
    }
  }
}
