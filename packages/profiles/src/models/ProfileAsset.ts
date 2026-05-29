import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface ProfileAssetOptions extends SmrtObjectOptions {
  profileId?: string;
  assetId?: string;
  relationship?: string;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'profile_assets',
  conflictColumns: ['profile_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class ProfileAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Profile', { required: true })
  profileId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: ProfileAssetOptions = {}) {
    super(options);
    if (options.profileId) this.profileId = options.profileId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
