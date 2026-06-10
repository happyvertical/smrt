import { getDatabase } from '@happyvertical/sql';

/**
 * Configuration for an off-loop liveness ticker (passed via `workerData`).
 */
export interface LivenessTickerOptions {
  /** Database URL the owning runner is using. */
  url: string;
  /** Optional explicit engine/type hint. */
  type?: string;
  /** This runner incarnation's worker key (the `_smrt_workers.worker_id`). */
  workerKey: string;
  /** Lease time-to-live in milliseconds. */
  leaseTtlMs: number;
  /** Renewal cadence in milliseconds. */
  leaseTickMs: number;
}

export interface LivenessTicker {
  /** Stop renewing and close the connection. */
  stop: () => Promise<void>;
}

/**
 * Renew a worker's liveness lease from *outside* the handler event loop.
 *
 * Runs on a `node:worker_threads` thread (or, in tests, directly) with its own
 * database connection, so a CPU-bound synchronous handler on the main thread
 * cannot starve the renewal — the failure mode that made the old heartbeat
 * false-recover running jobs (#1474). A dead process stops renewing and the
 * lease expires within its TTL, which is how recovery detects death.
 */
export async function runLivenessTicker(
  options: LivenessTickerOptions,
): Promise<LivenessTicker> {
  const db = await getDatabase({
    url: options.url,
    type: options.type as 'sqlite' | 'postgres' | 'duckdb' | undefined,
  });

  const renew = async (): Promise<void> => {
    const now = new Date();
    const expiresAt = new Date(
      now.getTime() + options.leaseTtlMs,
    ).toISOString();
    await db.query(
      `UPDATE _smrt_workers
          SET lease_expires_at = ?,
              heartbeat_at = ?
        WHERE worker_id = ?`,
      expiresAt,
      now.toISOString(),
      options.workerKey,
    );
  };

  try {
    // Renew immediately so the lease is fresh the moment the ticker starts.
    await renew();
  } catch (error) {
    // Don't leak the connection if the very first renewal fails.
    await db.close?.().catch(() => {});
    throw error;
  }

  const timer = setInterval(() => {
    renew().catch(() => {
      // Transient renewal failures are tolerated; the next tick retries and
      // the lease TTL absorbs a missed beat (TTL >= 3x tick).
    });
  }, options.leaseTickMs);

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      try {
        await db.close?.();
      } catch {
        // Best-effort connection teardown.
      }
    },
  };
}
