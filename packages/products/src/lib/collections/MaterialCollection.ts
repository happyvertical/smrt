/**
 * MaterialCollection — Collection manager for {@link Material} objects.
 *
 * STI framework auto-filters by `_meta_type` to return only Material rows
 * from the shared `products` table.
 */

import { Material } from '../models/Material';
import type { MaterialKind } from '../models/types';
import { ProductCollection } from './ProductCollection';

export class MaterialCollection extends ProductCollection {
  static override readonly _itemClass = Material;

  /**
   * Find every {@link Material} with the given kind.
   *
   * `materialKind` is an `@meta()` field — it lives inside the shared
   * `_meta_data` JSON column on `products`, not as its own SQL column.
   * That means a naive `list({ where: { materialKind } })` would generate
   * a WHERE on a non-existent column. We list every Material STI row and
   * filter the hydrated instances in JS.
   *
   * For very large catalogs, consumers should add a generated column or
   * an expression index over the JSON path and override this helper.
   */
  async findByKind(materialKind: MaterialKind): Promise<Material[]> {
    const items = (await this.list({})) as Material[];
    return items.filter((m) => m.materialKind === materialKind);
  }
}
