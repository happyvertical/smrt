/**
 * CategoryCollection — Collection manager for {@link Category} objects.
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Category } from '../models/Category';

export class CategoryCollection extends SmrtCollection<Category> {
  static readonly _itemClass = Category;

  async getRootCategories(): Promise<Category[]> {
    return this.list({ where: { parentId: null } });
  }
}
