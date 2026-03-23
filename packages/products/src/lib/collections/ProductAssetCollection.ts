import type { Asset } from '@happyvertical/smrt-assets';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import { ProductAsset } from '../models/ProductAsset';

export interface ProductAssetCollectionOptions extends SmrtCollectionOptions {}

@smrt({
  api: false,
  mcp: false,
  cli: false,
})
export class ProductAssetCollection extends SmrtCollection<ProductAsset> {
  static readonly _itemClass = ProductAsset;

  async getForProduct(
    productId: string,
    relationship?: string,
  ): Promise<ProductAsset[]> {
    const where = relationship ? { productId, relationship } : { productId };

    return (await this.list({
      where,
      orderBy: 'sort_order ASC',
    })) as ProductAsset[];
  }

  async getForAsset(assetId: string): Promise<ProductAsset[]> {
    return (await this.list({
      where: { assetId },
      orderBy: 'sort_order ASC',
    })) as ProductAsset[];
  }

  async attach(
    productId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<ProductAsset> {
    return (await this.create({
      productId,
      assetId,
      relationship,
      sortOrder,
    })) as ProductAsset;
  }

  async detach(
    productId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const where: Record<string, string> = { productId, assetId };
    if (relationship) {
      where.relationship = relationship;
    }

    const links = (await this.list({ where })) as ProductAsset[];
    for (const link of links) {
      await link.delete();
    }
  }

  async getAssets(productId: string, relationship?: string): Promise<Asset[]> {
    const { ProductCollection } = await import('./ProductCollection');
    const products = await ProductCollection.create({ db: this.db });
    return products.getAssets(productId, relationship);
  }

  async addAsset(
    productId: string,
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    const { ProductCollection } = await import('./ProductCollection');
    const products = await ProductCollection.create({ db: this.db });
    await products.addAsset(productId, asset, relationship, sortOrder);
  }

  async removeAsset(
    productId: string,
    assetId: string,
    relationship?: string,
  ): Promise<void> {
    const { ProductCollection } = await import('./ProductCollection');
    const products = await ProductCollection.create({ db: this.db });
    await products.removeAsset(productId, assetId, relationship);
  }
}
