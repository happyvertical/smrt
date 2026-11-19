import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

export type ChangeBatchStatus = 'open' | 'held' | 'applied' | 'discarded';

/**
 * The owner's "changes waiting" (#5178): the ordered structural changes the
 * assistant, an import or the API made that are not in the live app yet. The
 * cards (`ChangeCard`) are the source of truth; the draft copy named by
 * `draftId` is only a private working copy derived from them, rebuilt at any
 * time. One `open` (or `held`) batch per tenant and app at a time. Rows are
 * never deleted: a batch ends `applied` (with the live versions it became) or
 * `discarded`. Written only by `changes.ts`; no generated surface.
 */
@smrt({
  tableName: 'change_batches',
  api: false,
  mcp: false,
  cli: false,
  conflictColumns: ['id'],
})
export class ChangeBatch extends SmrtObject {
  @field({ type: 'text', required: true, requiredFor: 'tenant-scope' })
  tenantId: string = '';

  @field({ type: 'text' })
  appId: string = 'app';

  /** `open`, `held` (a workflow such as an import owns the copy), `applied`, `discarded`. */
  @field({ type: 'text' })
  status: ChangeBatchStatus = 'open';

  /** The live version the working copy was made from, `-1` until it is. */
  @field({ type: 'integer' })
  baseVersion: number = -1;

  /** Counts every mutation; Apply and the check pipeline compare against it. */
  @field({ type: 'integer' })
  generation: number = 0;

  /** `batchDigest` of the last check, empty before one. */
  @field({ type: 'text' })
  digest: string = '';

  /** `none` (nothing to check), `ok`, `blocked`, or `stale` (a mutation since the last check). */
  @field({ type: 'text' })
  checkState: string = 'none';

  /** The last check's blockers and overwrite counts, JSON text. */
  @field({ type: 'text' })
  checkResult: string = '';

  /** The `AppDraft` row of the working copy, empty while none is open. */
  @field({ type: 'text' })
  draftId: string = '';

  @field({ type: 'text' })
  createdBy: string = '';

  @field({ type: 'text' })
  createdAt: string = '';

  @field({ type: 'text' })
  appliedAt: string = '';

  /** The live versions Apply created, JSON array text (what Undo takes back). */
  @field({ type: 'text' })
  appliedVersions: string = '';

  /** Set when the applied batch was undone. */
  @field({ type: 'text' })
  undoneAt: string = '';
}

export class ChangeBatchCollection extends SmrtCollection<ChangeBatch> {
  static readonly _itemClass = ChangeBatch;
}
