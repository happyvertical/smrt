/**
 * Product knowledge base category model
 *
 * SMRT auto-generates REST APIs, MCP tools, and TypeScript clients from this class.
 */

import { SmrtObject, type SmrtObjectOptions, smrt } from '@have/smrt';

/**
 * Options for Category initialization
 */
export interface CategoryOptions extends SmrtObjectOptions {
  name?: string;
  description?: string;
  parentId?: string;
  level?: number;
  productCount?: number;
  active?: boolean;
}

/**
 * Product knowledge base category for organizing product information
 */
@smrt({
  api: {
    include: ['list', 'get', 'create', 'update'], // Standard CRUD except delete
  },
  mcp: {
    include: ['list', 'get'], // AI tools for category discovery
  },
  cli: true, // Enable CLI commands for admin
})
export class Category extends SmrtObject {
  name = '';
  description = '';
  parentId?: string; // For hierarchical categories
  level = 0; // Category depth in hierarchy
  productCount = 0; // Number of products in this category
  active = true;

  constructor(options: CategoryOptions = {}) {
    super(options);
    this.name = options.name || '';
    this.description = options.description || '';
    this.parentId = options.parentId;
    this.level = options.level || 0;
    this.productCount = options.productCount || 0;
    this.active = options.active !== undefined ? options.active : true;
  }

  async getProducts() {
    // Returns products in this category - implementation auto-generated
    return [];
  }

  async getSubcategories() {
    // Returns child categories - implementation auto-generated
    return [];
  }

  async updateProductCount(): Promise<void> {
    // Updates the cached product count
    // Implementation will be auto-generated to count related products
  }

  static async getRootCategories(): Promise<Category[]> {
    // Returns top-level categories (parentId is null/empty)
    return [];
  }
}
