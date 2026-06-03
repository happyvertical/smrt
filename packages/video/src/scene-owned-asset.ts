import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { Scene } from './scene.js';
import type { SceneAssetRole } from './scene-asset.js';

export interface SceneOwnedAssetOptions extends SmrtObjectOptions {
  sceneId?: string;
  assetId?: string;
  role?: SceneAssetRole;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  name: 'SceneOwnedAsset',
  tableName: 'scene_assets',
  conflictColumns: ['scene_id', 'asset_id', 'role'],
  api: false,
  mcp: false,
  cli: false,
})
export class SceneOwnedAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey(() => Scene, { required: true })
  sceneId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  role: SceneAssetRole = 'source';

  @field()
  sortOrder = 0;

  constructor(options: SceneOwnedAssetOptions = {}) {
    super(options);
    if (options.sceneId) this.sceneId = options.sceneId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.role !== undefined) this.role = options.role;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
