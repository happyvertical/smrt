import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import {
  crossPackageRef,
  field,
  foreignKey,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface ProductAssetOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  productId?: string;
  assetId?: string;
  relationship?: string;
  sortOrder?: number;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'product_assets',
  // tenant_id is included so two tenants can independently link the same
  // shared product/asset under the same relationship without their rows
  // colliding (or worse, one tenant silently overwriting another's link
  // via UPSERT).
  conflictColumns: ['product_id', 'asset_id', 'relationship', 'tenant_id'],
  api: false,
  mcp: false,
  cli: false,
})
export class ProductAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @foreignKey('Product', { required: true })
  productId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: ProductAssetOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.productId) this.productId = options.productId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }
}
