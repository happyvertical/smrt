import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  createOwnedAssetLink,
  deleteOwnedAssetLinks,
  getOwnedAssetsFromCollection,
  listOwnedAssetLinks,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ProfileAsset } from '../models/ProfileAsset';
import type { ProfileCollection } from './ProfileCollection';

export interface ProfileAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ProfileAssetCollection extends SmrtCollection<ProfileAsset> {
  static readonly _itemClass = ProfileAsset;
  private profileCollectionPromise: Promise<ProfileCollection> | null = null;

  private async getProfileCollection(): Promise<ProfileCollection> {
    if (!this.profileCollectionPromise) {
      const { ProfileCollection } = await import('./ProfileCollection');
      this.profileCollectionPromise = ProfileCollection.create({ db: this.db });
    }

    return this.profileCollectionPromise;
  }

  async getForProfile(
    profileId: string,
    relationship?: string,
  ): Promise<ProfileAsset[]> {
    return listOwnedAssetLinks(this, 'profileId', profileId, relationship);
  }

  async getForAsset(assetId: string): Promise<ProfileAsset[]> {
    return listOwnedAssetLinks(this, 'assetId', assetId);
  }

  async attach(
    profileId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<ProfileAsset> {
    return createOwnedAssetLink(this, {
      profileId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    });
  }

  async detach(
    profileId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await deleteOwnedAssetLinks(
      this,
      'profileId',
      profileId,
      assetId,
      relationship,
    );
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
