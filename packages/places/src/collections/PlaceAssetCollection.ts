import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { PlaceAsset } from '../models/PlaceAsset';
import type { PlaceCollection } from './PlaceCollection';

export interface PlaceAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class PlaceAssetCollection extends SmrtJunction<PlaceAsset> {
  static readonly _itemClass = PlaceAsset;
  protected leftField = 'placeId';
  protected rightField = 'assetId';

  private placeCollectionPromise: Promise<PlaceCollection> | null = null;

  private async getPlaceCollection(): Promise<PlaceCollection> {
    if (!this.placeCollectionPromise) {
      const { PlaceCollection } = await import('./PlaceCollection');
      this.placeCollectionPromise = PlaceCollection.create({ db: this.db });
    }

    return this.placeCollectionPromise;
  }

  async getAssets(placeId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(
      await this.getPlaceCollection(),
      placeId,
      relationship,
    );
  }

  async addAsset(
    placeId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      await this.getPlaceCollection(),
      'Place',
      placeId,
      asset,
      relationship,
      sortOrder,
    );
  }

  async removeAsset(
    placeId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await removeOwnedAssetFromCollection(
      await this.getPlaceCollection(),
      'Place',
      placeId,
      assetId,
      relationship,
    );
  }
}
