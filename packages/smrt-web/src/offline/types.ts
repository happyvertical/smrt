/**
 * @happyvertical/smrt-web — offline outbox shared types (#1762).
 *
 * The SMRT-owned vocabulary the outbox modules (`durable-queue`, `leader`,
 * `engine`) and the public surface (`offline.ts`) share. Kept in its own leaf
 * module — imported by everything, importing nothing from the package — so there
 * is no cycle back through `index.ts` and the whole outbox stays inside the
 * engine-absorption boundary (#1761): NOT ONE `@tanstack/*` type appears here.
 *
 * The sync-apply op/status/reason names mirror
 * `packages/core/src/sync/apply.ts` (the replay target) verbatim, so a queue row
 * maps to a batch item and a batch result maps to a state transition with no
 * translation layer. smrt-web has no inter-smrt dependency (dependency-DAG
 * guardrails), so these are re-declared here rather than imported from core.
 */

/**
 * Mutation kinds the sync-apply batch endpoint accepts. Mirrors core's
 * `SyncApplyOp`. The outbox maps the capability seam's insert/update/delete
 * envelope kinds onto these (`insert → create`).
 */
export type SyncApplyOp = 'create' | 'update' | 'delete';

/**
 * Per-item outcome status from a sync-apply batch result. Mirrors core's
 * `SyncApplyStatus`. The engine maps each onto a durable transition per the
 * contract's "Web outbox (#1762)" consumer notes.
 */
export type SyncApplyStatus = 'applied' | 'conflict' | 'rejected';

/**
 * Machine-readable reasons a sync-apply item was `conflict` or `rejected`.
 * Mirrors core's `SyncApplyReason` union. Drives the engine's result mapping:
 * `auth_required`/`forbidden` pause the loop; `write_failed` retries; the rest
 * are terminal.
 */
export type SyncApplyReason =
  | 'invalid_item'
  | 'invalid_id'
  | 'invalid_payload'
  | 'unknown_object'
  | 'op_not_allowed'
  | 'auth_required'
  | 'forbidden'
  | 'not_found'
  | 'id_conflict'
  | 'write_failed'
  | 'stale_write'
  | 'create_conflict';

/**
 * One item in a `POST {basePath}/sync/apply` request body. Mirrors core's
 * `SyncApplyItem`. Built from an {@link OutboxRow} 1:1.
 */
export interface SyncApplyItem {
  itemId: string;
  object: string;
  op: SyncApplyOp;
  id: string;
  payload?: Record<string, unknown>;
  baseUpdatedAt?: string;
}

/**
 * One entry in a sync-apply batch response's `results[]`. Mirrors core's
 * `SyncApplyItemResult`. `results[i]` corresponds to `items[i]` positionally;
 * `itemId` is echoed for convenience.
 */
export interface SyncApplyItemResult {
  itemId: string | null;
  id: string | null;
  status: SyncApplyStatus;
  reason?: SyncApplyReason;
  updatedAt?: string;
}

/** The HTTP-200 response body of `POST {basePath}/sync/apply`. */
export interface SyncApplyBatchResponse {
  results: SyncApplyItemResult[];
}

/**
 * Maximum items the endpoint accepts in one batch (core's
 * `MAX_SYNC_APPLY_BATCH_SIZE`). The engine chunks a larger backlog into
 * successive POSTs, oldest-first, so FIFO order is preserved across chunks.
 */
export const MAX_SYNC_APPLY_BATCH_SIZE = 1000;

/**
 * The URL segments of the batch apply endpoint relative to the API base path:
 * `POST {basePath}/sync/apply` (core's `SYNC_APPLY_ROUTE_SEGMENTS`).
 */
export const SYNC_APPLY_ROUTE_SEGMENTS = ['sync', 'apply'] as const;

/**
 * The app-observable sync state of a queued mutation — the SAME four-state
 * machine the KMP mobile foundation exposes (ADR 0001), so web and mobile
 * outbox indicators render identically:
 *
 * - `pending` — enqueued, awaiting (re)send.
 * - `uploading` — currently in a sync-apply POST.
 * - `synced` — the mutation's effect is confirmed on the server (a terminal
 *   success — INCLUDING a surfaced conflict, which is a RESOLVED outcome: the
 *   server state won and the item left the queue).
 * - `failed` — a terminal rejection the client cannot resolve by retrying
 *   (`invalid_*`, `not_found`, `id_conflict`, `op_not_allowed`, …) — surfaced
 *   for app-level handling.
 */
