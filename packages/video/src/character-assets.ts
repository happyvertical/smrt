import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import type { CharacterAssetRole } from './character-asset.js';
import { CharacterOwnedAsset } from './character-owned-asset.js';

export interface CharacterOwnedAssetCollectionOptions
  extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class CharacterOwnedAssetCollection extends SmrtCollection<CharacterOwnedAsset> {
  static readonly _itemClass = CharacterOwnedAsset;

  async getForCharacter(
    characterId: string,
    role?: CharacterAssetRole,
  ): Promise<CharacterOwnedAsset[]> {
    const where = role ? { characterId, role } : { characterId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as CharacterOwnedAsset[];
  }

  async getForAsset(assetId: string): Promise<CharacterOwnedAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as CharacterOwnedAsset[];
  }

  async attach(
    characterId: string,
    assetId: string,
    role: CharacterAssetRole = 'seed-image',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<CharacterOwnedAsset> {
    return (await this.create({
      characterId,
      assetId,
      role,
      sortOrder,
      tenantId,
    })) as CharacterOwnedAsset;
  }

  async detach(
    characterId: string,
    assetId: string,
    role?: CharacterAssetRole,
  ): Promise<void> {
    const where: Record<string, string> = { characterId, assetId };
    if (role) {
      where.role = role;
    }

    const links = (await this.list({ where })) as CharacterOwnedAsset[];
    for (const link of links) {
      await link.delete();
    }
  }
}
