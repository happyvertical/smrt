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
import {
  getCurrentTenant,
  TenantScoped,
  tenantId,
} from '@happyvertical/smrt-tenancy';
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
  // KNOWN LIMITATION (tracked for framework follow-up): the core schema
  // generator hardcodes the STI unique index as
  // `(slug, context, _meta_type)` and does not include `tenant_id`
  // even when the class is `@TenantScoped`. As a result two tenants
  // cannot save a row with the same slug+context+type — the UNIQUE
  // constraint at the SQL layer rejects the second insert.
  //
  // We deliberately do NOT override `conflictColumns` here to add
  // `tenant_id`: doing so would put the runtime upsert path
  // (`ON CONFLICT ('slug','context','_meta_type','tenant_id')`) out of
  // step with the actual unique index, producing `SQLITE_ERROR: ON
  // CONFLICT clause does not match any … UNIQUE constraint` on every
  // save. Production callers should either (a) namespace their slugs
  // per tenant on the application side (e.g. `${tenantId}-widget`), or
  // (b) wait for the upstream framework fix that extends the STI
  // unique index with `tenant_id` for tenant-scoped tables.
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
    // Treat `null` like `undefined`: existing product rows written
    // before the `product_type` column existed hydrate with the field
    // as SQL `NULL`, and without this guard the SmrtObject loader would
    // overwrite the `ProductType.PRODUCT` initializer with `null`. The
    // STI discriminator `_meta_type` still identifies the row's
    // subtype; `productType` is the secondary human-readable label and
    // should fall back to the base default for legacy rows.
    if (options.productType !== undefined && options.productType !== null) {
      this.productType = options.productType;
    }
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
    // Don't pass `this.tenantId` here. ProductAsset is @TenantScoped, so the
    // tenancy interceptor auto-filters the underlying list() by the active
    // context. Passing `this.tenantId` would apply a second explicit filter on
    // TOP of the interceptor's — and when this Product is a global/shared row
    // (`tenantId === null`), that second filter would drop every per-tenant
    // link to it. The interceptor is the right boundary: in a tenant scope it
    // returns that tenant's links; outside any scope it returns everything. See
    // the `ProductAsset` model comment about cross-tenant linking.
    const linkedAssets = await productAssets.byLeft(
      this.id,
      relationship ? { relationship } : {},
    );

    // Use the ACTIVE tenant context's tenantId, not `this.tenantId`,
    // when resolving the underlying assets. `resolveOwnedAssetsById`
    // treats its `tenantId` arg as the caller's identity: when set, it
    // enters `withSystemContext` to bypass the interceptor and then
    // includes both that-tenant-owned AND global (tenantId === null)
    // assets in the visible set. Passing `this.tenantId` would force
    // a global Product (`tenantId === null`) running inside a tenant
    // request into the "no caller tenant" branch — the interceptor
    // would then filter to only the tenant's own assets and drop
    // every global asset linked to the shared product. Reading the
    // active context fixes both directions: tenant requests see
    // tenant + global assets; system requests see everything.
    const ctxTenantId = getCurrentTenant()?.tenantId ?? null;
    return resolveOwnedAssetsById(
      this.db,
      linkedAssets.map((link) => link.assetId),
      ctxTenantId,
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
    // Same rationale as `getAssets` — the interceptor's auto-populate sets the
    // new row's `tenantId` from the active context, so we don't hard-wire
    // `this.tenantId`. When this Product is global (`tenantId === null`) but a
    // tenant is linking it, the link should land under that tenant, not under
    // the global namespace.
    await productAssets.attach(this.id, asset.id, {
      relationship,
      sortOrder,
    });
  }

  async removeAsset(assetId: string, relationship?: string): Promise<void> {
    if (!this.id) {
      return;
    }

    const productAssets = await this.getProductAssetCollection();
    // Tenant-scoped delete: pass only the relationship filter and let the
    // interceptor scope the underlying list() to the active tenant, rather
    // than constraining to `this.tenantId` (which on a global product would
    // never match a tenant-owned link). System-style callers without a tenant
    // context sweep every matching row — the existing `detach` semantics.
    await productAssets.detach(
      this.id,
      assetId,
      relationship ? { relationship } : {},
    );
  }
}
