/**
 * Change-signal bus — the live push spine for the generated `_events` SSE
 * route (issue #1763, parent PRD #1755).
 *
 * The change feed (#1758) is a durable, cursor-addressable log; this bus is
 * its ephemeral companion. Every framework `save()`/`delete()` that appends a
 * feed row also publishes a coarse {@link ChangeSignal} here, which fans out
 * synchronously to in-process subscribers (the SSE controllers of connected
 * `_events` clients) and, when the database adapter exposes a notification
 * capability, to peer replicas over the same channel. Absence of that
 * capability degrades gracefully — no cross-replica push, never an error, and
 * it never blocks the write.
 *
 * ## What a signal carries (and deliberately does not)
 *
 * A signal is `{ table, operation, rowId, tenantId, seq }` — never any row
 * payload. Authorization stays entirely on the read path: a subscriber learns
 * *that* something changed and its cursor (`seq`), then re-reads through the
 * authorized collection routes to catch up. This is why the bus can broadcast
 * a tenant's writes to peer replicas without leaking data across a trust
 * boundary. The `seq` is the same monotonic cursor dimension the change feed
 * allocates, so a reconnecting client can resume via `getChangesSince`.
 *
 * ## Delivery model
 *
 * - Local delivery is a synchronous fan-out ({@link deliverLocally}) into each
 *   listener callback, wrapped in a try/catch **per listener** so one throwing
 *   listener (e.g. a closed SSE controller's `enqueue`) never blocks the
 *   others. There is no per-subscriber queue — backpressure is delegated to
 *   each platform `ReadableStream`.
 * - Cross-replica delivery reuses the same {@link deliverLocally} helper on
 *   receipt, so locally-published and peer-received signals travel one code
 *   path. Notifications this process published are skipped by `source` id
 *   (echo-avoidance), exactly as the collection cache does.
 *
 * This mirrors `collection-cache.ts`'s notify/listen structure; study that
 * module for the shared cross-process conventions (`resolveDbCacheKey`,
 * `getNotifications`, the lazy listener and finally-retract).
 *
 * ## Known gaps
 *
 * - **No max-connections cap**: the bus imposes no ceiling on concurrent
 *   subscribers (SSE connections). A deployment expecting many long-lived
 *   `_events` connections should bound them at the edge (reverse proxy /
 *   load balancer). A per-process cap is a deliberate follow-up.
 * - **Raw-SQL writes are invisible**: signals originate from the framework
 *   write path (same accepted gap as the #1758 feed and #1498 cache). A
 *   `bumpChangeFeed` escape-hatch write appends a feed row but does not
 *   publish a signal.
 * - **Caller-managed transactions are best-effort**: the append + signal fire
 *   from `afterSave`/`afterDelete`, i.e. *before* a caller-wrapped transaction
 *   commits (the autocommit default path — save()/delete() as independent
 *   statements — is exact). Inside such a transaction, a signal may fire for a
 *   change that a later rollback undoes, and the rolled-back seq is then reused
 *   by the next append — so a client trusting a pre-commit `Last-Event-ID`
 *   could skip the reuse via catch-up. This inherits the change feed's
 *   documented transaction caveat (see `change-feed.ts`); no generic
 *   post-commit hook exists to close it. Clients reconcile via full catch-up /
 *   resync, so convergence still holds — live delivery is just best-effort for
 *   transaction-wrapped writes.
 *
 * @see https://github.com/happyvertical/smrt/issues/1763
 * @packageDocumentation
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  getNotifications,
  PROCESS_ID,
  resolveDbCacheKey,
} from './collection-cache.js';

const logger = createLogger({ level: 'info' });

/**
 * Operation carried by a change signal. Kept as a local string union — this
 * module deliberately does NOT import `./change-feed.js` (which imports this
 * one via the writer) so there is no import cycle. It must stay in sync with
 * `ChangeOperation` in `change-feed.ts`.
 */
export type ChangeSignalOperation = 'create' | 'update' | 'delete';

/**
 * A coarse change notification. Carries no row payload by design.
 */
export interface ChangeSignal {
  // NEVER add row-payload fields — #1763 AC: authorization stays on the read path
  /** Physical table the change happened in. */
  table: string;
  /** What happened (`'delete'` doubles as a tombstone signal). */
  operation: ChangeSignalOperation;
  /** Primary key of the changed row, or `null` for table-level changes. */
  rowId: string | null;
  /** Tenant the changed row belongs to, or `null` for global rows. */
  tenantId: string | null;
  /**
   * The change feed sequence allocated for this change — the cursor a
   * reconnecting client resumes from via `getChangesSince`.
   */
  seq: number;
}

