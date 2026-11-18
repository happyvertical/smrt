/**
 * Transport kernel: sync/apply host (#5158). Owned by K7.
 */
import { notImplemented } from './not-implemented.js';
import type { SyncApplyHost, SyncApplyHostOptions } from './types.js';

/**
 * Build the host `processSyncApplyBatch()` applies items through.
 *
 * Contract:
 * - Each item's segment is resolved per item, so authorisation is decided for
 *   the model that item names.
 * - Authorisation, the action gate, the write filter and the tenant gate are
 *   the kernel's, identical to a plain create, update or delete.
 * - A create is always insert-only and takes its id from the validated
 *   envelope, never from the payload.
 * - An unknown or unexposed segment resolves to `null`.
 * - Replay, conflict and per-item result rules stay in `sync/apply.ts`.
 */
export function createSyncApplyHost(
  _options: SyncApplyHostOptions,
): SyncApplyHost {
  return notImplemented('createSyncApplyHost', 'K7');
}
