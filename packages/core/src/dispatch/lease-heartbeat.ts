/**
 * Lease heartbeat, in-process live-lease registry and lease executor policy
 * of `DispatchBus.process()` (internal).
 *
 * Heartbeat: while a handler runs, an unref'd timer renews the attempt's
 * lease every `leaseMs / 3`. At most one renewal is in flight per attempt (a
 * tick that finds one pending is skipped), and a renewal is sent only while
 * the attempt is `running`. A renewal that matches no row means the lease
 * was lost (reclaimed, swept, retried or released): the attempt's
 * `AbortSignal` is aborted and renewal stops. A renewal that throws or
 * times out is retried on the next tick and never aborts the handler.
 *
 * Registry: on embedded engines (local SQLite, DuckDB, JSON, PGlite) the
 * supported deployment has one writing process per database, so the
 * registry of attempts this process is running is authoritative for that
 * database: candidates it holds are skipped even when the database lease
 * looks expired (a renewal rolled back with a handler transaction, a blocked
 * connection), so this process never runs one row twice at the same time.
 * Networked engines rely on the database lease alone.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  databaseReadScope,
  isKnownDatabaseTransaction,
  isPostgresDatabase,
  usesEmbeddedRevisionFallback,
} from '../embedded-write-queue.js';
import type { DispatchLease } from './lease.js';

const logger = createLogger({ level: 'info' });

/** Error code of the `AbortSignal` reason when an attempt's lease is lost. */
export const DISPATCH_LEASE_LOST = 'DISPATCH_LEASE_LOST';
/** Error code thrown when a handle cannot run lease statements safely. */
export const DISPATCH_LEASE_EXECUTOR_UNSAFE = 'DISPATCH_LEASE_EXECUTOR_UNSAFE';

const liveLeases = new Map<string | object, Set<string>>();

function registryKey(db: DatabaseInterface): string | object | null {
  return usesEmbeddedRevisionFallback(db as never)
    ? databaseReadScope(db)
    : null;
}

/** Whether this process is running an attempt on row `id` of `db`. */
export function isLeaseHeldLocally(db: DatabaseInterface, id: string): boolean {
  const key = registryKey(db);
  return key !== null && liveLeases.get(key)?.has(id) === true;
}

/** Ids of rows of `db` this process is running attempts on. */
export function locallyHeldLeaseIds(db: DatabaseInterface): string[] {
  const key = registryKey(db);
  return key === null ? [] : [...(liveLeases.get(key) ?? [])];
}

/** Record a live local attempt on row `id`; returns the release. */
export function holdLeaseLocally(
  db: DatabaseInterface,
  id: string,
): () => void {
  const key = registryKey(db);
  if (key === null) return () => {};
  let ids = liveLeases.get(key);
  if (!ids) {
    ids = new Set();
    liveLeases.set(key, ids);
  }
  ids.add(id);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = liveLeases.get(key);
    current?.delete(id);
    if (current?.size === 0) liveLeases.delete(key);
  };
}

/**
 * Throw `DISPATCH_LEASE_EXECUTOR_UNSAFE` when `db` provably cannot commit a
 * lease statement independently of a handler: a PostgreSQL pool of fewer
 * than two clients, a single PostgreSQL client, or a transaction handle.
 * Anything else is accepted (documented requirement).
 */
export function assertLeaseExecutorSafe(db: DatabaseInterface): void {
  const unsafe = (detail: string) =>
    Object.assign(
      new Error(
        `${DISPATCH_LEASE_EXECUTOR_UNSAFE}: ${detail}; pass a handle that can run a statement while a handler holds another (see the leaseDb option)`,
      ),
      { code: DISPATCH_LEASE_EXECUTOR_UNSAFE },
    );
  if (isKnownDatabaseTransaction(db)) {
    throw unsafe('the dispatch bus handle is a transaction handle');
  }
  const client = (db as { client?: unknown }).client as
    | { options?: { max?: unknown }; connectionParameters?: unknown }
    | undefined;
  if (!client || typeof client !== 'object') return;
  const max = client.options?.max;
  if (isPostgresDatabase(db as never) && typeof max === 'number' && max < 2) {
    throw unsafe(`the PostgreSQL pool allows ${max} client`);
  }
  if (client.connectionParameters !== undefined && max === undefined) {
    throw unsafe(
      'the dispatch bus handle is a single PostgreSQL connection or a transaction handle',
    );
  }
}

