/**
 * BillOfMaterialsCollection — query helpers for {@link BillOfMaterials} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { BillOfMaterials } from '../models/BillOfMaterials.js';
import type { BomStatus } from '../types.js';

export class BillOfMaterialsCollection extends SmrtCollection<BillOfMaterials> {
  static readonly _itemClass = BillOfMaterials;

  /**
   * Return every BOM for the given upstream product id, newest version
   * first. Useful for "show me all revisions of this product's recipe"
   * admin screens.
   */
  async findByProduct(productId: string): Promise<BillOfMaterials[]> {
    return this.list({ where: { productId }, orderBy: 'version DESC' });
  }

  /**
   * Return the currently `active` BOM for the given product, or `null` if
   * none has been activated yet. When multiple `active` rows exist (which
   * should not happen but can arise during partial migrations), the
   * highest-version row wins.
   */
  async findActiveForProduct(
    productId: string,
  ): Promise<BillOfMaterials | null> {
    const matches = await this.list({
      where: { productId, status: 'active' },
      orderBy: 'version DESC',
      limit: 1,
    });
    return matches[0] ?? null;
  }

  /**
   * Return every BOM with the given lifecycle status across all products.
   * Mostly useful for admin dashboards (e.g. "show every draft BOM").
   */
  async findByStatus(status: BomStatus): Promise<BillOfMaterials[]> {
    return this.list({ where: { status }, orderBy: 'productId ASC' });
  }
}