/** A subscriber invoked synchronously for every locally-visible signal. */
export type ChangeSignalListener = (signal: ChangeSignal) => void;

/**
 * Notification channel for cross-replica change-signal broadcasts. A distinct
 * channel from the collection cache's — the two buses carry different payloads
 * and evolve independently.
 */
export const CHANGE_SIGNAL_CHANNEL = 'smrt_change_signals';

/**
 * dbKey → local listeners. Keyed via `resolveDbCacheKey` so `:memory:` and
 * URL-less handles are scoped per instance (never cross-deliver between two
 * independent in-memory databases).
 */
const localListeners = new Map<string, Set<ChangeSignalListener>>();

interface ListenerHandle {
  iterator: AsyncIterator<unknown> | null;
  stopped: boolean;
}

/** dbKey → background cross-replica listener handle. */
const crossReplicaListeners = new Map<string, ListenerHandle>();

/** dbKeys we already warned about for a missing notification capability. */
const warnedNoNotifications = new Set<string>();

/**
 * Subscribe to change signals for a database.
 *
 * Registers `listener` for the database's signal scope and, on the first
 * subscriber for that scope, lazily starts the cross-replica listener (a no-op
 * when the adapter has no notification capability). Returns an unsubscribe
 * function that removes the listener and, when the scope's last subscriber
 * leaves, retracts the cross-replica listener so its refcount reaches 0.
 *
 * Delivery is synchronous: `listener` is invoked from the write path (or the
 * cross-replica loop) inside a per-listener try/catch, so it must not assume
 * an active request or tenant context — capture what it needs at subscribe
 * time.
 */
export function subscribeToChangeSignals(
  db: DatabaseInterface,
  listener: ChangeSignalListener,
): () => void {
  const dbKey = resolveDbCacheKey(db);

  let set = localListeners.get(dbKey);
  if (!set) {
    set = new Set();
    localListeners.set(dbKey, set);
  }
  set.add(listener);

  // Lazily start the cross-replica listener on first interest for this scope.
  ensureChangeSignalListener(db);

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const current = localListeners.get(dbKey);
    if (!current) return;
    current.delete(listener);
    if (current.size === 0) {
      localListeners.delete(dbKey);
      // Last local subscriber gone — retract the cross-replica listener so its
      // refcount reaches 0 (mirrors collection-cache's finally-retract).
      retractChangeSignalListener(dbKey);
    }
  };
}

/**
 * Publish a change signal: synchronous local fan-out, then fire-and-forget
 * cross-replica broadcast. Never throws to the caller — a signal problem must
 * never fail the user's write.
 */
export function publishChangeSignal(
  db: DatabaseInterface,
  signal: ChangeSignal,
): void {
  const dbKey = resolveDbCacheKey(db);
  deliverLocally(dbKey, signal);
  // Fire-and-forget: broadcast failures are swallowed inside broadcast.
  void broadcastChangeSignal(db, signal);
}

/**
 * Synchronous local fan-out to every subscriber for a scope. Each listener is
 * wrapped in its own try/catch so one throwing listener (a closed SSE
 * controller) never blocks the rest. Locally-published and peer-received
 * signals both flow through here — the single delivery path.
 */
