/**
 * A scripted server-PostgreSQL double for the migration lock's unit lane.
 *
 * It models what the lock module relies on and nothing more: backends with
 * pids, one postmaster start time, the migration key at session and
 * transaction level, the probes, a role default isolation, a controllable
 * `acquireSession()` whose session offers `database()` and `destroy()`, the
 * connection-affinity claim on every handle it makes, statements that never
 * answer, killing a backend, and a log of every statement with its backend.
 * It proves control flow and timing, not PostgreSQL or SDK semantics; the
 * PostgreSQL lanes cover those.
 */

const AFFINITY = Symbol.for('@happyvertical/sql/connection-affinity');

type AffinityKind = 'pool' | 'session' | 'transaction';

/** Stamp `handle` with a connection-affinity claim naming itself. */
export function claimAffinity<T extends object>(
  handle: T,
  kind: AffinityKind,
): T {
  Object.defineProperty(handle, AFFINITY, {
    value: Object.freeze({ kind, handle }),
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return handle;
}

export interface DoubleAnswer {
  rows: Record<string, unknown>[];
  rowCount: number;
}

export interface DoubleBackend {
  pid: number;
  alive: boolean;
  inTransaction: boolean;
  isolation: string;
  /** A statement on this backend is waiting forever. */
  hung: boolean;
}

/** Return an answer (or a promise of one) to override a statement, else `undefined`. */
export type DoubleScript = (
  sql: string,
  backend: DoubleBackend,
) => DoubleAnswer | Promise<DoubleAnswer> | undefined;

export interface PgDoubleOptions {
  url?: string;
  /** Present `engine: 'postgres'` on handles. @default true */
  engine?: boolean;
  serverVersion?: number;
  /** The role's default transaction isolation. @default 'read committed' */
  isolation?: string;
  /** Sessions offer `database()`. @default true */
  sessionDatabase?: boolean;
  /** Sessions offer `destroy()`. @default true */
  sessionDestroy?: boolean;
  /** Handles carry the affinity claim. @default true */
  claims?: boolean;
  /** Called before each checkout resolves; may wait or never resolve. */
  checkout?: () => Promise<void> | void;
  script?: DoubleScript;
}

export const answer = (rows: Record<string, unknown>[] = []): DoubleAnswer => ({
  rows,
  rowCount: rows.length,
});

/** A promise that never settles: a statement whose answer never arrives. */
export const never = <T>() => new Promise<T>(() => {});

export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const isLockStatement = (sql: string) =>
  /pg_postmaster_start_time|pg_try_advisory|pg_locks|idle_session_timeout|^\s*RESET\s/i.test(
    sql,
  );

export function createPgDouble(options: PgDoubleOptions = {}) {
  const url = options.url ?? 'postgres://double/app';
  const started = '2026-11-21 00:00:00.000000+00';
  const version = options.serverVersion ?? 170000;
  const withEngine = options.engine ?? true;
  const claims = options.claims ?? true;
  let nextPid = 1000;
  /** The backend holding the migration key, and at which level. */
  const key: { pid: number | null; level: 'session' | 'transaction' | null } = {
    pid: null,
    level: null,
  };
  const backends = new Map<number, DoubleBackend>();
  const log: Array<{ pid: number; sql: string }> = [];
  const counters = { checkouts: 0, released: 0, destroyed: 0 };
  const sessions: Array<{
    backend: DoubleBackend;
    release: ReturnType<typeof trackCalls>;
    destroy: ReturnType<typeof trackCalls>;
    active: () => boolean;
  }> = [];
  let script = options.script;

  const claim = <T extends object>(handle: T, kind: AffinityKind): T =>
    claims ? claimAffinity(handle, kind) : handle;

  const newBackend = (): DoubleBackend => {
    const backend: DoubleBackend = {
      pid: nextPid++,
      alive: true,
      inTransaction: false,
      isolation: options.isolation ?? 'read committed',
      hung: false,
    };
    backends.set(backend.pid, backend);
    return backend;
  };
  const freeKeyOf = (pid: number, level?: 'session' | 'transaction') => {
    if (key.pid === pid && (!level || key.level === level)) {
      key.pid = null;
      key.level = null;
    }
  };

  const exec = async (
    backend: DoubleBackend,
    sql: string,
  ): Promise<DoubleAnswer> => {
    if (!backend.alive)
      throw new Error('Connection terminated: backend is gone');
    log.push({ pid: backend.pid, sql });
    const scripted = script?.(sql, backend);
    if (scripted !== undefined) return scripted;
    if (/pg_postmaster_start_time/i.test(sql))
      return answer([
        {
          pid: backend.pid,
          started,
          version,
          isolation: backend.isolation,
          held: key.pid === backend.pid,
        },
      ]);
    if (/^\s*SET\s+idle_session_timeout/i.test(sql)) return answer();
    if (/pg_try_advisory_xact_lock\(/i.test(sql)) {
      if (key.pid === null) {
        key.pid = backend.pid;
        key.level = 'transaction';
      }
      return answer([{ acquired: key.pid === backend.pid }]);
    }
    if (/pg_try_advisory_lock\(/i.test(sql)) {
      if (key.pid === null) {
        key.pid = backend.pid;
        key.level = 'session';
      }
      return answer([{ acquired: key.pid === backend.pid }]);
    }
    if (/FROM pg_locks/i.test(sql))
      return answer([{ held: key.pid === backend.pid, pid: backend.pid }]);
    return answer();
  };

  /** A transaction on `backend`: every member uses that backend. */
  const openTransaction = (backend: DoubleBackend) => {
    backend.inTransaction = true;
    log.push({ pid: backend.pid, sql: 'BEGIN' });
    let active = true;
    const end = async (command: 'COMMIT' | 'ROLLBACK') => {
      if (!active) throw new Error('Transaction already ended');
      active = false;
      log.push({ pid: backend.pid, sql: command });
      backend.inTransaction = false;
      freeKeyOf(backend.pid, 'transaction');
    };
    const tx: Record<string, unknown> = {
      url,
      ...(withEngine ? { engine: 'postgres' } : {}),
      query: (sql: string) => exec(backend, sql),
      transaction: async <T>(work: (inner: unknown) => Promise<T>) => work(tx),
      commit: () => end('COMMIT'),
      rollback: () => end('ROLLBACK'),
      isActive: () => active,
    };
    claim(tx, 'transaction');
    return tx as typeof tx & {
      commit: () => Promise<void>;
      rollback: () => Promise<void>;
    };
  };
  const runTransaction = async <T>(
    backend: DoubleBackend,
    work: (tx: any) => Promise<T>,
  ): Promise<T> => {
    const tx = openTransaction(backend);
    try {
      const result = await work(tx);
      await tx.commit();
      return result;
    } catch (error) {
      if ((tx.isActive as () => boolean)()) await tx.rollback();
      throw error;
    }
  };

  const acquireSession = async () => {
    counters.checkouts++;
    await options.checkout?.();
    const backend = newBackend();
    let active = true;
    const release = trackCalls(async () => {
      if (!active) return;
      active = false;
      counters.released++;
      // The bundled adapter's release() queues behind a statement in flight.
      if (backend.hung) await never();
      freeKeyOf(backend.pid);
      backend.alive = false;
    });
    const destroy = trackCalls(() => {
      active = false;
      counters.destroyed++;
      freeKeyOf(backend.pid);
      backend.alive = false;
    });
    const query = (sql: string) =>
      active ? exec(backend, sql) : Promise.reject(new Error('Session ended'));
    const sessionDb: Record<string, unknown> = {
      url,
      ...(withEngine ? { engine: 'postgres' } : {}),
      query,
      transaction: <T>(work: (tx: unknown) => Promise<T>) =>
        active
          ? runTransaction(backend, work)
          : Promise.reject(new Error('Session ended')),
      beginTransaction: async () => {
        if (!active) throw new Error('Session ended');
        return openTransaction(backend);
      },
    };
    claim(sessionDb, 'session');
    const session: Record<string, unknown> = {
      query,
      isActive: () => active && backend.alive,
      release,
    };
    if (options.sessionDestroy ?? true) session.destroy = destroy;
    if (options.sessionDatabase ?? true) session.database = () => sessionDb;
    sessions.push({ backend, release, destroy, active: () => active });
    return session as any;
  };

  const poolBackend = newBackend();
  const pool: Record<string, unknown> = {
    url,
    ...(withEngine ? { engine: 'postgres' } : {}),
    client: { options: { max: 10 } },
    query: (sql: string) => exec(poolBackend, sql),
    transaction: <T>(work: (tx: unknown) => Promise<T>) =>
      runTransaction(newBackend(), work),
    beginTransaction: async () => openTransaction(newBackend()),
    acquireSession,
  };
  claim(pool, 'pool');

  /** An admin session that holds the migration key (an old-release holder). */
  const admin = newBackend();
  return {
    url,
    db: pool as any,
    log,
    counters,
    sessions,
    backends,
    key,
    started,
    setScript(next: DoubleScript | undefined) {
      script = next;
    },
    holdKey() {
      key.pid = admin.pid;
      key.level = 'session';
    },
    releaseKey() {
      freeKeyOf(admin.pid);
    },
    kill(pid: number) {
      const backend = backends.get(pid);
      if (!backend) return;
      backend.alive = false;
      freeKeyOf(pid);
    },
    /** Statements that are not the lock module's own. */
    workStatements: () => log.filter((entry) => !isLockStatement(entry.sql)),
    lockStatements: () => log.filter((entry) => isLockStatement(entry.sql)),
    tryStatements: () =>
      log.filter((entry) => /pg_try_advisory/i.test(entry.sql)),
  };
}

export type PgDouble = ReturnType<typeof createPgDouble>;

function trackCalls<A extends unknown[], R>(fn: (...args: A) => R) {
  const wrapped = (...args: A): R => {
    wrapped.calls++;
    return fn(...args);
  };
  wrapped.calls = 0;
  return wrapped;
}

/** An injectable clock whose sleep advances it. */
export function fakeClock(start = 0) {
  const clock = {
    value: start,
    sleeps: [] as number[],
    now: () => clock.value,
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
      clock.value += ms;
    },
  };
  return clock;
}
