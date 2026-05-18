import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtJunction } from '@happyvertical/smrt-core';
import { ContentReference } from './content-reference';

export interface ContentReferencesOptions extends SmrtCollectionOptions {}

export class ContentReferences extends SmrtJunction<ContentReference> {
  static readonly _itemClass = ContentReference;
  protected leftField = 'sourceId';
  protected rightField = 'targetId';
  // content_references has no sort_order column — order by created_at ASC instead.
  protected sortField: string | null = null;
}
