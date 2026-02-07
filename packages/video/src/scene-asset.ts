/**
 * SceneAsset - STI asset subclass for Scene-owned assets
 */

import { Asset, type AssetOptions } from '@happyvertical/smrt-assets';
import { foreignKey, smrt } from '@happyvertical/smrt-core';
import { Scene } from './scene.js';

/** Roles a scene asset can play */
export type SceneAssetRole = 'source' | 'viewpoint-extract' | 'env-map';

export interface SceneAssetOptions extends AssetOptions {
  /** Scene this asset belongs to */
  sceneId?: string | null;
  /** Role of this asset for the scene */
  role?: SceneAssetRole;
}

@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get'] },
  cli: true,
})
export class SceneAsset extends Asset {
  @foreignKey(() => Scene)
  sceneId: string | null = null;

  role: SceneAssetRole = 'source';

  constructor(options: SceneAssetOptions = {}) {
    super(options);
    if (options.sceneId !== undefined) this.sceneId = options.sceneId;
    if (options.role !== undefined) this.role = options.role;
  }
}
