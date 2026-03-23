import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ContentAsset } from './content-asset';

export interface ContentAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ContentAssetCollection extends SmrtCollection<ContentAsset> {
  static readonly _itemClass = ContentAsset;

  async getForContent(
    contentId: string,
    relationship?: string,
  ): Promise<ContentAsset[]> {
    const where = relationship ? { contentId, relationship } : { contentId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as ContentAsset[];
  }

  async getForAsset(assetId: string): Promise<ContentAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as ContentAsset[];
  }

  async attach(
    contentId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<ContentAsset> {
    return (await this.create({
      contentId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    })) as ContentAsset;
  }

  async detach(
    contentId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const where: Record<string, string> = { contentId, assetId };
    if (relationship) {
      where.relationship = relationship;
    }

    const links = (await this.list({ where })) as ContentAsset[];
    for (const link of links) {
      await link.delete();
    }
  }
}
