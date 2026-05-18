/**
 * ProductVariant — STI subtype of Product representing one axis-value variant
 * of a Style (or Makeup).
 *
 * Common axis examples: colorway, size, length, width. For apparel a typical
 * variant is a colorway (with concrete SKUs hanging below per size). For
 * furniture it might be a finish.
 *
 * The actual sellable unit (the thing you scan / count / ship) lives in
 * `@happyvertical/smrt-inventory` as `Sku`. ProductVariant is the catalog-side
 * grouping above Sku.
 *
 * @packageDocumentation
 */

import { meta, smrt } from '@happyvertical/smrt-core';
import { Product, type ProductOptions } from './Product';
import { ProductType } from './types';

export interface ProductVariantOptions extends ProductOptions {
  parentProductId?: string;
  axisValues?: Record<string, string>;
}

@smrt()
export class ProductVariant extends Product {
  override productType: ProductType = ProductType.VARIANT;

  /**
   * ID of the parent product (Style or Makeup) this variant belongs to.
   */
  @meta()
  parentProductId: string = '';

  /**
   * Variant axis values as a key/value map, e.g.
   * `{ "color": "Navy" }` or `{ "color": "Navy", "size": "M" }`.
   * Stored as JSON in `_meta_data`.
   */
  @meta()
  axisValues: Record<string, string> = {};

  constructor(options: ProductVariantOptions = {}) {
    super(options);
    if (options.parentProductId !== undefined)
      this.parentProductId = options.parentProductId;
    if (options.axisValues !== undefined) this.axisValues = options.axisValues;
  }
}
