/**
 * Dispatch lease statements (internal).
 *
 * A claimed row carries a random `lease_token` and a `claimed_until` expiry.
 * Ownership is the token alone: a holder owns the row iff
 * `lease_token = <its token> AND status = 'processing'`. The clock decides
 * only reclaimability (another worker may claim a row whose lease expired,
 * which replaces the token). Every writer that can intervene between a claim
 * and its settle replaces or clears the token, so a stale holder's renew or
 * settle matches no row.
 *
 * Every statement is one `UPDATE ... RETURNING`; a caller wins iff RETURNING
 * yields its row. Adapter `rowCount` and separate read-backs are never used
 * (DuckDB over-reports affected rows).
 *
 * Times are application-clock ISO strings, as the bus writes them.
 *
 * Placeholders are numbered in the order they appear in the statement text:
 * SQLite allocates `$n` slots by first occurrence.
 */

import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';
import { toSafeInteger } from '../utils/safe-integer.js';
import { pushTenantPredicate } from './collections/Dispatches.js';
import type { DispatchTenantScope } from './tenant-resolver.js';

/** Default lease length (5 minutes). */
export const DEFAULT_DISPATCH_LEASE_MS = 300_000;
/** Smallest accepted lease length. */
export const MIN_DISPATCH_LEASE_MS = 1_000;
/** Default claim budget per row. */
export const DEFAULT_DISPATCH_MAX_ATTEMPTS = 5;

/** Resolved lease settings of one bus. */
export interface DispatchLeaseSettings {
  leaseMs: number;
  maxAttempts: number;
  /** Opt-in execution deadline; unset by default. */
  maxExecutionMs?: number;
  /**
   * Opt-in legacy reclaim: rows an older core left `processing` without a
   * lease become claimable once `updated_at` is this much older than the
   * call start. Unset by default (never reclaimed automatically).
   */
  legacyLeaseGraceMs?: number;
}

/**
 * Validate an execution deadline: an integer of at least `leaseMs`. Throws
 * naming the option.
 */
export function assertMaxExecutionMs(value: unknown, leaseMs: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < leaseMs
  ) {
    throw new Error(
      `DispatchBus: maxExecutionMs must be an integer of at least leaseMs (${leaseMs}) (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * Validate and resolve the lease options of a bus. Throws an error naming the
 * option for an invalid value.
 */
export function resolveDispatchLeaseSettings(
  options: {
    leaseMs?: number;
    maxAttempts?: number;
    maxExecutionMs?: number;
    legacyLeaseGraceMs?: number;
  } = {},
): DispatchLeaseSettings {
  const leaseMs = options.leaseMs ?? DEFAULT_DISPATCH_LEASE_MS;
  if (!Number.isSafeInteger(leaseMs) || leaseMs < MIN_DISPATCH_LEASE_MS) {
    throw new Error(
      `DispatchBus: leaseMs must be an integer of at least ${MIN_DISPATCH_LEASE_MS} (got ${String(options.leaseMs)})`,
    );
  }
  const maxAttempts = options.maxAttempts ?? DEFAULT_DISPATCH_MAX_ATTEMPTS;
  if (!Number.isSafeInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error(
      `DispatchBus: maxAttempts must be an integer of at least 1 (got ${String(options.maxAttempts)})`,
    );
  }
  const settings: DispatchLeaseSettings = { leaseMs, maxAttempts };
  if (options.maxExecutionMs !== undefined) {
    settings.maxExecutionMs = assertMaxExecutionMs(
      options.maxExecutionMs,
      leaseMs,
    );
  }
  if (options.legacyLeaseGraceMs !== undefined) {
    const grace = options.legacyLeaseGraceMs;
    if (!Number.isSafeInteger(grace) || grace < 1) {
      throw new Error(
        `DispatchBus: legacyLeaseGraceMs must be a positive integer number of milliseconds (got ${String(grace)})`,
      );
    }
    settings.legacyLeaseGraceMs = grace;
  }
  return settings;
}

/**
 * The legacy-reclaim cutoff of a call starting at `callStart`, or
 * `undefined` when legacy reclaim is off.
 */
export function legacyLeaseCutoff(
  settings: DispatchLeaseSettings,
  callStart: Date,
): Date | undefined {
  return settings.legacyLeaseGraceMs === undefined
    ? undefined
    : new Date(callStart.getTime() - settings.legacyLeaseGraceMs);
}

/**
 * SQL of the claimable states of a row: `pending`, a lease that expired
 * before the call began and, with legacy reclaim on, a row an older core
 * left `processing` without a lease before the legacy cutoff. With
 * `pendingOnly` (`process({ phases: 'pending' })`), `pending` alone.
 */
export function claimableStateSql(
  bind: (value: unknown) => string,
  callStart: Date,
  legacyCutoff: Date | undefined,
  pendingOnly = false,
): string {
  if (pendingOnly) return "status = 'pending'";
  const branches = [
    "status = 'pending'",
    `(status = 'processing' AND claimed_until IS NOT NULL AND claimed_until < ${bind(callStart.toISOString())})`,
  ];
  if (legacyCutoff) {
    branches.push(
      `(status = 'processing' AND claimed_until IS NULL AND lease_token IS NULL AND updated_at < ${bind(legacyCutoff.toISOString())})`,
    );
  }
  return `(${branches.join(' OR ')})`;
}

/** A lease this process holds on one row. */
export interface DispatchLease {
  id: string;
  token: string;
  /** Attempt count after this claim. */
  attempts: number;
  /** Expiry written by the claim (or the last successful renewal). */
  claimedUntil: Date;
}

function placeholders() {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, bind };
}

/**
 * Claim one row: a `pending` row, a `processing` row whose lease expired
 * before `callStart` or, with legacy reclaim on, a lease-less `processing`
 * row older than the legacy cutoff ({@link claimableStateSql}), while
 * `COALESCE(attempts, 0)` is under the cap. Sets a
 * fresh token and expiry and increments `attempts` in SQL.
 *
 * @returns The lease, or `null` when another worker holds or settled the row,
 *   the row is out of scope, or its claim budget is spent.
 */
export async function claimDispatchLease(
  db: DatabaseInterface,
  input: {
    id: string;
    callStart: Date;
    settings: DispatchLeaseSettings;
    tenantScope?: DispatchTenantScope;
    /** Claim only a `pending` row (no reclaim). */
    pendingOnly?: boolean;
  },
): Promise<DispatchLease | null> {
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + input.settings.leaseMs);
  const token = randomUUID();
  const { params, bind } = placeholders();
  // The row's claim budget is stamped at its first claim, so every bus that
  // claims it later applies the same budget whatever its own maxAttempts.
  const set = `status = 'processing', lease_token = ${bind(token)},
       claimed_until = ${bind(claimedUntil.toISOString())},
       attempts = COALESCE(attempts, 0) + 1,
       updated_at = ${bind(now.toISOString())},
       max_attempts = COALESCE(max_attempts, ${bind(input.settings.maxAttempts)})`;
  const conditions = [
    `id = ${bind(input.id)}`,
    `COALESCE(attempts, 0) < COALESCE(max_attempts, ${bind(input.settings.maxAttempts)})`,
    claimableStateSql(
      bind,
      input.callStart,
      legacyLeaseCutoff(input.settings, input.callStart),
      input.pendingOnly,
    ),
  ];
  pushTenantPredicate(
    conditions,
    params,
    input.tenantScope,
    `$${params.length + 1}`,
  );
  const result = await db.query(
    `UPDATE _smrt_dispatch SET ${set}
     WHERE ${conditions.join(' AND ')}
     RETURNING id, lease_token, attempts`,
    ...params,
  );
  const row = (result.rows ?? [])[0] as
    | { lease_token?: unknown; attempts?: unknown }
    | undefined;
  if (!row || row.lease_token !== token) return null;
  return {
    id: input.id,
    token,
    attempts: toSafeInteger(
      row.attempts as number | string | bigint,
      'Dispatch attempts',
    ),
    claimedUntil,
  };
}

/**
 * Extend a held lease to `claimedUntil`. Fenced by the token: a renewal that
 * arrives after the row was reclaimed, swept, retried or settled matches
 * nothing, whatever the clock says.
 *
 * @returns `true` iff the renewal matched the row.
 */
export async function renewDispatchLease(
  db: DatabaseInterface,
  lease: DispatchLease,
  claimedUntil: Date,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE _smrt_dispatch SET claimed_until = $1
     WHERE id = $2 AND lease_token = $3 AND status = 'processing'
     RETURNING id`,
    claimedUntil.toISOString(),
    lease.id,
    lease.token,
  );
  return (result.rows ?? []).length > 0;
}

