import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { Character } from './character.js';
import type { CharacterAssetRole } from './character-asset.js';

export interface CharacterOwnedAssetOptions extends SmrtObjectOptions {
  characterId?: string;
  assetId?: string;
  role?: CharacterAssetRole;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  name: 'CharacterOwnedAsset',
  tableName: 'character_assets',
  conflictColumns: ['character_id', 'asset_id', 'role'],
  api: false,
  mcp: false,
  cli: false,
})
export class CharacterOwnedAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey(() => Character, { required: true })
  characterId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  role: CharacterAssetRole = 'seed-image';

  @field()
  sortOrder = 0;

  constructor(options: CharacterOwnedAssetOptions = {}) {
    super(options);
    if (options.characterId) this.characterId = options.characterId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.role !== undefined) this.role = options.role;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
