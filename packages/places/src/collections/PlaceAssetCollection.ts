import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  createOwnedAssetLink,
  deleteOwnedAssetLinks,
  getOwnedAssetsFromCollection,
  listOwnedAssetLinks,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { PlaceAsset } from '../models/PlaceAsset';
import type { PlaceCollection } from './PlaceCollection';

export interface PlaceAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class PlaceAssetCollection extends SmrtCollection<PlaceAsset> {
  static readonly _itemClass = PlaceAsset;
  private placeCollectionPromise: Promise<PlaceCollection> | null = null;

  private async getPlaceCollection(): Promise<PlaceCollection> {
    if (!this.placeCollectionPromise) {
      const { PlaceCollection } = await import('./PlaceCollection');
      this.placeCollectionPromise = PlaceCollection.create({ db: this.db });
    }

    return this.placeCollectionPromise;
  }

  async getForPlace(
    placeId: string,
    relationship?: string,
  ): Promise<PlaceAsset[]> {
    return listOwnedAssetLinks(this, 'placeId', placeId, relationship);
  }

  async getForAsset(assetId: string): Promise<PlaceAsset[]> {
    return listOwnedAssetLinks(this, 'assetId', assetId);
  }

  async attach(
    placeId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<PlaceAsset> {
    return createOwnedAssetLink(this, {
      placeId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    });
  }

  async detach(
    placeId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await deleteOwnedAssetLinks(
      this,
      'placeId',
      placeId,
      assetId,
      relationship,
    );
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
    const places = await this.getPlaceCollection();
    await places.removeAsset(placeId, assetId, relationship);
  }
}
