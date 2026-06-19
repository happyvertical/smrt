/**
 * Type definitions for the Dispatch system
 *
 * Provides inter-agent communication through persistent dispatch messages.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
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
   * - `enforced: true`, `tenantId: T` → `(tenant_id = T OR tenant_id IS NULL)`.
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
export interface DispatchBusOptions {
  /** Database configuration or existing interface */
  db?:
    | DatabaseInterface
    | {
        type: 'sqlite' | 'postgres' | 'json' | 'duckdb';
        url: string;
      };
  /** Alias for db - persistence layer configuration */
  persistence?: {
    type: 'sql' | 'json' | 'duckdb';
    url: string;
  };
}
