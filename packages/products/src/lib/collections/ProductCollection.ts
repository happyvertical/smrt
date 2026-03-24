import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  getOwnedAssetsFromCollection,
  removeOwnedAssetFromCollection,
} from '@happyvertical/smrt-assets';
import { SmrtCollection } from '@happyvertical/smrt-core';
import { Product } from '../models/Product';

export class ProductCollection extends SmrtCollection<Product> {
  static readonly _itemClass = Product;

  async findByManufacturer(manufacturer: string): Promise<Product[]> {
    return this.list({ where: { manufacturer } });
  }

  async findInStock(): Promise<Product[]> {
    return this.list({ where: { inStock: true } });
  }

  async getAssets(productId: string, relationship?: string): Promise<Asset[]> {
    return getOwnedAssetsFromCollection(this, productId, relationship);
  }

  async addAsset(
    productId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    await addOwnedAssetFromCollection(
      this,
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
      this,
      'Product',
      productId,
      assetId,
      relationship,
    );
  }
}
