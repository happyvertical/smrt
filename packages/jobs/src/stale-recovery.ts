export const DEFAULT_TASK_HEARTBEAT_INTERVAL_MS = 30000;
const STALE_HEARTBEAT_GRACE_MULTIPLIER = 3;

/**
 * Keep stale-job recovery aligned with the actual heartbeat cadence.
 *
 * A runner that heartbeats every 30s should not have its jobs recovered after
 * only a few milliseconds just because a smaller override was passed. We keep
 * the explicit stale threshold, but never allow it to fall below three
 * heartbeat intervals.
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
