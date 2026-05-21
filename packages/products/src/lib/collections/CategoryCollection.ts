/**
 * CategoryCollection — Collection manager for {@link Category} objects.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Category } from '../models/Category';

export class CategoryCollection extends SmrtCollection<Category> {
  static readonly _itemClass = Category;

  /**
   * Return every top-level category. `parentId` on `Category` is typed
   * `string | undefined`; SMRT serializes undefined string fields as `''`
   * rather than `NULL`, so a category created without an explicit
   * `parentId` lands in the DB with `parent_id = ''`, not `parent_id IS NULL`.
   *
   * We accept both shapes via an `IN` clause so consumers don't have to
   * normalize `parentId` on write to be discoverable as a root.
   */
  async getRootCategories(): Promise<Category[]> {
    return this.list({ where: { parentId: ['', null] } });
  }
}
