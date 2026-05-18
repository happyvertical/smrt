import type {
  JunctionAttachOptions,
  SmrtCollectionOptions,
} from '@happyvertical/smrt-core';
import { SmrtJunction, smrt } from '@happyvertical/smrt-core';
import { ContentReference } from './content-reference';

export interface ContentReferencesOptions extends SmrtCollectionOptions {}

/**
 * Custom-method routes are NOT auto-generated for this collection
 * (api/mcp/cli: false). The idempotent `attach` override below applies
 * only to in-process callers (`Content.addReference()` → idempotent;
 * preserves `id`/`createdAt` on duplicates).
 *
 * REST clients hitting `POST /api/v1/contentreferences` go through the
 * MODEL's CRUD route, which calls `create()` and is upsert-based — id
 * and createdAt get rewritten on duplicates. If a future caller needs
 * stable URLs over REST, expose `attach` by hand-writing
 * `routes/api/v1/contentreferences/attach/+server.ts`. Pre-R2 had a
 * `/link` route auto-generated from `ContentReferences.link()`; that
 * route was deleted with R2 and no replacement was wired up — see the
 * R2 round-6 commit message for context.
 */
// Decorator with empty config — only needed so the scanner detects the
// class. See FactContentCollection for the full rationale.
@smrt()
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
