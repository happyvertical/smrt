import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import type { PerformerAssetRole } from './performer-asset.js';

export interface PerformerOwnedAssetOptions extends SmrtObjectOptions {
  performerId?: string;
  assetId?: string;
  role?: PerformerAssetRole;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  name: 'PerformerOwnedAsset',
  tableName: 'performer_assets',
  conflictColumns: ['performer_id', 'asset_id', 'role'],
  api: false,
  mcp: false,
  cli: false,
})
export class PerformerOwnedAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ required: true })
  performerId = '';

  @field({ required: true })
  assetId = '';

  @field({ required: true })
  role: PerformerAssetRole = 'reference';

  @field()
  sortOrder = 0;

  constructor(options: PerformerOwnedAssetOptions = {}) {
    super(options);
    if (options.performerId) this.performerId = options.performerId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.role !== undefined) this.role = options.role;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
