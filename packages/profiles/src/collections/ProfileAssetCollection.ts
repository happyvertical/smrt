import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { ProfileAsset } from '../models/ProfileAsset';
import type { ProfileCollection } from './ProfileCollection';

export interface ProfileAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ProfileAssetCollection extends SmrtJunction<ProfileAsset> {
  static readonly _itemClass = ProfileAsset;
  protected leftField = 'profileId';
  protected rightField = 'assetId';

  private profileCollectionPromise: Promise<ProfileCollection> | null = null;

  private async getProfileCollection(): Promise<ProfileCollection> {
    if (!this.profileCollectionPromise) {
      const { ProfileCollection } = await import('./ProfileCollection');
      this.profileCollectionPromise = ProfileCollection.create({ db: this.db });
    }

    return this.profileCollectionPromise;
  }

  async getAssets(profileId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(
      await this.getProfileCollection(),
      profileId,
      relationship,
    );
  }

  async addAsset(
    profileId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      await this.getProfileCollection(),
      'Profile',
      profileId,
      asset,
      relationship,
      sortOrder,
    );
  }

  async removeAsset(
    profileId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await removeOwnedAssetFromCollection(
      await this.getProfileCollection(),
      'Profile',
      profileId,
      assetId,
      relationship,
    );
  }
}
