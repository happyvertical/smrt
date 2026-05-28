import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { ContentReference } from './content-reference';

export interface ContentReferencesOptions extends SmrtCollectionOptions {}

export interface LinkContentReferenceOptions {
  // ContentVersion.version pinned at citation time. When provided on a
  // re-link of an existing edge, the pin is updated in place.
  targetVersion?: number | null;
}

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
    options: LinkContentReferenceOptions = {},
  ): Promise<ContentReference> {
    const existing = (await this.get({
      sourceId,
      targetId,
    })) as ContentReference | null;
    if (existing) {
      if (
        options.targetVersion !== undefined &&
        existing.targetVersion !== options.targetVersion
      ) {
        existing.targetVersion = options.targetVersion;
        await existing.save();
      }
      return existing;
    }

    return (await this.create({
      sourceId,
      targetId,
      tenantId,
      targetVersion: options.targetVersion ?? null,
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
