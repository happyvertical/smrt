import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { ContentAsset } from './content-asset';

export interface ContentAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ContentAssetCollection extends SmrtJunction<ContentAsset> {
  static readonly _itemClass = ContentAsset;
  protected leftField = 'contentId';
  protected rightField = 'assetId';
}
