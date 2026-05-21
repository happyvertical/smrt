/**
 * Product knowledge base model
 *
 * SMRT auto-generates REST APIs, MCP tools, and TypeScript clients from this class.
 */

import type { Asset } from '@happyvertical/smrt-assets';
import {
  assertValidOwnedAssetRelationship,
  assertValidOwnedAssetSortOrder,
  resolveOwnedAssetsById,
} from '@happyvertical/smrt-assets';
import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';
import { ProductType } from './types';

/**
 * Options for Product initialization
 */
export interface ProductOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  productType?: ProductType;
  name?: string;
  description?: string;
  category?: string;
  manufacturer?: string;
  model?: string;
  price?: number;
  inStock?: boolean;
  specifications?: Record<string, any>;
  tags?: string[];
}

/**
 * Product information for knowledge base queries.
 *
 * STI base — subclasses (e.g. `Material` upstream, `Style`/`Makeup` in the
 * apparel template) share this table via the `_meta_type` discriminator
 * and `productType` field. Optional tenancy lets the same package serve
 * shared global catalogs OR per-merchant catalogs.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  api: {
    include: ['list', 'get', 'create', 'update'], // Standard CRUD except delete
  },
  mcp: {
    include: ['list', 'get'], // AI tools for product discovery
  },
  cli: true, // Enable CLI commands for admin
})
export class Product extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global catalogs.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  /**
   * STI discriminator. Subclasses override this with their type.
   */
  productType: ProductType = ProductType.PRODUCT;

  name = '';
  description = '';
  category = ''; // Reference to category
  manufacturer = '';
  model = '';
  price = 0;
  inStock = true;
  specifications: Record<string, any> = {};
  tags: string[] = [];

  constructor(options: ProductOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
    if (options.productType !== undefined)
      this.productType = options.productType;
    this.name = options.name || '';
    this.description = options.description || '';
    this.category = options.category || '';
    this.manufacturer = options.manufacturer || '';
    this.model = options.model || '';
    this.price = options.price || 0;
    this.inStock = options.inStock !== undefined ? options.inStock : true;
    this.specifications = options.specifications || {};
    this.tags = options.tags || [];
  }

  async getSpecification(key: string): Promise<any> {
    return this.specifications[key];
  }

  async updateSpecification(key: string, value: any): Promise<void> {
    this.specifications[key] = value;
  }

  private async getProductAssetCollection() {
    const { ProductAssetCollection } = await import(
      '../collections/ProductAssetCollection'
    );
    return ProductAssetCollection.create({ db: this.db });
  }
  async getAssets(relationship?: string): Promise<Asset[]> {
    if (!this.id) {
      return [];
    }

    const productAssets = await this.getProductAssetCollection();
    const linkedAssets = await productAssets.getForProduct(
      this.id,
      relationship,
      this.tenantId,
    );

    return resolveOwnedAssetsById(
      this.db,
      linkedAssets.map((link) => link.assetId),
      this.tenantId,
    );
  }

  async addAsset(
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved product or asset');
    }

    assertValidOwnedAssetRelationship(relationship);
    assertValidOwnedAssetSortOrder(sortOrder);

    const productAssets = await this.getProductAssetCollection();
    await productAssets.attach(
      this.id,
      asset.id,
      relationship,
      sortOrder,
      this.tenantId,
    );
  }

  async removeAsset(assetId: string, relationship?: string): Promise<void> {
    if (!this.id) {
      return;
    }

    const productAssets = await this.getProductAssetCollection();
    await productAssets.detach(this.id, assetId, relationship, this.tenantId);
  }

  static async searchByText(_query: string): Promise<Product[]> {
    // Search implementation will be auto-generated
    return [];
  }

  static async findByManufacturer(_manufacturer: string): Promise<Product[]> {
    // Manufacturer search will be auto-generated
    return [];
  }
}
