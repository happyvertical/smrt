/**
 * SkuCollection — query helpers for {@link Sku} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Sku } from '../models/Sku';

export class SkuCollection extends SmrtCollection<Sku> {
  static readonly _itemClass = Sku;

  /**
   * Look up a SKU by its tenant-scoped `code` (UPC, internal part
   * number, etc.). Returns `null` when no row matches.
   */
  async findByCode(code: string): Promise<Sku | null> {
    const matches = await this.list({ where: { code }, limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * Look up a SKU by its scannable barcode. Returns `null` when no row
   * matches; pass `''` to skip the query early.
   */
  async findByBarcode(barcode: string): Promise<Sku | null> {
    if (!barcode) return null;
    const matches = await this.list({ where: { barcode }, limit: 1 });
    return matches[0] ?? null;
  }

  /**
   * Find every SKU pointing at the given `Product` id (or any Product
   * STI subtype id — `Material` upstream, vertical subtypes defined in
   * templates). Useful for listing the SKUs that back a single product
   * card.
   */
  async findByProduct(productId: string): Promise<Sku[]> {
    return this.list({ where: { productId }, orderBy: 'code ASC' });
  }

  /**
   * Find every SKU that is a component of the given parent SKU (for
   * bundles / kits). Returns an empty array when the parent has no
   * children.
   */
  async findByParent(parentSkuId: string): Promise<Sku[]> {
    return this.list({ where: { parentSkuId }, orderBy: 'code ASC' });
  }

  /** Find every active SKU, optionally narrowed by parent product id. */
  async findActive(productId?: string): Promise<Sku[]> {
    const where: Record<string, unknown> = { active: true };
    if (productId) where.productId = productId;
    return this.list({ where, orderBy: 'code ASC' });
  }
}
