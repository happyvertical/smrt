export const DEFAULT_TASK_HEARTBEAT_INTERVAL_MS = 30000;
const STALE_HEARTBEAT_GRACE_MULTIPLIER = 3;

/**
 * Default cadence for renewing a worker's liveness lease.
 *
 * Liveness is a per-*worker* lease (see {@link ../smrt-worker.js}), not a
 * per-job heartbeat. The runner renews its lease on this interval; a dead
 * worker stops renewing and its lease expires after {@link DEFAULT_LEASE_TTL_MS}.
 */
export const DEFAULT_LEASE_TICK_MS = 10000;

/**
 * Default time-to-live for a worker liveness lease.
 *
 * A `running` job is only recovered when its owning worker is neither live in
 * this process nor holding a fresh lease in the database. The TTL is the
 * cross-process detection latency for a genuinely dead worker.
 */
export const DEFAULT_LEASE_TTL_MS = 30000;

const LEASE_TTL_GRACE_MULTIPLIER = 3;

/**
 * Keep stale-job recovery aligned with the actual heartbeat cadence.
 *
 * @deprecated Recovery no longer keys on per-job heartbeat staleness (#1474);
 * it keys on worker liveness. Retained for one release for any external caller.
 * Use {@link getEffectiveLeaseTtlMs} with the lease tick instead.
 */
export function getEffectiveStaleJobThresholdMs(
  staleJobThresholdMs: number,
  heartbeatIntervalMs: number,
): number {
  return Math.max(
    staleJobThresholdMs,
    heartbeatIntervalMs * STALE_HEARTBEAT_GRACE_MULTIPLIER,
  );
}

/**
 * Never let a lease expire in fewer than three renewal ticks.
 *
 * A single missed renewal (GC pause, a slow database round-trip) must not be
 * enough to declare a healthy worker dead. Mirrors the floor applied by
 * {@link getEffectiveStaleJobThresholdMs} for the legacy heartbeat path.
 */
export function getEffectiveLeaseTtlMs(
  leaseTtlMs: number,
  leaseTickMs: number,
): number {
  return Math.max(leaseTtlMs, leaseTickMs * LEASE_TTL_GRACE_MULTIPLIER);
}
