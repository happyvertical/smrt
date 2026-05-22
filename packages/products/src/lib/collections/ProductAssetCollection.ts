import type { Asset } from '@happyvertical/smrt-assets';
import {
  addOwnedAssetFromCollection,
  createOwnedAssetLink,
  deleteOwnedAssetLinks,
  getOwnedAssetsFromCollection,
  listOwnedAssetLinks,
  removeOwnedAssetFromCollection,
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
    tenantId?: string | null,
  ): Promise<ProductAsset[]> {
    const rows = await listOwnedAssetLinks(
      this,
      'productId',
      productId,
      relationship,
    );
    return tenantId === undefined
      ? rows
      : rows.filter((row) => row.tenantId === tenantId);
  }

  async getForAsset(
    assetId: string,
    tenantId?: string | null,
  ): Promise<ProductAsset[]> {
    const rows = await listOwnedAssetLinks(this, 'assetId', assetId);
    return tenantId === undefined
      ? rows
      : rows.filter((row) => row.tenantId === tenantId);
  }

  async attach(
    productId: string,
    assetId: string,
    relationship = 'attachment',
    sortOrder = 0,
    tenantId: string | null = null,
  ): Promise<ProductAsset> {
    return createOwnedAssetLink(this, {
      productId,
      assetId,
      relationship,
      sortOrder,
      tenantId,
    });
  }

  async detach(
    productId: string,
    assetId: string,
    relationship?: string,
    tenantId?: string | null,
  ): Promise<void> {
    if (tenantId === undefined) {
      // No tenant constraint — caller is explicit about wanting to remove
      // every matching row regardless of tenant (e.g. a super-admin sweep).
      await deleteOwnedAssetLinks(
        this,
        'productId',
        productId,
        assetId,
        relationship,
      );
      return;
    }
    // Tenant-scoped delete: ask the DB to filter on all of (productId,
    // assetId, [relationship,] tenantId) up front so we don't pull every
    // link for the product back into Node only to drop most of them. A
    // product with many assets would otherwise materialise its whole
    // link set on every detach call. We still delete by surrogate id
    // afterwards so the path is identical to the unscoped branch above
    // and never touches another tenant's row even if the where-clause
    // serialisation surprised us.
    const where: Record<string, unknown> = {
      productId,
      assetId,
      tenantId,
    };
    if (relationship !== undefined) {
      where.relationship = relationship;
    }
    const toRemove = await this.list({ where });
    for (const row of toRemove) {
      if (row.id) {
        await this.delete(row.id);
      }
    }
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
