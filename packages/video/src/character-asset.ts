/**
 * CharacterAsset - legacy STI asset subclass for Character-owned assets
 *
 * @deprecated Character owned assets are now modeled canonically through
 * `CharacterOwnedAsset` join rows in `character_assets`. This legacy subtype
 * remains readable during migration.
 */

import { Asset, type AssetOptions } from '@happyvertical/smrt-assets';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { Character } from './character.js';

/** Roles a character asset can play */
export type CharacterAssetRole = 'seed-image' | 'base-motion' | 'logo';

export interface CharacterAssetOptions extends AssetOptions {
  /** Character this asset belongs to */
  characterId?: string | null;
  /** Role of this asset for the character */
  role?: CharacterAssetRole;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class CharacterAsset extends Asset {
  @foreignKey(() => Character)
  characterId: string | null = null;

  role: CharacterAssetRole = 'seed-image';

  constructor(options: CharacterAssetOptions = {}) {
    super(options);
    if (options.characterId !== undefined)
      this.characterId = options.characterId;
    if (options.role !== undefined) this.role = options.role;
  }
}
