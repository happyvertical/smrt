/**
 * Fixtures for collection.ts coverage tests (convenience finders, count,
 * getDiff, getOrUpsert, and collection-scoped memory).
 *
 * Separate file so the @smrt() classes land in the test manifest.
 *
 * @see src/collection.ts (issue #1500 coverage, ORM group)
 */

import { SmrtCollection } from '../../collection.js';
import { SmrtObject } from '../../object.js';
import { smrt } from '../../registry.js';

@smrt()
export class CovWidget extends SmrtObject {
  name: string = '';
  price: number = 0.0;
  category: string = '';
  inStock: boolean = true;
}

export class CovWidgetCollection extends SmrtCollection<CovWidget> {
  static readonly _itemClass = CovWidget;
}
