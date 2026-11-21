// The host's handle on one app runtime thread.

import { Worker } from 'node:worker_threads';
import type { AppLimits } from './app-limits.ts';
import {
  type DatabaseConfig,
  forWorker,
  type WorkerDatabaseConfig,
} from './db/index.ts';
import type { AppDefinition, Migration } from './definition.ts';
import { EngineError, StaleFenceError, WorkerCrashedError } from './errors.ts';
import {
  type BootInfo,
  type LimitInfo,
  limitDetails,
  type WorkerOp,
  type WorkerReply,
} from './worker-protocol.ts';

/** The app answered with an error (as opposed to the thread dying). */
export class AppCallError extends Error {
  readonly user: boolean;
  /** The call was refused by the ownership fence (#5190); nothing was written. */
  readonly stale: boolean;
  /** A cap refusal's details (`code: 'app_limit'` and the numbers), else undefined. */
  readonly details?: Record<string, unknown>;
  constructor(
    message: string,
    user: boolean,
    stale = false,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.details = details;
    this.name = 'AppCallError';
    this.user = user;
    this.stale = stale;
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
  /**
   * PostgreSQL only: the server cancels any one statement of an app's
   * operation that runs longer than this (ms), so a runaway query in one app
   * holds neither its worker nor a connection. Set transaction-locally, so it
   * never reaches another app's use of a pooled connection. Default: none.
   * SQLite (the desktop) has no equivalent and ignores it.
   */
  statementTimeoutMs?: number;
  /**
   * PostgreSQL only: a process-wide budget of connections (#5464). Every
   * worker that opens a pool reserves its size here before the thread starts
   * (a refusal throws at once) and returns it when the thread exits, so a
   * swap, a report worker or a rehearsal is counted for as long as it lives.
   * The pool is created at exactly the size reserved.
   */
  connections?: ConnectionBudget;
}

/** What {@link WorkerLimits.connections} asks of the host. */
export interface ConnectionBudget {
  /** The pool size for a worker whose config names none. */
  poolSize: number;
  /** Reserve `n` connections (throws when none are left); returns the release. */
  take(n: number): () => void;
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
  const st = limits.statementTimeoutMs;
  if (st !== undefined && (!Number.isInteger(st) || st < 1))
    throw new RangeError(
      'worker limit statementTimeoutMs must be a whole ms, 1 or more',
    );
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
  /** The connections this worker's pool holds in the host's budget; returned when its thread exits. */
  private budget: (() => void) | null = null;
  /** A handed-over reservation is the host's until `ready` settles: a thread that dies first leaves it parked. */
  private adopting = false;
  private exited = false;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  readonly ready: Promise<BootInfo>;

  /** The host is done with a worker that may have died before it was ready: return what it still holds. */
  settleBudget() {
    this.adopting = false;
    if (!this.exited) return;
    const r = this.budget;
    this.budget = null;
    r?.();
  }

  /**
   * Hand the pool's reserved connections to the caller, so the thread's exit
   * no longer returns them: a host that stops this worker and starts its
   * replacement holds the reservation across the gap, and nothing else can
   * take it. The caller passes it to the next worker (`reservation`) or calls
   * it to give it back. Null when this worker holds none.
   */
  surrenderBudget(): (() => void) | null {
    const r = this.budget;
    this.budget = null;
    return r;
  }

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
      /** Per-app caps the host injected (#5198); none means unlimited. */
      appLimits?: AppLimits;
      /** The host's database choice; default SQLite in `dataDir`. */
      database?: DatabaseConfig;
      /** Longest a schema dump waits for table locks (ms); the host's lock timeout. */
      lockTimeoutMs?: number;
      /**
       * A reservation of this pool's size the caller took over from a retired
       * worker (`surrenderBudget`) and still owns on a failed construction.
       */
      reservation?: () => void;
    },
  ) {
    this.version = init.version;
    const { limits, database, lockTimeoutMs, reservation, ...data } = init;
    // A PGlite instance cannot cross into the thread: the worker gets one end
    // of a port, this thread serves the other (db/pglite-bridge.ts).
    let release: () => void = () => {};
    // A handed-over reservation stays with the caller when this fails.
    const giveBack = () => {
      if (!reservation) release();
    };
    let sized = database;
    if (database?.kind === 'postgres' && limits?.connections) {
      const pool = database.connection.max ?? limits.connections.poolSize;
      release = reservation ?? limits.connections.take(pool);
      this.budget = release;
      this.adopting = !!reservation;
      sized = {
        ...database,
        connection: { ...database.connection, max: pool },
      };
    }
    let db: ReturnType<typeof forWorker>;
    try {
      db = forWorker(sized ?? { kind: 'sqlite' });
    } catch (e) {
      giveBack();
      throw e;
    }
    const config: WorkerDatabaseConfig =
      db.config.kind === 'sqlite'
        ? db.config
        : {
            ...db.config,
            ...(limits?.statementTimeoutMs === undefined
              ? {}
              : { statementTimeoutMs: limits.statementTimeoutMs }),
            ...(lockTimeoutMs === undefined ? {} : { lockTimeoutMs }),
          };
    try {
      this.worker = new Worker(workerUrl, {
        workerData: { appWorker: true, ...data, database: config },
        transferList: db.transfer,
        resourceLimits: resourceLimitsFor(limits),
      });
    } catch (e) {
      giveBack();
      throw e;
    }
    this.worker.once('exit', () => {
      this.exited = true;
      // Died before it was ready: the host takes the reservation back
      // (`surrenderBudget`) for the rollback, or `settleBudget` returns it.
      if (!this.adopting) {
        const r = this.budget;
        this.budget = null;
        r?.();
      }
      db.dispose();
    });
    const die = (e: Error) => {
      this.dead ??= e;
      for (const p of this.pending.values()) p.reject(this.dead);
      this.pending.clear();
    };
    this.ready = new Promise((resolve, reject) => {
      this.worker.once(
        'message',
        (
          m: BootInfo & {
            ready: boolean;
            error?: string;
            user?: boolean;
            stale?: boolean;
            limit?: LimitInfo;
          },
        ) => {
          if (m.ready) resolve(m);
          else if (m.stale) reject(new StaleFenceError(m.error ?? 'stale'));
          else
            reject(
              new EngineError(
                m.error ?? 'the app did not start',
                m.user ? 'refused' : 'migration_failed',
                m.limit ? limitDetails(m.limit) : undefined,
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
    this.ready.then(
      () => {
        this.adopting = false;
      },
      () => {},
    );
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
    } else
      p.reject(
        new AppCallError(
          r.error,
          r.user,
          r.stale === true,
          r.limit ? limitDetails(r.limit) : undefined,
        ),
      );
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
