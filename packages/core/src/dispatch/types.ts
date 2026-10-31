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
  /** Maximum number of dispatches to process */
  limit?: number;
  /** Signal types to process (default: all subscribed) */
  signalTypes?: string[];
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
  /** Maximum total attempts before giving up */
  maxAttempts?: number;
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
 * Options for creating a DispatchBus
 */
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
}

/** Startup retry budget for {@link DispatchBusOptions.startupRetry}. */
export interface DispatchBusStartupRetry {
  /** Total attempts, including the first (default 5, minimum 1). */
  attempts?: number;
  /** Delay before the second attempt, doubled each time (default 500 ms). */
  initialDelayMs?: number;
  /** Upper bound on any one delay (default 5000 ms). */
  maxDelayMs?: number;
}
