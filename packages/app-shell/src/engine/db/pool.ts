// The one shared connection pool of an engine process (#5188). Every app
// worker's operations reach PostgreSQL through the host thread's `Broker`, and
// every broker takes its connections here, so the process holds a bounded
// number of them whatever the number of open apps:
//
//   - a hard cap on connections in use (`max`), owner-lane connections
//     (the admin credentials) counted the same as data-lane ones;
//   - a cap on one app's concurrent transactions (`perApp`), so a busy app
//     cannot take every slot from the others;
//   - a bounded queue (`maxQueued`): a request that finds it full is refused at
//     once with a `DatabaseBusyError` (503) instead of waiting without end;
//   - an acquire timeout, after which a waiting request is refused the same way.
//
// The pool counts slots and never opens a connection itself: a `PoolDriver`
// does, so the accounting is testable with a fake driver and the PostgreSQL
// driver (`postgresPoolDriver`) stays a thin layer over `@happyvertical/sql`.
// A slot is the right to hold ONE connection and is returned only after the
// connection has been released (or after `releaseTimeoutMs` if a release hangs
// behind a statement that will not stop), so `max` bounds what the server sees.

import { DatabaseBusyError, EngineError } from '../errors.ts';
import type { PostgresConnection } from './types.ts';

/** Which credentials a connection uses: the runtime login, or the admin (owner) ones. */
export type PoolLane = 'data' | 'owner';

/** One pinned connection (what `@happyvertical/sql`'s `acquireSession()` returns). */
export interface PoolSession {
  query(
    sql: string,
    ...values: unknown[]
  ): Promise<{ rows: any[]; rowCount?: number }>;
  /** Give the connection back (the SDK destroys it); never throws. */
  release(): Promise<void>;
}

export interface PoolDriver {
  /** Open one connection for `lane`. */
  connect(lane: PoolLane): Promise<PoolSession>;
  /**
   * Ask the server to cancel the statement running on backend `pid`, on a
   * connection of its own that is outside the slot count (the pool reserves
   * one for it). Absent: a deadline can only roll the transaction back.
   */
  cancel?(lane: PoolLane, pid: number): Promise<void>;
  close?(): Promise<void>;
}

export interface BrokerPoolOptions {
  /** Most connections in use at once (data and owner lanes together). */
  max: number;
  /** Most connections one app may hold at once. */
  perApp: number;
  /** Most requests waiting for a slot; one more is refused at once. */
  maxQueued: number;
  /** A request waits at most this long (ms) for a slot, then is refused. */
  acquireTimeoutMs: number;
  /** A release that has not finished after this long (ms) frees its slot anyway. Default 5000. */
  releaseTimeoutMs?: number;
}

/** Defaults of a hosted process (the design's proposed ones). */
export const POOL_DEFAULTS = {
  max: 10,
  perApp: 4,
  maxQueued: 64,
  acquireTimeoutMs: 5000,
  releaseTimeoutMs: 5000,
} as const;

/** The connections held outside the slot count: one for cancelling a stuck statement. */
export const POOL_CANCEL_RESERVE = 1;

/** A held slot and the connection on it. */
export interface PoolLease {
  readonly session: PoolSession;
  readonly lane: PoolLane;
  /** Release the connection, then the slot; safe to call twice. */
  release(): Promise<void>;
}

export interface PoolStats {
  max: number;
  inUse: number;
  queued: number;
  /** Connections in use per app key. */
  perApp: Record<string, number>;
}

interface Waiter {
  app: string;
  lane: PoolLane;
  resolve: (lease: PoolLease) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

function whole(name: string, v: number, min: number) {
  if (!Number.isSafeInteger(v) || v < min)
    throw new RangeError(`pool ${name} must be a whole number, ${min} or more`);
}

export class BrokerPool {
  readonly options: Required<BrokerPoolOptions>;
  private inUse = 0;
  private byApp = new Map<string, number>();
  private queue: Waiter[] = [];
  private closed = false;
  private readonly driver: PoolDriver;

  constructor(driver: PoolDriver, options: BrokerPoolOptions) {
    this.driver = driver;
    whole('max', options.max, 1);
    whole('perApp', options.perApp, 1);
    whole('maxQueued', options.maxQueued, 0);
    whole('acquireTimeoutMs', options.acquireTimeoutMs, 1);
    const releaseTimeoutMs =
      options.releaseTimeoutMs ?? POOL_DEFAULTS.releaseTimeoutMs;
    whole('releaseTimeoutMs', releaseTimeoutMs, 1);
    this.options = { ...options, releaseTimeoutMs };
  }

  get stats(): PoolStats {
    return {
      max: this.options.max,
      inUse: this.inUse,
      queued: this.queue.length,
      perApp: Object.fromEntries(this.byApp),
    };
  }

  private canTake(app: string) {
    return (
      this.inUse < this.options.max &&
      (this.byApp.get(app) ?? 0) < this.options.perApp
    );
  }