/**
 * End a held lease whose opted-in execution deadline passed: clear the token
 * and set the expiry to now, noting `[smrt:DISPATCH_EXECUTION_TIMEOUT]`.
 * Any later renewal or settle of that attempt carries the old token and
 * matches nothing, whatever the clock says; the row is reclaimable by a
 * later `process()` call.
 *
 * @returns `true` iff this call ended the lease.
 */
export async function expireDispatchLease(
  db: DatabaseInterface,
  lease: DispatchLease,
  reason: string,
): Promise<boolean> {
  const result = await db.query(
    `UPDATE _smrt_dispatch SET lease_token = NULL, claimed_until = $1, last_error = $2
     WHERE id = $3 AND lease_token = $4 AND status = 'processing'
     RETURNING id`,
    new Date().toISOString(),
    reason,
    lease.id,
    lease.token,
  );
  return (result.rows ?? []).length > 0;
}

/**
 * Record the outcome of a held lease. Fenced by the token alone (plus the
 * tenant predicate): a holder whose lease expired but was not reclaimed still
 * settles; a holder whose row was reclaimed, swept or retried meanwhile
 * matches nothing.
 *
 * @returns `true` iff this call wrote the outcome.
 */
export async function settleDispatchLease(
  db: DatabaseInterface,
  lease: DispatchLease,
  outcome:
    | { status: 'completed'; subscriber: string }
    | { status: 'failed'; error: string },
  tenantScope?: DispatchTenantScope,
): Promise<boolean> {
  const now = new Date().toISOString();
  const { params, bind } = placeholders();
  const set =
    outcome.status === 'completed'
      ? `status = 'completed', processed_at = ${bind(now)},
         processed_by = ${bind(outcome.subscriber)}, last_error = NULL,
         claimed_until = NULL, updated_at = ${bind(now)}`
      : `status = 'failed', last_error = ${bind(outcome.error)},
         claimed_until = NULL, updated_at = ${bind(now)}`;
  const conditions = [
    `id = ${bind(lease.id)}`,
    `lease_token = ${bind(lease.token)}`,
    "status = 'processing'",
  ];
  pushTenantPredicate(conditions, params, tenantScope, `$${params.length + 1}`);
  const result = await db.query(
    `UPDATE _smrt_dispatch SET ${set}
     WHERE ${conditions.join(' AND ')}
     RETURNING id`,
    ...params,
  );
  return (result.rows ?? []).length > 0;
}
