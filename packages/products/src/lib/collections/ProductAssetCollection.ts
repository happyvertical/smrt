import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { ProductAsset } from '../models/ProductAsset';
import type { ProductCollection } from './ProductCollection';

export interface ProductAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ProductAssetCollection extends SmrtJunction<ProductAsset> {
  static readonly _itemClass = ProductAsset;
  protected leftField = 'productId';
  protected rightField = 'assetId';

  private productCollectionPromise: Promise<ProductCollection> | null = null;

  private async getProductCollection(): Promise<ProductCollection> {
    if (!this.productCollectionPromise) {
      const { ProductCollection } = await import('./ProductCollection');
      this.productCollectionPromise = ProductCollection.create({ db: this.db });
    }

    return this.productCollectionPromise;
  }

  async getAssets(productId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(
      await this.getProductCollection(),
      productId,
      relationship,
    );
  }

  async addAsset(
    productId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      await this.getProductCollection(),
      'Product',
      productId,
      asset,
      relationship,
      sortOrder,
    );
  }

  async removeAsset(
    productId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await removeOwnedAssetFromCollection(
      await this.getProductCollection(),
      'Product',
      productId,
      assetId,
      relationship,
    );
  }
}
