/**
 * Dispatch maintenance (internal): the orphan sweep and lease release.
 *
 * Neither runs inside `process()`; both run from `DispatchBus.maintain()`
 * (the orphan sweep also from the retention `dispatch` task).
 *
 * **Orphan sweep.** A `processing` row whose lease expired more than the
 * orphan threshold ago is failed with `[smrt:DISPATCH_LEASE_ORPHANED]` only
 * when no subscription row can route it: a subscription of any subscriber,
 * enabled or disabled (a disabled subscription is a route that is paused),
 * whose compiled pattern matches the row's type, with a NULL-target row
 * needing a compete subscription and a targeted row needing a subscription
 * of its target. A routed row is never failed here: it waits for its
 * subscriber and is reclaimed under its claim budget.
 *
 * **Tenant scope.** Maintenance is owner-exact: with an active tenant T only
 * rows with `tenant_id = T`, routed only by T's subscriptions, and never
 * global rows; with tenancy on and no active tenant, global rows only; with
 * tenancy off (system scope) every row. A tenant row is routed only by its
 * own tenant's subscriptions. A global row may be routed by a subscription of
 * any tenant, so its route check reads subscriptions across tenants through
 * the one named path {@link DISPATCH_ORPHAN_ROUTE_CHECK}, allowed only when
 * no tenant is active.
 *
 * Every write is one `UPDATE ... RETURNING` that restates its candidate
 * predicate, so a lease renewed between the read and the write is never
 * touched. A subscription created between the read and the write can at
 * worst fail a row that has just become routable: `failed` is retryable,
 * never deleted.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { DispatchSubscriptionCollection } from './collections/DispatchSubscriptions.js';
import { locallyHeldLeaseIds } from './lease-heartbeat.js';
import type { DispatchSubscription } from './models/DispatchSubscription.js';
import { matchesDispatchPattern } from './pattern.js';
import {
  DISPATCH_FAILURE_CODES,
  formatDispatchFailureReason,
} from './reasons.js';
import type { DispatchTenantScope } from './tenant-resolver.js';

/** Default orphan threshold (1 day). */
export const DEFAULT_DISPATCH_ORPHANED_LEASE_AFTER_MS = 86_400_000;

/**
 * The one reviewed cross-tenant read of dispatch maintenance: the route
 * check of a global row reads every tenant's subscriptions.
 */
export const DISPATCH_ORPHAN_ROUTE_CHECK = 'dispatch-orphan-maintenance';

const BATCH = 200;

