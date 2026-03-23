import type { SmrtObjectOptions } from '@happyvertical/smrt-core';
import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

export interface PlaceAssetOptions extends SmrtObjectOptions {
  placeId?: string;
  assetId?: string;
  relationship?: string;
  sortOrder?: number;
  tenantId?: string | null;
}

@TenantScoped({ mode: 'optional' })
@smrt({
  tableName: 'place_assets',
  conflictColumns: ['place_id', 'asset_id', 'relationship'],
  api: false,
  mcp: false,
  cli: false,
})
export class PlaceAsset extends SmrtObject {
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  @field({ required: true })
  placeId = '';

  @field({ required: true })
  assetId = '';

  @field({ required: true })
  relationship = 'attachment';

  @field()
  sortOrder = 0;

  constructor(options: PlaceAssetOptions = {}) {
    super(options);
    if (options.placeId) this.placeId = options.placeId;
    if (options.assetId) this.assetId = options.assetId;
    if (options.relationship) this.relationship = options.relationship;
    if (options.sortOrder !== undefined) this.sortOrder = options.sortOrder;
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
  }
}
