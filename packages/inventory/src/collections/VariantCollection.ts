/**
 * VariantCollection — query helpers for {@link Variant} rows.
 *
 * @packageDocumentation
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Variant } from '../models/Variant.js';

export class VariantCollection extends SmrtCollection<Variant> {
  static readonly _itemClass = Variant;

  /**
   * Return every axis declared for the given upstream product, ordered
   * by `sortOrder` so callers can render them as consecutive form columns.
   */
  async findByProduct(productId: string): Promise<Variant[]> {
    return this.list({
      where: { productId },
      orderBy: 'sortOrder ASC',
    });
  }

  /**
   * Look up a single axis on a product by its axis name (e.g. `'size'`,
   * `'finish'`, `'voltage'`). Returns `null` when no row matches.
   */
  async findByAxis(
    productId: string,
    axisName: string,
  ): Promise<Variant | null> {
    const matches = await this.list({
      where: { productId, axisName },
      limit: 1,
    });
    return matches[0] ?? null;
  }
}
