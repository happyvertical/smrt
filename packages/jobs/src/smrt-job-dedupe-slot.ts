import {
  field,
  SmrtCollection,
  SmrtObject,
  smrt,
} from '@happyvertical/smrt-core';

/**
 * Store-owned serialization row for a tenant-partitioned job deduplication key.
 *
 * The opaque hash includes tenant identity. Job pointers deliberately have no
 * physical FK: job retention can prune a terminal job before the key is reused.
 * Generated access is disabled; callers use SmrtJobCollection.enqueueJob().
 */
@smrt({
  tableName: '_smrt_job_dedupe_slots',
  api: false,
  cli: false,
  mcp: false,
})
export class SmrtJobDedupeSlot extends SmrtObject {
  /** SHA-256 identity of the tenant and caller key. */
  @field({
    type: 'text',
    required: true,
    requiredFor: 'idempotency',
    unique: true,
  })
  slotKey: string = '';

  /** Last admitted job, which may already have been pruned by retention. */
  @field({ type: 'text', nullable: true })
  jobId: string | null = null;
}

/** Internal collection for provisioning the registered store-owned model. */
export class SmrtJobDedupeSlotCollection extends SmrtCollection<SmrtJobDedupeSlot> {
  static readonly _itemClass = SmrtJobDedupeSlot;
}
