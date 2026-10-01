/**
 * AssetTagCollection - junction collection for `asset_tags` (Asset ↔ Tag).
 *
 * Left side is the asset, right side the Tag id. The table has no position
 * column, so neither ordering nor `setLinks` index assignment applies.
 */

import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { AssetTag } from './asset-tag';

// Empty decorator so the scanner detects the collection without clobbering
// the item class's api/mcp/cli config (see AssetAssociationCollection).
@smrt()
export class AssetTagCollection extends SmrtJunction<AssetTag> {
  static readonly _itemClass = AssetTag;
  protected leftField = 'assetId';
  protected rightField = 'tagId';
  protected sortField: string | null = null;
  protected positionField: string | null = null;
}
