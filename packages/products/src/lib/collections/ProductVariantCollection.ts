/**
 * ProductVariantCollection — read helpers for {@link ProductVariant} rows.
 *
 * {@link ProductVariant} is a standalone model (not a Product STI subtype),
 * so this collection drives its own table (`product_variants`). Helper
 * methods cover the two common query patterns: "what axes does this
 * product vary along?" and "tell me about the size axis specifically."
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { ProductVariant } from '../models/ProductVariant';

export class ProductVariantCollection extends SmrtCollection<ProductVariant> {
  static readonly _itemClass = ProductVariant;

  /** Every axis declaration for a given product, in display order. */
  async findForProduct(productId: string): Promise<ProductVariant[]> {
    return this.list({
      where: { productId },
      orderBy: 'sortOrder ASC',
    });
  }

  /** The axis declaration for a `(productId, axisName)` pair, or null. */
  async findAxis(
    productId: string,
    axisName: string,
  ): Promise<ProductVariant | null> {
    const matches = await this.list({
      where: { productId, axisName },
      limit: 1,
    });
    return matches[0] ?? null;
  }
}