/** Validate a positive integer millisecond option, naming it. */
export function assertPositiveMs(name: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `DispatchBus: ${name} must be a positive integer number of milliseconds (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * The owner-exact tenant condition of maintenance (never `OR tenant_id IS
 * NULL`), or `null` in system scope.
 */
function maintenanceTenantCondition(
  scope: DispatchTenantScope | undefined,
  bind: (value: unknown) => string,
): string | null {
  if (!scope?.enforced) return null;
  if (scope.tenantId !== null) return `tenant_id = ${bind(scope.tenantId)}`;
  return 'tenant_id IS NULL';
}

/** The row fields the route check reads. */
interface RouteCandidate {
  id: string;
  type: string;
  targetSubscriber: string | null;
  tenantId: string | null;
}

/**
 * Subscriptions that may route rows in `scope`, enabled or disabled. With an
 * active tenant: that tenant's only. Otherwise every tenant's, through the
 * named cross-tenant path.
 */
async function loadRouteSubscriptions(
  db: DatabaseInterface,
  scope: DispatchTenantScope | undefined,
  allowCrossTenant: typeof DISPATCH_ORPHAN_ROUTE_CHECK,
): Promise<DispatchSubscription[]> {
  if (scope?.enforced && scope.tenantId !== null) {
    return DispatchSubscriptionCollection.list(db, false, scope);
  }
  if (allowCrossTenant !== DISPATCH_ORPHAN_ROUTE_CHECK) {
    throw new Error('dispatch maintenance: cross-tenant route check refused');
  }
  // Named cross-tenant read (DISPATCH_ORPHAN_ROUTE_CHECK): a global row may
  // be routed by any tenant's subscription. Only reached with no active
  // tenant; tenant rows are still correlated with their own tenant below.
  return DispatchSubscriptionCollection.list(db, false, undefined);
}

/** Whether any subscription in `subscriptions` can route `row`. */
export function isDispatchRoutable(
  row: RouteCandidate,
  subscriptions: readonly DispatchSubscription[],
): boolean {
  return subscriptions.some(
    (sub) =>
      // A tenant row is routed only by its own tenant's subscriptions; a
      // global row by a subscription of any tenant.
      (row.tenantId === null || sub.tenantId === row.tenantId) &&
      (row.targetSubscriber === null
        ? sub.delivery === 'compete'
        : sub.subscriber === row.targetSubscriber) &&
      // The compiled pattern itself: `sub.matches()` is false for a disabled
      // subscription, which still counts as a route here.
      matchesDispatchPattern(sub.signalType, row.type),
  );
}

function placeholders() {
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  return { params, bind };
}

/** Options of {@link sweepOrphanedDispatchLeases}. */
export interface DispatchOrphanSweepOptions {
  tenantScope?: DispatchTenantScope;
  now?: Date;
  orphanedLeaseAfterMs?: number;
  /**
   * When set (legacy reclaim opted in), rows an older core left
   * `processing` without a lease are also candidates, aged by `updated_at`.
   */
  includeLegacy?: boolean;
  dryRun?: boolean;
  /** Required for the route check of global rows. */
  allowCrossTenant: typeof DISPATCH_ORPHAN_ROUTE_CHECK;
}

/**
 * Fail the abandoned leases no subscription can route.
 *
 * @returns The ids failed (or, under `dryRun`, that would be failed).
 */
export async function sweepOrphanedDispatchLeases(
  db: DatabaseInterface,
  options: DispatchOrphanSweepOptions,
): Promise<string[]> {
  const now = options.now ?? new Date();
  const thresholdMs = assertPositiveMs(
    'orphanedLeaseAfterMs',
    options.orphanedLeaseAfterMs ?? DEFAULT_DISPATCH_ORPHANED_LEASE_AFTER_MS,
  );
  const cutoff = new Date(now.getTime() - thresholdMs).toISOString();
  const held = new Set(locallyHeldLeaseIds(db));

  // The candidate predicate, restated by the write.
  const candidate = (bind: (value: unknown) => string): string[] => {
    const lease = `(claimed_until IS NOT NULL AND claimed_until < ${bind(cutoff)})`;
    const conditions = [
      "status = 'processing'",
      options.includeLegacy
        ? `(${lease} OR (claimed_until IS NULL AND lease_token IS NULL AND updated_at < ${bind(cutoff)}))`
        : lease,
    ];
    const tenant = maintenanceTenantCondition(options.tenantScope, bind);
    if (tenant) conditions.push(tenant);
    return conditions;
  };

  const subscriptions = await loadRouteSubscriptions(
    db,
    options.tenantScope,
    options.allowCrossTenant,
  );

  const orphaned: string[] = [];
  let after: string | null = null;
  for (;;) {
    const { params, bind } = placeholders();
    const conditions = candidate(bind);
    if (after !== null) conditions.push(`CAST(id AS TEXT) > ${bind(after)}`);
    const result = await db.query(
      `SELECT CAST(id AS TEXT) AS id, type, target_subscriber, tenant_id,
              claimed_until IS NULL AS legacy, CAST(updated_at AS TEXT) AS updated_text
         FROM _smrt_dispatch
        WHERE ${conditions.join(' AND ')}
        ORDER BY CAST(id AS TEXT)
        LIMIT ${bind(BATCH)}`,
      ...params,
    );
    const rows = (result.rows ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const id = String(row.id);
      if (held.has(id)) continue;
      // A legacy row whose timestamp JavaScript cannot read is never failed
      // automatically (release only).
      if (
        row.legacy === true ||
        row.legacy === 1 ||
        row.legacy === '1' ||
        row.legacy === 't'
      ) {
        if (Number.isNaN(Date.parse(String(row.updated_text)))) continue;
      }
      const routable = isDispatchRoutable(
        {
          id,
          type: String(row.type),
          targetSubscriber: (row.target_subscriber as string | null) ?? null,
          tenantId: (row.tenant_id as string | null) ?? null,
        },
        subscriptions,
      );
      if (!routable) orphaned.push(id);
    }
    if (rows.length < BATCH) break;
    after = String(rows[rows.length - 1].id);
  }

  if (options.dryRun || orphaned.length === 0) return orphaned;

  const failed: string[] = [];
  const reason = formatDispatchFailureReason(
    DISPATCH_FAILURE_CODES.leaseOrphaned,
    `no subscription routes this row; lease abandoned for more than ${thresholdMs} ms`,
  );
  for (let start = 0; start < orphaned.length; start += BATCH) {
    const ids = orphaned.slice(start, start + BATCH);
    const { params, bind } = placeholders();
    const set = `status = 'failed', last_error = ${bind(reason)},
         updated_at = ${bind(now.toISOString())},
         lease_token = NULL, claimed_until = NULL`;
    const conditions = candidate(bind);
    conditions.push(`id IN (${ids.map(bind).join(', ')})`);
    const result = await db.query(
      `UPDATE _smrt_dispatch SET ${set}
        WHERE ${conditions.join(' AND ')}
        RETURNING id`,
      ...params,
    );
    for (const row of (result.rows ?? []) as Record<string, unknown>[]) {
      failed.push(String(row.id));
    }
  }
  return failed;
}

/** Lease health of `_smrt_dispatch` (`smrt doctor --db`). */
export interface DispatchLeaseInspection {
  /** `processing` rows with no lease: claimed by an older core. */
  legacyProcessing: number;
  /** `processing` rows holding a lease token (live or expired). */
  leasedProcessing: number;
  /** Leased `processing` rows whose lease already expired. */
  expiredLeases: number;
  /** Leased `processing` rows claimed longer than 3x `leaseMs` ago. */
  longLeases: number;
  /**
   * `pending` or `processing` rows no subscription (enabled or disabled)
   * can route; a tenant row counts only its own tenant's subscriptions.
   */
  unrouted: number;
}

/**
 * Count the lease health of every row (system scope; the route check of
 * global rows is the named cross-tenant read). Diagnostic only: writes
 * nothing.
 *
 * @param options.leaseMs - Lease length the long-lease count assumes
 *   (default 300 000).
 */
export async function inspectDispatchLeases(
  db: DatabaseInterface,
  options: { now?: Date; leaseMs?: number } = {},
): Promise<DispatchLeaseInspection> {
  const now = options.now ?? new Date();
  const leaseMs = assertPositiveMs('leaseMs', options.leaseMs ?? 300_000);
  const count = async (where: string, ...params: unknown[]) => {
    const result = await db.query(
      `SELECT COUNT(*) AS total FROM _smrt_dispatch WHERE ${where}`,
      ...params,
    );
    return Number((result.rows ?? [])[0]?.total ?? 0);
  };
  const legacyProcessing = await count(
    "status = 'processing' AND lease_token IS NULL AND claimed_until IS NULL",
  );
  const leasedProcessing = await count(
    "status = 'processing' AND lease_token IS NOT NULL",
  );
  const expiredLeases = await count(
    "status = 'processing' AND lease_token IS NOT NULL AND claimed_until < $1",
    now.toISOString(),
  );
  // A claim writes `updated_at`; renewals move only `claimed_until`.
  const longLeases = await count(
    "status = 'processing' AND lease_token IS NOT NULL AND updated_at < $1",
    new Date(now.getTime() - 3 * leaseMs).toISOString(),
  );

  const subscriptions = await loadRouteSubscriptions(
    db,
    { enforced: false, tenantId: null },
    DISPATCH_ORPHAN_ROUTE_CHECK,
  );
  let unrouted = 0;
  let after: string | null = null;
  for (;;) {
    const { params, bind } = placeholders();
    const conditions = ["status IN ('pending', 'processing')"];
    if (after !== null) conditions.push(`CAST(id AS TEXT) > ${bind(after)}`);
    const result = await db.query(
      `SELECT CAST(id AS TEXT) AS id, type, target_subscriber, tenant_id
         FROM _smrt_dispatch
        WHERE ${conditions.join(' AND ')}
        ORDER BY CAST(id AS TEXT)
        LIMIT ${bind(BATCH)}`,
      ...params,
    );
    const rows = (result.rows ?? []) as Record<string, unknown>[];
    for (const row of rows) {
      const routable = isDispatchRoutable(
        {
          id: String(row.id),
          type: String(row.type),
          targetSubscriber: (row.target_subscriber as string | null) ?? null,
          tenantId: (row.tenant_id as string | null) ?? null,
        },
        subscriptions,
      );
      if (!routable) unrouted++;
    }
    if (rows.length < BATCH) break;
    after = String(rows[rows.length - 1].id);
  }

  return {
    legacyProcessing,
    leasedProcessing,
    expiredLeases,
    longLeases,
    unrouted,
  };
}

/** Release modes of {@link releaseDispatchLeases}. */
export type DispatchReleaseMode = 'expired' | 'afterDrain' | 'legacy';

const RELEASE_MODES: readonly string[] = ['expired', 'afterDrain', 'legacy'];

/** Options of {@link releaseDispatchLeases}. */
export interface DispatchReleaseOptions {
  mode: DispatchReleaseMode;
  tenantScope?: DispatchTenantScope;
  now?: Date;
  dryRun?: boolean;
}

/** Throw unless `mode` is a release mode, naming the option. */
export function assertReleaseMode(mode: unknown): DispatchReleaseMode {
  if (typeof mode !== 'string' || !RELEASE_MODES.includes(mode)) {
    throw new Error(
      `DispatchBus: release must be 'expired', 'afterDrain' or 'legacy' (got ${String(mode)})`,
    );
  }
  return mode as DispatchReleaseMode;
}

/**
 * Move leased `processing` rows back to `pending`, attempt count kept, lease
 * cleared and `[smrt:DISPATCH_RELEASED]` noted in `last_error`:
 *
 * - `expired`: leases that already expired;
 * - `afterDrain`: every lease this release wrote, live or expired (a
 *   timed-out attempt has no token but keeps its expiry). Only after every
 *   worker of this release has stopped;
 * - `legacy`: rows an older core left `processing` without a lease.
 *
 * Owner-exact tenant scope, as the orphan sweep. Rows an attempt in this
 * process is running are never released.
 *
 * @returns The ids released (or, under `dryRun`, that would be).
 */
export async function releaseDispatchLeases(
  db: DatabaseInterface,
  options: DispatchReleaseOptions,
): Promise<string[]> {
  const mode = assertReleaseMode(options.mode);
  const now = options.now ?? new Date();
  const { params, bind } = placeholders();
  const reason = formatDispatchFailureReason(
    DISPATCH_FAILURE_CODES.released,
    `lease released (${mode})`,
  );
  // Bound in statement-text order: SET first, then WHERE.
  const set = options.dryRun
    ? ''
    : `status = 'pending', last_error = ${bind(reason)},
         updated_at = ${bind(now.toISOString())},
         lease_token = NULL, claimed_until = NULL`;
  const conditions = ["status = 'processing'"];
  if (mode === 'expired') {
    conditions.push(
      'claimed_until IS NOT NULL',
      `claimed_until < ${bind(now.toISOString())}`,
    );
  } else if (mode === 'afterDrain') {
    conditions.push('(lease_token IS NOT NULL OR claimed_until IS NOT NULL)');
  } else {
    conditions.push('lease_token IS NULL', 'claimed_until IS NULL');
  }
  const tenant = maintenanceTenantCondition(options.tenantScope, bind);
  if (tenant) conditions.push(tenant);
  const held = locallyHeldLeaseIds(db);
  if (held.length > 0) {
    conditions.push(`id NOT IN (${held.map(bind).join(', ')})`);
  }
  const where = conditions.join(' AND ');
  const result = options.dryRun
    ? await db.query(
        `SELECT CAST(id AS TEXT) AS id FROM _smrt_dispatch WHERE ${where}`,
        ...params,
      )
    : await db.query(
        `UPDATE _smrt_dispatch SET ${set} WHERE ${where} RETURNING id`,
        ...params,
      );
  return ((result.rows ?? []) as Record<string, unknown>[]).map((row) =>
    String(row.id),
  );
}
