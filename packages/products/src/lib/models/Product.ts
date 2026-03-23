/**
 * Product knowledge base model
 *
 * SMRT auto-generates REST APIs, MCP tools, and TypeScript clients from this class.
 */

import type { Asset } from '@happyvertical/smrt-assets';
import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Options for Product initialization
 */
export interface ProductOptions extends SmrtObjectOptions {
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

const ASSET_RELATIONSHIP_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertValidAssetRelationship(relationship: string): void {
  if (!ASSET_RELATIONSHIP_PATTERN.test(relationship)) {
    throw new Error(
      `Invalid relationship type "${relationship}"; must start with a letter or underscore and contain only letters, digits, and underscores`,
    );
  }
}

function assertValidAssetSortOrder(sortOrder: number): void {
  if (!Number.isInteger(sortOrder) || sortOrder < 0 || sortOrder > 2147483647) {
    throw new Error(
      `Invalid sortOrder "${sortOrder}"; must be a non-negative integer`,
    );
  }
}

/**
 * Product information for knowledge base queries
 */
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

  private async getAssetCollection() {
    const { AssetCollection } = await import('@happyvertical/smrt-assets');
    return AssetCollection.create({ db: this.db });
  }

  private async getProductAssetCollection() {
    const { ProductAssetCollection } = await import(
      '../collections/ProductAssetCollection'
    );
    return ProductAssetCollection.create({ db: this.db });
  }

  private async resolveAssets(assetIds: string[]): Promise<Asset[]> {
    if (assetIds.length === 0) {
      return [];
    }

    const assets = await this.getAssetCollection();
    const resolved = await assets.listByIds(assetIds);
    const assetsById = new Map(
      resolved
        .filter((asset) => asset.id)
        .map((asset) => [asset.id as string, asset]),
    );

    return assetIds
      .map((assetId) => assetsById.get(assetId))
      .filter(Boolean) as Asset[];
  }

  async getAssets(relationship?: string): Promise<Asset[]> {
    if (!this.id) {
      return [];
    }

    const productAssets = await this.getProductAssetCollection();
    const linkedAssets = await productAssets.getForProduct(
      this.id,
      relationship,
    );

    return this.resolveAssets(linkedAssets.map((link) => link.assetId));
  }

  async addAsset(
    asset: Asset,
    relationship = 'attachment',
    sortOrder = 0,
  ): Promise<void> {
    if (!this.id || !asset.id) {
      throw new Error('Cannot associate unsaved product or asset');
    }

    assertValidAssetRelationship(relationship);
    assertValidAssetSortOrder(sortOrder);

    const productAssets = await this.getProductAssetCollection();
    await productAssets.attach(this.id, asset.id, relationship, sortOrder);
  }

  async removeAsset(assetId: string, relationship?: string): Promise<void> {
    if (!this.id) {
      return;
    }

    const productAssets = await this.getProductAssetCollection();
    await productAssets.detach(this.id, assetId, relationship);
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
