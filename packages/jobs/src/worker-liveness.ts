import { createId } from '@happyvertical/utils';

/**
 * Worker liveness primitives shared by {@link ../runner.js} and
 * {@link ../schedule-runner.js}.
 *
 * Job recovery keys on whether a job's *owning worker* is alive, never on
 * per-job heartbeat freshness (issue #1474). "Alive" has two independent
 * sources, combined by {@link isWorkerAlive}:
 *
 * 1. **Process-global live set** — an in-memory {@link Set} of worker keys
 *    whose runner is live *in this process*. Checked synchronously, so it can
 *    never be starved by a CPU-bound handler holding the event loop. Covers
 *    every same-process topology (a runner's own jobs, a co-located
 *    ScheduleRunner, a second in-process runner).
 * 2. **Database lease** — a `_smrt_workers` row whose `lease_expires_at` is
 *    still in the future. Covers cross-process recovery. The lease is renewed
 *    by the owning runner; a dead worker stops renewing and its lease expires.
 *
 * The live set takes precedence: a worker live in this process is alive even
 * if its database lease looks stale.
 *
 * Stage 1 compares the lease against the recovering host's clock (the same
 * approach the previous heartbeat recovery used), so it is no more sensitive to
 * clock skew than the code it replaces. Stage 2 moves lease renewal to an
 * off-loop worker thread and switches the comparison to database-side time for
 * multi-machine deployments.
 */

const LIVE_WORKERS_KEY = '__smrtLiveWorkers';

type GlobalWithLiveWorkers = typeof globalThis & {
  [LIVE_WORKERS_KEY]?: Set<string>;
};

function liveWorkers(): Set<string> {
  const g = globalThis as GlobalWithLiveWorkers;
  let set = g[LIVE_WORKERS_KEY];
  if (!set) {
    // Singleton on globalThis so it survives HMR / duplicate module instances,
    // mirroring the ObjectRegistry pattern.
    set = new Set<string>();
    g[LIVE_WORKERS_KEY] = set;
  }
  return set;
}

/** Mark a worker key as live in this process. */
export function registerLiveWorker(workerKey: string): void {
  liveWorkers().add(workerKey);
}

/** Remove a worker key from this process's live set. */
export function unregisterLiveWorker(workerKey: string): void {
  liveWorkers().delete(workerKey);
}

/** Whether a worker key is live in this process. */
export function isLiveWorker(workerKey: string): boolean {
  return liveWorkers().has(workerKey);
}

/** Snapshot of every worker key live in this process. */
export function liveWorkerKeys(): Set<string> {
  return new Set(liveWorkers());
}

/**
 * A worker is alive if it is live in *this* process or holds a fresh database
 * lease in some process. `null`/unknown worker keys are never alive.
 */
export function isWorkerAlive(
  workerKey: string | null | undefined,
  freshLeaseKeys: Set<string>,
): boolean {
  if (!workerKey) return false;
  return isLiveWorker(workerKey) || freshLeaseKeys.has(workerKey);
}

/**
 * Build a per-incarnation-unique worker key.
 *
 * Recovery treats a worker key as the unit of liveness, so the key must be
 * unique per process incarnation: a runner that crashes and restarts under the
 * same configured `id` must get a *new* key, otherwise its orphaned `running`
 * jobs would look owned by the live restart and never be recovered. We append
 * a random token to the (optional) configured id, which also keeps the
 * human-facing runner id stable for logs/events.
 */
export function createWorkerKey(baseId: string): string {
  return `${baseId}~${createId().slice(0, 8)}`;
}
