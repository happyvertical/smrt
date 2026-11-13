import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * One version of a draft's definition (shell.db), the same shape as
 * `AppVersion` plus the draft it belongs to. The draft's FIRST row is a copy of
 * the live version it started from (its base): it is not a change the person
 * made. Never deleted. Written only by `DraftVersionStore`; no generated
 * surface.
 */
@smrt({
  tableName: 'app_draft_versions',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class AppDraftVersion extends SmrtObject {
  @field({ type: 'text', required: true })
  draftId: string = '';

  @field({ type: 'integer', required: true })
  version: number = 0;

  /** Parent version, `-1` for none. */
  @field({ type: 'integer' })
  parent: number = -1;

  @field({ type: 'text' })
  author: string = '';

  @field({ type: 'text' })
  summary: string = '';

  /** The whole definition, JSON text. */
  @field({ type: 'text' })
  definition: string = '';

  /** `{ steps, purged? }` JSON text, or empty. */
  @field({ type: 'text' })
  migration: string = '';

  @field({ type: 'text' })
  createdAt: string = '';

  @field({ type: 'boolean' })
  purged: boolean = false;
}

export class AppDraftVersionCollection extends SmrtCollection<AppDraftVersion> {
  static readonly _itemClass = AppDraftVersion;
}
