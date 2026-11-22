/**
 * Type definitions for the Dispatch system
 *
 * Provides inter-agent communication through persistent dispatch messages.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import type { PostgresTimeoutConfig } from '../postgres-timeouts.js';
import type { DispatchTenantScope } from './tenant-resolver.js';

/**
 * Dispatch message status
 */
export type DispatchStatus = 'pending' | 'processing' | 'completed' | 'failed';

/**
 * Options for emitting a dispatch
 */
export interface DispatchEmitOptions {
  /** Source agent name */
  source?: string;
  /** Source agent instance ID */
  sourceId?: string;
  /** Correlation ID for linking request/response dispatch pairs */
  correlationId?: string;
  /** Additional metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Metadata passed to dispatch handlers
 */
export interface DispatchMetadata {
  /** Dispatch ID */
  id: string;
  /** Signal type (e.g., 'campaign.completed') */
  type: string;
  /** Source agent name */
  source: string;
  /** Source agent instance ID */
  sourceId: string;
  /** Correlation ID for linking request/response dispatch pairs */
  correlationId?: string;
  /** Dispatch creation timestamp */
  createdAt: Date;
  /** Number of processing attempts */
  attempts: number;
  /** Additional metadata from emission */
  metadata: Record<string, unknown>;
  /**
   * Aborted when this attempt's lease is lost (another worker reclaimed the
   * row, or it was swept, retried or released). The bus cannot stop a
   * handler; a handler that keeps running after the abort may overlap the
   * row's next delivery. Present for `process()` handlers; absent for
   * in-memory `on()` handlers.
   */
  signal?: AbortSignal;
}

/**
 * Handler function for in-memory dispatch processing
 */
export type DispatchHandler = (
  payload: unknown,
  metadata: DispatchMetadata,
) => Promise<void>;

/**
 * Options for subscribing to dispatches
 */
export interface DispatchSubscribeOptions {
  /** Signal type pattern (supports wildcards like 'campaign.*') */
  signalType: string;
  /** Subscriber name (usually agent name) */
  subscriber: string;
  /** Handler method name (default: 'handleDispatch') */
  handler?: string;
  /** Whether subscription is enabled */
  enabled?: boolean;
  /** Delivery mode: 'compete' (default, first-to-claim) or 'fanout' (each subscriber gets own copy) */
  delivery?: 'compete' | 'fanout';
}

/**
 * Options for processing dispatches
 */
export interface DispatchProcessOptions {
  /**
   * Maximum number of dispatches to claim (default 100; 0 also means the
   * default, and a negative value means no limit)
   */
  limit?: number;
  /** Signal types to process (default: all subscribed) */
  signalTypes?: string[];
  /** Called once with the counters of this call before `process()` resolves. */
  onStats?: (stats: DispatchProcessStats) => void;
}

/** Counters of one `DispatchBus.process()` call. */
export interface DispatchProcessStats {
  /** Rows this call claimed. */
  claimed: number;
  /** Claimed rows whose handler succeeded and whose outcome this call wrote. */
  completed: number;
  /** Claimed rows whose handler threw and whose outcome this call wrote. */
  failed: number;
  /** Outcomes not written because another writer took the row over. */
  leaseLost: number;
  /** Outcome writes that threw (the row stays leased until it expires). */
  settleErrors: number;
  /** Lease renewals that threw or timed out (retried, never fatal). */
  renewErrors: number;
  /** Rows the bus could not read (skipped). */
  malformed: number;
  /** Rows failed by the claim budget sweep at the start of the call. */
  exhausted: number;
  /** Candidates the in-memory routing recheck rejected (indicates a defect). */
  scanRejects: number;
}

/**
 * Options for listing dispatches
 */
export interface DispatchListOptions {
  /** Filter by status */
  status?: DispatchStatus;
  /** Filter by source agent */
  source?: string;
  /** Filter by signal type */
  type?: string;
  /** Filter by target subscriber */
  targetSubscriber?: string;
  /** Filter by correlation ID */
  correlationId?: string;
  /**
   * Active tenant scope used to filter results (S5 #1398).
   *
   * Supplied by the DispatchBus from the server-derived tenant context — never
   * from external/caller input, so visibility cannot be widened beyond the
   * active scope. Semantics:
   *
   * - omitted / `enforced: false` → no tenant filter (pre-tenancy behavior).
   * - `enforced: true`, `tenantId: T` → `(tenant_id = T OR tenant_id IS NULL)`
   *   inside the collection (processing paths claim global work), but the
   *   public `DispatchBus.list()` narrows this to `tenant_id = T` only: global
   *   (NULL-tenant) rows are system-only on inspection reads (#3301) because
   *   their payload may belong to another tenant.
   * - `enforced: true`, `tenantId: null` → `tenant_id IS NULL` only (fail-closed
   *   global scope when tenancy is on but no tenant context is active).
   *
   * @see {@link DispatchTenantScope}
   */
  tenantScope?: DispatchTenantScope;
  /** Maximum results */
  limit?: number;
  /** Offset for pagination */
  offset?: number;
  /** Order by field */
  orderBy?: string;
}

/**
 * Options for retrying failed dispatches
 */
export interface DispatchRetryOptions {
  /**
   * Retry only rows with fewer attempts than this. Default: the row's claim
   * budget (its stamped `max_attempts`, else the bus `maxAttempts`), so a
   * row that could not be claimed again is not revived.
   */
  maxAttempts?: number;
  /**
   * Set `attempts` back to 0 and retry rows whatever their attempt count:
   * the explicit operator reset for rows whose claim budget is spent.
   * Without it a retried row keeps its attempt count.
   */
  resetAttempts?: boolean;
  /** Only retry dispatches older than this date */
  olderThan?: Date;
  /** Only retry specific signal types */
  signalTypes?: string[];
}

/**
 * Options for cleaning up dispatches
 */
export interface DispatchCleanupOptions {
  /** Delete completed dispatches older than this many days */
  completedOlderThanDays?: number;
  /** Delete failed dispatches older than this many days */
  failedOlderThanDays?: number;
  /**
   * Count the dispatches the cutoffs select without deleting them (#2375).
   * The result reports what a real cleanup with the same options would remove.
   */
  dryRun?: boolean;
}

/**
 * Result of dispatch cleanup
 */
export interface DispatchCleanupResult {
  /** Number of completed dispatches deleted */
  completedDeleted: number;
  /** Number of failed dispatches deleted */
  failedDeleted: number;
}

/**
 * Pool and connection options a {@link DispatchBusOptions} database config may
 * carry. They are forwarded to `getDatabase()` exactly as given, so a bus
 * built from a config honors the same pool cap and timeouts as the rest of the
 * application instead of opening its own default-sized pool (#3046).
 */
export interface DispatchBusPoolOptions {
  /** Caller-owned pool cache identity, forwarded as given. */
  dbid?: string;
  /** Maximum PostgreSQL pool clients. */
  max?: number;
  /** PostgreSQL pool acquisition timeout, in milliseconds. */
  connectionTimeoutMillis?: number;
  /** PostgreSQL idle-client timeout, in milliseconds. */
  idleTimeoutMillis?: number;
  /** Runtime PostgreSQL timeouts (#2377). */
  timeouts?: PostgresTimeoutConfig;
}

/**
 * Options for creating a DispatchBus
 */
export interface DispatchBusOptions {
  /**
   * Database configuration or existing interface.
   *
   * BREAKING (#2861): on PostgreSQL, `initialize()` now serializes its
   * dispatch-table bootstrap against concurrent `DispatchBus` instances
   * using the same advisory-locked transaction `ensureSystemTables()` uses,
   * which requires the handle to implement `beginTransaction()` or
   * `transaction()`. A pre-existing `DatabaseInterface` passed here that
   * implements neither now throws `"Postgres system table bootstrap
   * requires a transaction-capable database adapter"` instead of silently
   * running unguarded, racy DDL. This is a deliberate narrowing: a
   * query-only handle cannot safely take the mutual-exclusion lock the fix
   * for #2861 depends on, so failing closed replaces failing open. SQLite,
   * DuckDB, and JSON adapters are unaffected — only the PostgreSQL path
   * needs the lock.
   */
  db?:
    | DatabaseInterface
    | ({
        type: 'sqlite' | 'postgres' | 'json' | 'duckdb';
        url: string;
      } & DispatchBusPoolOptions);
  /** Alias for db - persistence layer configuration */
  persistence?: {
    type: 'sql' | 'json' | 'duckdb';
    url: string;
  } & DispatchBusPoolOptions;
  /**
   * Bounded retry of the startup bootstrap (opening the database and
   * `initialize()`) on a transient connection failure, such as PostgreSQL or
   * its pooler dropping the first connection after a migration (#3657). Any
   * other error fails at once. Defaults to 5 attempts with exponential backoff
   * from 500 ms, capped at 5 s between attempts; `false` disables it.
   */
  startupRetry?: DispatchBusStartupRetry | false;
  /**
   * Lease length in milliseconds (default 300 000, an integer of at least
   * 1 000). `process()` claims a row with a lease of this length; a row whose
   * lease expired before a later `process()` call began is claimed again by
   * that call (at-least-once delivery).
   */
  leaseMs?: number;
  /**
   * Claim budget per row (default 5, an integer of at least 1). A row is not
   * claimed once `attempts` reached it. It bounds claims, not handler
   * invocations: a process that stops between a claim and its handler still
   * spends one.
   */
  maxAttempts?: number;
  /**
   * Handle for lease renewals and outcome writes, when the bus handle cannot
   * run them independently of a handler (for example a pool a handler may
   * exhaust). Lease statements must commit on their own: never pass a
   * transaction handle. `createDispatchBus` rejects a lease handle that
   * provably cannot (`DISPATCH_LEASE_EXECUTOR_UNSAFE`): a PostgreSQL pool of
   * fewer than two clients, a single PostgreSQL connection, or a
   * transaction handle. Defaults to the bus handle.
   */
  leaseDb?: DatabaseInterface;
}

/**
 * Options for {@link DispatchBus.maintain}.
 */
export interface DispatchMaintainOptions {
  /**
   * Fail abandoned leases that no subscription can route (default `true`).
   * A routed row is never failed by maintenance.
   */
  sweepOrphans?: boolean;
  /**
   * How long a lease must have been expired before the orphan sweep looks
   * at its row, in milliseconds (default one day; a positive integer).
   */
  orphanedLeaseAfterMs?: number;
  /**
   * Also move leased `processing` rows back to `pending`, attempts kept,
   * before the sweep: `'expired'` (leases already expired), `'afterDrain'`
   * (every lease, live or expired; only once every worker of this release
   * has stopped, as in a rollback) or `'legacy'` (rows an older core left
   * `processing` without a lease).
   */
  release?: 'expired' | 'afterDrain' | 'legacy';
  /** Count what would change without writing. */
  dryRun?: boolean;
}

/** Result of {@link DispatchBus.maintain}. */
export interface DispatchMaintainResult {
  /** Rows failed with `[smrt:DISPATCH_LEASE_ORPHANED]` (or that would be). */
  orphaned: number;
  /** Rows moved back to `pending` by `release` (or that would be). */
  released: number;
  dryRun: boolean;
}

/** The lease options of {@link DispatchBusOptions}. */
export type DispatchLeaseOptions = Pick<
  DispatchBusOptions,
  'leaseMs' | 'maxAttempts' | 'leaseDb'
>;

/** Startup retry budget for {@link DispatchBusOptions.startupRetry}. */
export interface DispatchBusStartupRetry {
  /** Total attempts, including the first (default 5, minimum 1). */
  attempts?: number;
  /** Delay before the second attempt, doubled each time (default 500 ms). */
  initialDelayMs?: number;
  /** Upper bound on any one delay (default 5000 ms). */
  maxDelayMs?: number;
}
