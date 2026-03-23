import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  createOwnedAssetLink,
  deleteOwnedAssetLinks,
  getOwnedAssetsFromCollection,
  listOwnedAssetLinks,
} from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ProductAsset } from '../models/ProductAsset';
import type { ProductCollection } from './ProductCollection';

export interface ProductAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ProductAssetCollection extends SmrtCollection<ProductAsset> {
  static readonly _itemClass = ProductAsset;
  private productCollectionPromise: Promise<ProductCollection> | null = null;

  private async getProductCollection(): Promise<ProductCollection> {
    if (!this.productCollectionPromise) {
      const { ProductCollection } = await import('./ProductCollection');
      this.productCollectionPromise = ProductCollection.create({ db: this.db });
    }

    return this.productCollectionPromise;
  }

  async getForProduct(
    productId: string,
    relationship?: string,
  ): Promise<ProductAsset[]> {
    return listOwnedAssetLinks(this, 'productId', productId, relationship);
  }

  async getForAsset(assetId: string): Promise<ProductAsset[]> {
    return listOwnedAssetLinks(this, 'assetId', assetId);
  }

  async attach(
    productId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<ProductAsset> {
    return createOwnedAssetLink(this, {
      productId,
      assetId,
      relationship,
      sortOrder,
    });
  }

  async detach(
    productId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    await deleteOwnedAssetLinks(
      this,
      'productId',
      productId,
      assetId,
      relationship,
    );
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
    const products = await this.getProductCollection();
    await products.removeAsset(productId, assetId, relationship);
  }
}
