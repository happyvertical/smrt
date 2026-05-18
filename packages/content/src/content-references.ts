import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction } from '@happyvertical/smrt-core';
import { ContentReference } from './content-reference';

export interface ContentReferencesOptions extends SmrtCollectionOptions {}

export class ContentReferences extends SmrtJunction<ContentReference> {
  static readonly _itemClass = ContentReference;
  protected leftField = 'sourceId';
  protected rightField = 'targetId';
  // content_references has no sort_order column — preserve insertion order
  // by sorting on created_at, and disable setLinks position auto-indexing
  // so it doesn't try to write integer indices into the timestamp column.
  protected sortField: string | null = 'createdAt';
  protected positionField: string | null = null;
}
