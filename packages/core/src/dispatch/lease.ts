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
}

/**
 * Validate and resolve the lease options of a bus. Throws an error naming the
 * option for an invalid value.
 */
export function resolveDispatchLeaseSettings(
  options: { leaseMs?: number; maxAttempts?: number } = {},
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
  return { leaseMs, maxAttempts };
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
 * Claim one row: a `pending` row, or a `processing` row whose lease expired
 * before `callStart`, while `COALESCE(attempts, 0)` is under the cap. Sets a
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
  },
): Promise<DispatchLease | null> {
  const now = new Date();
  const claimedUntil = new Date(now.getTime() + input.settings.leaseMs);
  const token = randomUUID();
  const { params, bind } = placeholders();
  const set = `status = 'processing', lease_token = ${bind(token)},
       claimed_until = ${bind(claimedUntil.toISOString())},
       attempts = COALESCE(attempts, 0) + 1,
       updated_at = ${bind(now.toISOString())}`;
  const conditions = [
    `id = ${bind(input.id)}`,
    `COALESCE(attempts, 0) < ${bind(input.settings.maxAttempts)}`,
    `(status = 'pending' OR (status = 'processing' AND claimed_until IS NOT NULL AND claimed_until < ${bind(input.callStart.toISOString())}))`,
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
