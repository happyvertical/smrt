import type { Asset } from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ProfileAsset } from '../models/ProfileAsset';

export interface ProfileAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ProfileAssetCollection extends SmrtCollection<ProfileAsset> {
  static readonly _itemClass = ProfileAsset;

  async getForProfile(
    profileId: string,
    relationship?: string,
  ): Promise<ProfileAsset[]> {
    const where = relationship ? { profileId, relationship } : { profileId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as ProfileAsset[];
  }

  async getForAsset(assetId: string): Promise<ProfileAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as ProfileAsset[];
  }

  async attach(
    profileId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<ProfileAsset> {
    return (await this.create({
      profileId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    })) as ProfileAsset;
  }

  async detach(
    profileId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const where: Record<string, string> = { profileId, assetId };
    if (relationship) {
      where.relationship = relationship;
    }

    const links = (await this.list({ where })) as ProfileAsset[];
    for (const link of links) {
      await link.delete();
    }
  }

  async getAssets(profileId: string, relationship?: string): Promise<Asset[]> {
    const { ProfileCollection } = await import('./ProfileCollection');
    const profiles = await ProfileCollection.create({ db: this.db });
    return profiles.getAssets(profileId, relationship);
  }

  async addAsset(
    profileId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    const { ProfileCollection } = await import('./ProfileCollection');
    const profiles = await ProfileCollection.create({ db: this.db });
    await profiles.addAsset(profileId, asset, relationship, sortOrder);
  }

  async removeAsset(
    profileId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const { ProfileCollection } = await import('./ProfileCollection');
    const profiles = await ProfileCollection.create({ db: this.db });
    await profiles.removeAsset(profileId, assetId, relationship);
  }
}