  /**
   * A connection of `lane` for `app`. Waits (bounded) when the pool or the
   * app is at its cap; refuses with a `DatabaseBusyError` when the queue is
   * full or the wait times out.
   */
  async acquire(app: string, lane: PoolLane = 'data'): Promise<PoolLease> {
    if (this.closed) throw new EngineError('the pool is closed', 'refused');
    // A queued request is waiting only because its app (or the pool) is at a
    // cap, and a freed slot goes to the queue before anyone else sees it, so a
    // request that fits now never jumps a request that could have been served.
    if (this.canTake(app)) return this.open(app, lane);
    if (this.queue.length >= this.options.maxQueued)
      throw new DatabaseBusyError(
        'the database is busy: too many operations are waiting for a connection; try again',
      );
    return new Promise<PoolLease>((resolve, reject) => {
      const w: Waiter = {
        app,
        lane,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.queue = this.queue.filter((x) => x !== w);
          reject(
            new DatabaseBusyError(
              'the database is busy: timed out waiting for a connection; try again',
            ),
          );
          // A waiter that left may have been the only thing blocking others.
          this.pump();
        }, this.options.acquireTimeoutMs),
      };
      w.timer.unref?.();
      this.queue.push(w);
    });
  }

  /** Take the slot now, then open the connection; the slot goes back if that fails. */
  private async open(app: string, lane: PoolLane): Promise<PoolLease> {
    this.inUse++;
    this.byApp.set(app, (this.byApp.get(app) ?? 0) + 1);
    let session: PoolSession;
    try {
      session = await this.driver.connect(lane);
    } catch (e) {
      this.free(app);
      throw e;
    }
    let released: Promise<void> | undefined;
    const { releaseTimeoutMs } = this.options;
    const release = () => {
      released ??= (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            session.release().catch(() => {}),
            new Promise<void>((r) => {
              timer = setTimeout(r, releaseTimeoutMs);
              timer.unref?.();
            }),
          ]);
        } finally {
          clearTimeout(timer);
          this.free(app);
        }
      })();
      return released;
    };
    return { session, lane, release };
  }

  private free(app: string) {
    this.inUse = Math.max(0, this.inUse - 1);
    const n = (this.byApp.get(app) ?? 1) - 1;
    if (n <= 0) this.byApp.delete(app);
    else this.byApp.set(app, n);
    this.pump();
  }

  /** Hand free slots to waiting requests, oldest first, skipping apps at their cap. */
  private pump() {
    if (this.closed) return;
    for (let i = 0; i < this.queue.length && this.inUse < this.options.max; ) {
      const w = this.queue[i];
      if (!this.canTake(w.app)) {
        i++;
        continue;
      }
      this.queue.splice(i, 1);
      clearTimeout(w.timer);
      // Reserve the slot synchronously so a later pump cannot give it twice.
      this.open(w.app, w.lane).then(w.resolve, w.reject);
    }
  }

  /** Cancel the statement running on backend `pid` (see `PoolDriver.cancel`). */
  async cancel(lane: PoolLane, pid: number): Promise<void> {
    await this.driver.cancel?.(lane, pid);
  }

  get canCancel(): boolean {
    return typeof this.driver.cancel === 'function';
  }

  /** Refuse every waiter and close the driver. Connections still held are the holders' to release. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const waiting = this.queue;
    this.queue = [];
    for (const w of waiting) {
      clearTimeout(w.timer);
      w.reject(new EngineError('the pool is closed', 'refused'));
    }
    await this.driver.close?.();
  }
}

// ---------- the PostgreSQL driver ----------

export interface PostgresPoolConnections {
  /** The runtime login's connection (data lane). */
  connection: PostgresConnection;
  /** The admin / owner credentials (owner lane); absent: the owner lane uses `connection`. */
  admin?: PostgresConnection;
}

/**
 * Connections to a server PostgreSQL through the SDK's session API, opened on
 * first use. Each lane's SDK pool is sized to the slot count (plus the cancel
 * reserve on the data lane), so the SDK never queues behind the pool's own
 * accounting. The SDK destroys a session connection when it is released, so no
 * connection state can reach the next operation.
 */
export function postgresPoolDriver(
  config: PostgresPoolConnections,
  max: number,
): PoolDriver {
  type Handle = {
    acquireSession(): Promise<PoolSession>;
    close?(): Promise<void>;
  };
  const handles = new Map<PoolLane, Promise<Handle>>();
  const handle = (lane: PoolLane): Promise<Handle> => {
    let h = handles.get(lane);
    if (!h) {
      const connection =
        lane === 'owner' && config.admin ? config.admin : config.connection;
      h = (async () => {
        const { getDatabase } = await import('@happyvertical/sql');
        return (await getDatabase({
          type: 'postgres',
          ...connection,
          max: max + POOL_CANCEL_RESERVE,
          // A pool of its own: the shared per-process cache would hand back
          // (and closing would end) a connection another user holds.
          cache: false,
        } as never)) as unknown as Handle;
      })();
      handles.set(lane, h);
      h.catch(() => handles.delete(lane));
    }
    return h;
  };
  return {
    async connect(lane) {
      return (await handle(lane)).acquireSession();
    },
    async cancel(lane, pid) {
      const s = await (await handle(lane)).acquireSession();
      try {
        await s.query('SELECT pg_cancel_backend($1)', pid);
      } finally {
        await s.release();
      }
    },
    async close() {
      const open = [...handles.values()];
      handles.clear();
      await Promise.all(
        open.map(async (h) => (await h.catch(() => null))?.close?.()),
      );
    },
  };
}

/** A stable identity of the server a config reaches, to share one pool per server. */
export function poolKey(config: PostgresPoolConnections): string {
  const id = (c: PostgresConnection | undefined) =>
    c
      ? JSON.stringify([
          c.url ?? null,
          c.host ?? null,
          c.port ?? null,
          c.database ?? null,
          c.user ?? null,
        ])
      : '';
  return `${id(config.connection)}|${id(config.admin)}`;
}
