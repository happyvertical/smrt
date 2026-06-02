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
   * We accept both shapes — historical data, migrations, and direct DB
   * imports can produce either — so consumers don't have to normalize
   * `parentId` on write to be discoverable as a root. SQL's `IN` operator
   * does NOT match `NULL` (NULL is not equal to anything, including itself
   * inside an IN list), so the empty-string and NULL cases must run as
   * separate queries and merge.
   */
  async getRootCategories(): Promise<Category[]> {
    const [emptyParents, nullParents] = await Promise.all([
      this.list({ where: { parentId: '' } }),
      this.list({ where: { parentId: null } }),
    ]);

    if (emptyParents.length === 0) return nullParents;
    if (nullParents.length === 0) return emptyParents;

    // De-dupe by id in case a row somehow shows up in both lists.
    const seen = new Set<string>();
    const merged: Category[] = [];
    for (const row of [...emptyParents, ...nullParents]) {
      const id = row.id ?? '';
      if (!id || seen.has(id)) continue;
      seen.add(id);
      merged.push(row);
    }
    return merged;
  }
}
