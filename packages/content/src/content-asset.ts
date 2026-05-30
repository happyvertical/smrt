import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface ContentAssetOptions extends SmrtObjectOptions {
  contentId?: string;
  assetId?: string;
  relationship?: string;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'content_assets',
  conflictColumns: ['content_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class ContentAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Content', { required: true })
  contentId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: ContentAssetOptions = {}) {
    super(options);
    if (options.contentId) this.contentId = options.contentId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
