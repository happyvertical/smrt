/**
 * PerformerAsset - STI asset subclass for Performer-owned assets
 */

import { Asset, type AssetOptions } from '@happyvertical/smrt-assets';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { Performer } from './performer.js';

/** Roles a performer asset can play */
export type PerformerAssetRole = 'reference' | 'seed';

export interface PerformerAssetOptions extends AssetOptions {
  /** Performer this asset belongs to */
  performerId?: string | null;
  /** Role of this asset for the performer */
  role?: PerformerAssetRole;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class PerformerAsset extends Asset {
  @foreignKey(() => Performer)
  performerId: string | null = null;

  role: PerformerAssetRole = 'reference';

  constructor(options: PerformerAssetOptions = {}) {
    super(options);
    if (options.performerId !== undefined)
      this.performerId = options.performerId;
    if (options.role !== undefined) this.role = options.role;
  }
}
