/**
 * MaterialCollection — Collection manager for {@link Material} objects.
 *
 * STI framework auto-filters by `_meta_type` to return only Material rows from
 * the shared `products` table.
 */

import { Material } from '../models/Material';
import type { MaterialKind } from '../models/types';
import { ProductCollection } from './ProductCollection';

export class MaterialCollection extends ProductCollection {
  static override readonly _itemClass = Material;

  async findByKind(materialKind: MaterialKind): Promise<Material[]> {
    const items = await this.list({ where: { materialKind } });
    return items as Material[];
  }
}
