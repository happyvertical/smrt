import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

export type AppDraftStatus = 'starting' | 'open' | 'published' | 'discarded';

/**
 * One draft of the user app (shell.db): a test copy the owner builds in while
 * the live app keeps serving records. At most one is `starting` or `open` at a
 * time. Rows are never deleted: a draft ends as `published` (with the live
 * versions it became) or `discarded`. The copy itself is a directory the
 * engine made (`<data root>/user-app-draft`); this row is the shell's record
 * of it. Written only by `drafts.ts` and the version stores; no generated
 * surface.
 */
@smrt({
  tableName: 'app_drafts',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class AppDraft extends SmrtObject {
  @field({ type: 'text', required: true })
  name: string = 'Draft';

  /** `starting` while the copy is made, `open`, then `published` or `discarded`. */
  @field({ type: 'text' })
  status: AppDraftStatus = 'starting';

  /** The live version the draft was copied from, `-1` until it is. */
  @field({ type: 'integer' })
  baseVersion: number = -1;

  /** The draft's own current version (its store's pointer), `-1` for none yet. */
  @field({ type: 'integer' })
  currentVersion: number = -1;

  @field({ type: 'text' })
  createdBy: string = '';

  @field({ type: 'text' })
  createdAt: string = '';

  /** When it was published or discarded. */
  @field({ type: 'text' })
  endedAt: string = '';

  /** The live version numbers a publish created, JSON array text. */
  @field({ type: 'text' })
  publishedVersions: string = '';

  /** Why it ended without publishing ("start failed", "discarded"), if worth saying. */
  @field({ type: 'text' })
  note: string = '';
}

export class AppDraftCollection extends SmrtCollection<AppDraft> {
  static readonly _itemClass = AppDraft;
}
