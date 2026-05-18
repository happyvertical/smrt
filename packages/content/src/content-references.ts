import type {
  JunctionAttachOptions,
  SmrtCollectionOptions,
} from '@happyvertical/smrt-core';
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

  /**
   * Find-or-create idempotency: if a reference already exists for
   * (sourceId, targetId), return the existing row unchanged instead of
   * upserting a new row. This preserves the existing row's `id` and
   * `createdAt`, which is important because reference rows are
   * externally addressable via `/api/v1/contentreferences/[id]`.
   *
   * The base `SmrtJunction.attach` flow (this.create → db.upsert) would
   * overwrite both columns on every duplicate call.
   */
  async attach(
    sourceId: string,
    targetId: string,
    opts: JunctionAttachOptions = {},
  ): Promise<ContentReference> {
    const existing = (await this.get({
      sourceId,
      targetId,
    })) as ContentReference | null;
    if (existing) {
      return existing;
    }
    return super.attach(sourceId, targetId, opts);
  }
}
