// The host's handle on one app runtime thread.

import { Worker } from 'node:worker_threads';
import type { AppDefinition, Migration } from './definition.ts';
import { EngineError, WorkerCrashedError } from './errors.ts';
import type { BootInfo, WorkerOp, WorkerReply } from './worker-protocol.ts';

/** The app answered with an error (as opposed to the thread dying). */
export class AppCallError extends Error {
  readonly user: boolean;
  constructor(message: string, user: boolean) {
    super(message);
    this.name = 'AppCallError';
    this.user = user;
  }
}

/** The app's heap is bounded; a runaway app cannot starve the host. */
export const WORKER_HEAP_MB = 512;

/**
 * V8 memory limits of one app worker thread (`resourceLimits`). The young
 * generation is committed up front, and left to itself V8 sizes it at about
 * 48 MiB per thread, empty most of the time; capping it is the cheapest way to
 * shrink an idle worker (#5212). The old generation is the runaway-app bound.
 */
export interface WorkerLimits {
  /** Young generation cap in MiB; `null` leaves V8's own sizing. */
  youngMb?: number | null;
  /** Old generation cap in MiB. Default {@link WORKER_HEAP_MB}. */
  oldMb?: number;
}

/**
 * The default: the desktop keeps a roomy nursery so large lists and bulk
 * writes do not scavenge often. Hosted profiles may pass a smaller one.
 */
export const DEFAULT_WORKER_LIMITS = {
  youngMb: 16,
  oldMb: WORKER_HEAP_MB,
} as const satisfies WorkerLimits;

/** Node's `resourceLimits` for a {@link WorkerLimits} (unset fields use the defaults). */
export function resourceLimitsFor(limits: WorkerLimits = {}) {
  const young =
    limits.youngMb === undefined
      ? DEFAULT_WORKER_LIMITS.youngMb
      : limits.youngMb;
  for (const [name, v] of [
    ['youngMb', young],
    ['oldMb', limits.oldMb],
  ] as const)
    if (v != null && (!Number.isInteger(v) || v < 1))
      throw new RangeError(
        `worker limit ${name} must be a whole MiB, 1 or more`,
      );
  return {
    maxOldGenerationSizeMb: limits.oldMb ?? DEFAULT_WORKER_LIMITS.oldMb,
    ...(young == null ? {} : { maxYoungGenerationSizeMb: young }),
  };
}

export class AppWorker {
  readonly version: number;
  private worker: Worker;
  private next = 1;
  private dead: Error | null = null;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<BootInfo>;

  constructor(
    workerUrl: URL | string,
    init: {
      dataDir: string;
      def: AppDefinition;
      version: number;
      migration?: Migration;
      readOnly?: boolean;
      validateOnly?: boolean;
      limits?: WorkerLimits;
    },
  ) {
    this.version = init.version;
    const { limits, ...data } = init;
    this.worker = new Worker(workerUrl, {
      workerData: { appWorker: true, ...data },
      resourceLimits: resourceLimitsFor(limits),
    });
    const die = (e: Error) => {
      this.dead ??= e;
      for (const p of this.pending.values()) p.reject(this.dead);
      this.pending.clear();
    };
    this.ready = new Promise((resolve, reject) => {
      this.worker.once(
        'message',
        (m: BootInfo & { ready: boolean; error?: string; user?: boolean }) => {
          if (m.ready) resolve(m);
          else
            reject(
              new EngineError(
                m.error ?? 'the app did not start',
                m.user ? 'refused' : 'migration_failed',
              ),
            );
          this.worker.on('message', (r: WorkerReply) => this.settle(r));
        },
      );
      this.worker.once('error', (e) => {
        die(new WorkerCrashedError(`the app stopped: ${e.message}`));
        reject(e);
      });
      this.worker.once('exit', () => {
        die(new WorkerCrashedError());
        reject(new WorkerCrashedError('the app stopped before it was ready'));
      });
    });
    // A rejected `ready` nobody awaited (a worker that died later) is not an error.
    this.ready.catch(() => {});
  }

  get alive() {
    return !this.dead;
  }

  private settle(r: WorkerReply) {
    const p = this.pending.get(r.id);
    if (!p) return;
    this.pending.delete(r.id);
    if (r.ok) p.resolve(r.value);
    else if (r.reportError) {
      // Loaded on the first report error only (#5214).
      const { code, path, reason } = r.reportError;
      import('@happyvertical/smrt-reports').then(
        ({ RuntimeReportError }) =>
          p.reject(
            new RuntimeReportError(
              code,
              path,
              reason ?? 'Report could not run',
            ),
          ),
        (e) => p.reject(e as Error),
      );
    } else p.reject(new AppCallError(r.error, r.user));
  }

  call<T = unknown>(op: WorkerOp, ...args: unknown[]): Promise<T> {
    if (this.dead) return Promise.reject(this.dead);
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      this.worker.postMessage({ id, op, args });
    });
  }

  /** Let in-flight calls finish (up to `ms`), then stop the thread. */
  async retire(ms = 2000) {
    const until = Date.now() + ms;
    while (this.pending.size && !this.dead && Date.now() < until)
      await new Promise((r) => setTimeout(r, 20));
    await this.worker.terminate();
  }

  terminate() {
    return this.worker.terminate();
  }
}
