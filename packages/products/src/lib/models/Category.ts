/**
 * Product knowledge base category model
 *
 * SMRT auto-generates REST APIs, MCP tools, and TypeScript clients from this class.
 */

import {
  SmrtObject,
  type SmrtObjectOptions,
  smrt,
} from '@happyvertical/smrt-core';
import { TenantScoped, tenantId } from '@happyvertical/smrt-tenancy';

/**
 * Options for Category initialization
 */
export interface CategoryOptions extends SmrtObjectOptions {
  tenantId?: string | null;
  name?: string;
  description?: string;
  parentId?: string;
  level?: number;
  productCount?: number;
  active?: boolean;
}

/**
 * Product knowledge base category for organizing product information.
 *
 * Optional tenancy — categories may be shared globally (tenantId=null) or
 * scoped to a tenant. Hierarchical via parentId.
 */
@TenantScoped({ mode: 'optional' })
@smrt({
  tableStrategy: 'sti',
  // See the matching note on `Product` — overriding `conflictColumns`
  // to include `tenant_id` causes a SQLite `ON CONFLICT clause does not
  // match any … UNIQUE constraint` error because the core schema
  // generator's hardcoded STI unique index is `(slug, context,
  // _meta_type)` and does not include the tenant column. Until the
  // upstream framework fix lands, two tenants cannot share a category
  // slug at the schema level.
  api: {
    include: ['list', 'get', 'create', 'update'], // Standard CRUD except delete
  },
  mcp: {
    include: ['list', 'get'], // AI tools for category discovery
  },
  cli: true, // Enable CLI commands for admin
})
export class Category extends SmrtObject {
  /**
   * Tenant ID for multi-tenant isolation.
   * Nullable to support both tenant-scoped and global categories.
   */
  @tenantId({ nullable: true })
  tenantId: string | null = null;

  name = '';
  description = '';
  parentId?: string; // For hierarchical categories
  level = 0; // Category depth in hierarchy
  productCount = 0; // Number of products in this category
  active = true;

  constructor(options: CategoryOptions = {}) {
    super(options);
    if (options.tenantId !== undefined) this.tenantId = options.tenantId;
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