/** Counters one heartbeat reports. */
export interface DispatchHeartbeatCounters {
  renewErrors: number;
}

/** Local state of one attempt. */
type AttemptState = 'running' | 'settling' | 'done';

/**
 * Heartbeat of one attempt. `stop()` moves the attempt out of `running`
 * (no renewal is sent afterwards) and waits for a renewal in flight.
 */
export interface DispatchHeartbeat {
  readonly signal: AbortSignal;
  readonly counters: DispatchHeartbeatCounters;
  stop(): Promise<void>;
  /**
   * The attempt's execution deadline passed: stop renewing at once and abort
   * `signal` with `reason`. A renewal in flight is not awaited; it carries a
   * token the deadline write clears, so it matches nothing.
   */
  timeOut(reason: Error): void;
}

/**
 * Start renewing `lease` every `leaseMs / 3` through `renew`, which resolves
 * `true` iff the renewal matched the row. Each renewal is bounded by
 * `leaseMs / 3`; a timeout counts as a renewal error.
 */
export function startLeaseHeartbeat(input: {
  lease: DispatchLease;
  leaseMs: number;
  renew: (claimedUntil: Date) => Promise<boolean>;
}): DispatchHeartbeat {
  const { lease, leaseMs } = input;
  const interval = Math.max(1, Math.floor(leaseMs / 3));
  const controller = new AbortController();
  const counters: DispatchHeartbeatCounters = { renewErrors: 0 };
  let state: AttemptState = 'running';
  let inFlight: Promise<void> | null = null;
  let lastClaimedUntil = lease.claimedUntil;
  let warnedAtRisk = false;

  const atRisk = (error: unknown) => {
    counters.renewErrors++;
    if (!warnedAtRisk && Date.now() > lastClaimedUntil.getTime()) {
      warnedAtRisk = true;
      logger.warn(
        'dispatch.lease_at_risk: renewals failing past the lease expiry',
        {
          id: lease.id,
          error: error instanceof Error ? error.message : String(error),
        },
      );
    }
  };

  const tick = () => {
    if (state !== 'running' || inFlight) return;
    const claimedUntil = new Date(Date.now() + leaseMs);
    // A renewal still waiting after `interval` counts as a renewal error,
    // but stays the one renewal in flight: no second statement is queued
    // behind it.
    const timer = setTimeout(
      () => atRisk(new Error('lease renewal timed out')),
      interval,
    );
    timer.unref?.();
    inFlight = input
      .renew(claimedUntil)
      .then((matched) => {
        if (state !== 'running') return;
        if (matched) {
          lastClaimedUntil = claimedUntil;
          return;
        }
        state = 'done';
        clearInterval(handle);
        logger.warn('dispatch.lease_lost: lease taken over while running', {
          id: lease.id,
        });
        controller.abort(
          Object.assign(
            new Error(`${DISPATCH_LEASE_LOST}: dispatch ${lease.id}`),
            { code: DISPATCH_LEASE_LOST },
          ),
        );
      })
      .catch(atRisk)
      .finally(() => {
        clearTimeout(timer);
        inFlight = null;
      });
  };

  const handle = setInterval(tick, interval);
  handle.unref?.();

  return {
    signal: controller.signal,
    counters,
    async stop() {
      if (state === 'running') state = 'settling';
      clearInterval(handle);
      if (inFlight) {
        // Bounded: a renewal stuck on a blocked connection does not hold
        // the settle; it is fenced by the token whenever it lands.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          inFlight,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, interval);
          }),
        ]);
        clearTimeout(timer);
      }
      state = 'done';
    },
    timeOut(reason: Error) {
      if (state === 'done') return;
      state = 'done';
      clearInterval(handle);
      controller.abort(reason);
    },
  };
}
