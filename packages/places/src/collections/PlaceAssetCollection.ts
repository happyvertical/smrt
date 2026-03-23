import type { Asset } from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { PlaceAsset } from '../models/PlaceAsset';

export interface PlaceAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class PlaceAssetCollection extends SmrtCollection<PlaceAsset> {
  static readonly _itemClass = PlaceAsset;

  async getForPlace(
    placeId: string,
    relationship?: string,
  ): Promise<PlaceAsset[]> {
    const where = relationship ? { placeId, relationship } : { placeId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as PlaceAsset[];
  }

  async getForAsset(assetId: string): Promise<PlaceAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as PlaceAsset[];
  }

  async attach(
    placeId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<PlaceAsset> {
    return (await this.create({
      placeId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    })) as PlaceAsset;
  }

  async detach(
    placeId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const where: Record<string, string> = { placeId, assetId };
    if (relationship) {
      where.relationship = relationship;
    }

    const links = (await this.list({ where })) as PlaceAsset[];
    for (const link of links) {
      await link.delete();
    }
  }

  async getAssets(placeId: string, relationship?: string): Promise<Asset[]> {
    const { PlaceCollection } = await import('./PlaceCollection');
    const places = await PlaceCollection.create({ db: this.db });
    return places.getAssets(placeId, relationship);
  }

  async addAsset(
    placeId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    const { PlaceCollection } = await import('./PlaceCollection');
    const places = await PlaceCollection.create({ db: this.db });
    await places.addAsset(placeId, asset, relationship, sortOrder);
  }

  async removeAsset(
    placeId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const { PlaceCollection } = await import('./PlaceCollection');
    const places = await PlaceCollection.create({ db: this.db });
    await places.removeAsset(placeId, assetId, relationship);
  }
}