function deliverLocally(dbKey: string, signal: ChangeSignal): void {
  const set = localListeners.get(dbKey);
  if (!set || set.size === 0) return;
  // Snapshot so a listener that unsubscribes during delivery can't mutate the
  // set mid-iteration.
  for (const listener of [...set]) {
    try {
      listener(signal);
    } catch (error) {
      logger.warn('Change signal: a subscriber threw during local delivery', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

/**
 * Broadcast a signal to peer replicas over the adapter's notification
 * capability. Resolves normally (never throws) whether or not a capability
 * exists — a missing capability warns once per scope and is not an error.
 *
 * Fire-and-forget from the write path: a broadcast failure must never fail the
 * write that triggered it.
 */
export async function broadcastChangeSignal(
  db: DatabaseInterface,
  signal: ChangeSignal,
): Promise<void> {
  const notifications = getNotifications(db);
  const dbKey = resolveDbCacheKey(db);
  if (!notifications) {
    warnOnceNoNotifications(dbKey);
    return;
  }
  try {
    await notifications.notify(CHANGE_SIGNAL_CHANNEL, {
      ...signal,
      source: PROCESS_ID,
    });
  } catch (error) {
    logger.warn(
      `Change signal: failed to broadcast a signal for '${signal.table}'`,
      { error: error instanceof Error ? error.message : String(error) },
    );
  }
}

/**
 * Ensure a background listener consumes cross-replica broadcasts for this
 * database and delivers them locally. Started lazily by the first subscriber
 * for a scope; a no-op (with a one-time warning) when the adapter exposes no
 * notification capability. Notifications this process published are skipped by
 * `source` id (echo-avoidance): the local fan-out already delivered them.
 */
function ensureChangeSignalListener(db: DatabaseInterface): void {
  const dbKey = resolveDbCacheKey(db);
  if (crossReplicaListeners.has(dbKey)) return;

  const notifications = getNotifications(db);
  if (!notifications) {
    warnOnceNoNotifications(dbKey);
    return;
  }

  const handle: ListenerHandle = { iterator: null, stopped: false };
  crossReplicaListeners.set(dbKey, handle);

  void (async () => {
    try {
      const iterable = notifications.listen(CHANGE_SIGNAL_CHANNEL);
      const iterator = iterable[Symbol.asyncIterator]();
      handle.iterator = iterator;

      while (!handle.stopped) {
        const { value, done } = await iterator.next();
        if (done || handle.stopped) break;

        const notification = value as { payload?: unknown };
        const payload: unknown =
          typeof notification?.payload === 'string'
            ? safeParse(notification.payload)
            : notification?.payload;

        if (!payload || typeof payload !== 'object') continue;
        const record = payload as Record<string, unknown>;
        // Echo-avoidance: skip signals this process published (already
        // delivered locally on the write path).
        if (record.source === PROCESS_ID) continue;

        const signal = toSignal(record);
        if (!signal) continue;
        deliverLocally(dbKey, signal);
      }
    } catch (error) {
      if (!handle.stopped) {
        logger.warn(
          'Change signal: cross-replica listener terminated unexpectedly; ' +
            'peer signals are no longer delivered for this database (local ' +
            'delivery and cursor catch-up still work)',
          { error: error instanceof Error ? error.message : String(error) },
        );
      }
    } finally {
      // Only retract our own handle — a concurrent restart may have installed
      // a replacement; deleting unconditionally would orphan it.
      if (crossReplicaListeners.get(dbKey) === handle) {
        crossReplicaListeners.delete(dbKey);
      }
    }
  })();
}

/** Retract the cross-replica listener for a scope (last subscriber left). */
function retractChangeSignalListener(dbKey: string): void {
  const handle = crossReplicaListeners.get(dbKey);
  if (!handle) return;
  handle.stopped = true;
  void handle.iterator?.return?.(undefined);
  crossReplicaListeners.delete(dbKey);
}

/**
 * Stop all cross-replica change-signal listeners. Used by tests and during
 * shutdown; safe to call when none are active.
 */
export function stopChangeSignalListeners(): void {
  for (const handle of crossReplicaListeners.values()) {
    handle.stopped = true;
    void handle.iterator?.return?.(undefined);
  }
  crossReplicaListeners.clear();
  warnedNoNotifications.clear();
}

/**
 * Clear all local subscribers, stop cross-replica listeners, and reset the
 * no-capability warning dedup. Call in test setup for isolation between files.
 */
export function resetChangeSignals(): void {
  localListeners.clear();
  stopChangeSignalListeners();
}

/**
 * Number of active local subscribers for a database scope (test helper).
 *
 * Exposed so integration tests can assert teardown — a leaked SSE subscription
 * would keep this above 0 after a client disconnects. Not part of the public
 * API surface (kept internal to core; not re-exported from `index.ts`).
 */
export function changeSignalSubscriberCount(db: DatabaseInterface): number {
  return localListeners.get(resolveDbCacheKey(db))?.size ?? 0;
}

function warnOnceNoNotifications(dbKey: string): void {
  if (warnedNoNotifications.has(dbKey)) return;
  warnedNoNotifications.add(dbKey);
  logger.warn(
    'Change signal: the database adapter exposes no notification capability, ' +
      'so change signals are delivered in-process only. Cross-replica live ' +
      'updates require an adapter with notifications (e.g. Postgres ' +
      'LISTEN/NOTIFY); subscribers on other replicas fall back to cursor ' +
      'polling.',
  );
}

/**
 * Coerce a received notification payload into a {@link ChangeSignal}, or
 * `undefined` if it is malformed. Guards the cross-replica path against
 * garbage on the channel.
 */
function toSignal(record: Record<string, unknown>): ChangeSignal | undefined {
  const { table, operation, rowId, tenantId, seq } = record;
  if (typeof table !== 'string' || !table) return undefined;
  if (
    operation !== 'create' &&
    operation !== 'update' &&
    operation !== 'delete'
  ) {
    return undefined;
  }
  return {
    table,
    operation,
    rowId: typeof rowId === 'string' ? rowId : null,
    tenantId: typeof tenantId === 'string' ? tenantId : null,
    seq: typeof seq === 'number' ? seq : Number(seq ?? 0) || 0,
  };
}

function safeParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}
