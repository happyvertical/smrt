import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

export interface ProductAssetOptions extends SmrtObjectOptions {
  productId?: string;
  assetId?: string;
  relationship?: string;
  sortOrder?: number;
}

@smrt({
  tableName: 'product_assets',
  conflictColumns: ['product_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class ProductAsset extends SmrtObject {
  @field({ required: true })
  productId = '';

  @field({ required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: ProductAssetOptions = {}) {
    super(options);
    if (options.productId) this.productId = options.productId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
  }
}
