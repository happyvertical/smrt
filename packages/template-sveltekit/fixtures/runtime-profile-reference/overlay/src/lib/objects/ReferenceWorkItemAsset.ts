/**
 * Tenant-owned attachment link for the reference workload.
 *
 * It deliberately uses the real s-m-r-t asset identity while keeping this
 * fixture's relationship schema local and explicit. M5 portability tests can
 * later replace the `fixture://` source with a real blob without changing the
 * application record or its attachment relationship.
 */

import {
  crossPackageRef,
  field,
  foreignKey,
  ObjectRegistry,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

@TenantScoped({ mode: 'required' })
@smrt({
  tableName: 'reference_work_item_assets',
  conflictColumns: ['reference_work_item_id', 'asset_id', 'role'],
  api: false,
  cli: false,
  mcp: false,
})
export class ReferenceWorkItemAsset extends SmrtObject {
  @tenantId({ required: true })
  tenantId = '';

  @foreignKey('ReferenceWorkItem', { required: true })
  referenceWorkItemId = '';

  @crossPackageRef('@happyvertical/smrt-assets:Asset', { required: true })
  assetId = '';

  @field({ required: true })
  role = 'attachment';
}

export class ReferenceWorkItemAssetCollection extends SmrtCollection<ReferenceWorkItemAsset> {
  static readonly _itemClass = ReferenceWorkItemAsset;
}

ObjectRegistry.registerCollection(
  'ReferenceWorkItemAsset',
  ReferenceWorkItemAssetCollection,
);
