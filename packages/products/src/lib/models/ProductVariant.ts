/**
 * ProductVariant — STI subtype of Product representing one axis-value variant
 * of a parent Product (or any of its subtypes).
 *
 * Common axis examples: size, length, width, finish, color, capacity. The
 * concrete shape is open: consumers choose what their domain varies along.
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
   * ID of the parent product this variant belongs to. Plain row reference
   * within the shared `products` table — points at any Product subtype.
   */
  @meta()
  parentProductId: string = '';

  /**
   * Variant axis values as a key/value map, e.g.
   * `{ "size": "M" }` or `{ "finish": "matte", "size": "L" }`.
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
