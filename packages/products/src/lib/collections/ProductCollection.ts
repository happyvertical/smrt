import type { Asset } from '@happyvertical/smrt-assets';
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
    const product = await this.get({ id: productId });
    if (!product) return [];

    return product.getAssets(relationship);
  }

  async addAsset(
    productId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    const product = await this.get({ id: productId });
    if (!product) {
      throw new Error(`Product '${productId}' not found`);
    }

    await product.addAsset(asset, relationship, sortOrder);
  }

  async removeAsset(
    productId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const product = await this.get({ id: productId });
    if (!product) {
      throw new Error(`Product '${productId}' not found`);
    }

    await product.removeAsset(assetId, relationship);
  }
}