export type OutboxSyncState = 'pending' | 'uploading' | 'synced' | 'failed';

/**
 * A sync-state transition delivered to {@link OfflineOutboxConfig.onSyncStateChange}.
 * A PUSH callback (not a subscribable store): smrt-svelte wraps it into a
 * reactive binding later (#1762 follow-on). Carries enough for an app to render
 * a per-row indicator and a retry affordance.
 */
export interface SyncStateEvent {
  /** The queue row's `itemId` (its idempotency handle) this state is for. */
  itemId: string;
  /** The client-generated row UUID the mutation targets. */
  rowId: string;
  /** The collection route segment (e.g. `products`). */
  object: string;
  /** The new observable state. */
  state: OutboxSyncState;
  /** How many replay attempts have run (0 until the first send). */
  attempts: number;
  /** The last replay error message, when `state` is `pending` after a retry. */
  error?: string;
}

/**
 * A conflict surfaced to {@link OfflineOutboxConfig.onConflict} when a replayed
 * item comes back `conflict`. Per the contract this is a RESOLVED outcome — the
 * server state won, the item is removed, and its terminal observable state is
 * `synced` — so an app treats it as "your write was superseded; here is the
 * server's `updatedAt` to rebase from", NOT as a failure to retry.
 */
export interface OutboxConflict {
  /** The queue row's `itemId`. */
  itemId: string;
  /** The collection route segment. */
  object: string;
  /** The client-generated row UUID that conflicted. */
  rowId: string;
  /**
   * Why the item conflicted: `stale_write` (an update/delete whose
   * `baseUpdatedAt` was older than the server row) or `create_conflict` (a
   * create landing on an existing, diverged row).
   */
  reason: 'stale_write' | 'create_conflict';
  /**
   * The server row's `updated_at` after processing — the value to persist as
   * the new `baseUpdatedAt` before re-editing. Present when the endpoint
   * returned it.
   */
  serverUpdatedAt?: string;
}

/** Exponential-backoff tuning for retryable replay failures. */
export interface OutboxBackoff {
  /** Delay before the first retry, ms (default 1000). */
  initialDelayMs?: number;
  /** Multiplier applied per attempt (default 2). */
  multiplier?: number;
  /** Ceiling on the computed delay, ms (default 60000). */
  maxDelayMs?: number;
}

/** Resolved backoff config (defaults filled in). */
export interface ResolvedBackoff {
  initialDelayMs: number;
  multiplier: number;
  maxDelayMs: number;
}

/** Backoff defaults, per the blueprint (initial=1s, ×2, cap 60s). */
export const DEFAULT_BACKOFF: ResolvedBackoff = {
  initialDelayMs: 1000,
  multiplier: 2,
  maxDelayMs: 60000,
};

/**
 * Compute the backoff delay before the NEXT attempt given how many attempts
 * have already been made. Exponential with a ceiling, then multiplied by a
 * jitter factor in `[0.5, 1.0)` to spread a thundering herd of tabs/rows
 * reconnecting at once: `min(maxDelay, initial * mult ** attempts) * jitter`.
 *
 * `attempts` is the count BEFORE this retry (so the first retry, after attempts
 * became 1, uses `initial * mult ** 1`? no — see below). We pass the attempt
 * count AFTER incrementing, and index the exponent off `attempts - 1` so the
 * first retry waits ~`initialDelayMs`. `random` is injectable for deterministic
 * tests.
 */
export function computeBackoffDelay(
  attempts: number,
  backoff: ResolvedBackoff,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attempts - 1);
  const raw = backoff.initialDelayMs * backoff.multiplier ** exponent;
  const capped = Math.min(backoff.maxDelayMs, raw);
  // Jitter in [0.5, 1.0): full jitter's lower half, so a retry never waits
  // longer than the capped delay but is spread over half of it.
  const jitter = 0.5 + random() * 0.5;
  return Math.round(capped * jitter);
}
