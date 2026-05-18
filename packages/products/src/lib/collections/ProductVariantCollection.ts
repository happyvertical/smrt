/**
 * ProductVariantCollection — Collection manager for {@link ProductVariant} objects.
 *
 * STI framework auto-filters by `_meta_type` to return only ProductVariant rows
 * from the shared `products` table.
 */

import { ProductVariant } from '../models/ProductVariant';
import { ProductCollection } from './ProductCollection';

export class ProductVariantCollection extends ProductCollection {
  static override readonly _itemClass = ProductVariant;

  async findForParent(parentProductId: string): Promise<ProductVariant[]> {
    const items = await this.list({ where: { parentProductId } });
    return items as ProductVariant[];
  }
}
