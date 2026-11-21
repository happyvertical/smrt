// The claim connection's transaction wrapper and heartbeat (#5470). The
// connection itself is opened by `claimApp` (postgres.ts); this file is what
// makes a transaction on it prove the claim.
//
// A session advisory lock ends only by unlock or by its session ending, and a
// transaction cannot commit after its session has ended. So a claim
// transaction that proves, inside itself, that THIS session holds the lock ran
// wholly under it, and no takeover (which needs the lock) can have committed
// in between. The pool silently reconnects without the lock after the session
// is terminated, which is why the proof is per transaction and never
// `pg_try_advisory_lock` again.
import { AsyncLocalStorage } from 'node:async_hooks';
import { ClaimLostError, EngineError } from '../errors.ts';
import { appLockMatch } from './postgres-copy.ts';
import type { AppClaim, ClaimOptions } from './types.ts';

type Handle = any;

/** Heartbeats in a row that may fail for a reason other than a missing lock before the claim is given up. */
const MAX_HEARTBEAT_FAILURES = 3;

/** Is `e` the kind of error that says the connection, not the statement, failed? */
function isConnectionError(e: unknown): boolean {
  const x = e as { code?: string; message?: string } | undefined;
  const code = String(x?.code ?? '');
  return (
    code.startsWith('08') ||
    code.startsWith('57P') ||
    ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNREFUSED'].includes(code) ||
    /connection|terminat/i.test(String(x?.message ?? ''))
  );
}

/**
 * Wrap the claim's own connection (`raw`, a pool of one that already holds the
 * lock of `schema`). `prove` replaces the proof where one session cannot tell
 * (tests on an in-process PGlite: `() => true`).
 */
export function createClaim(
  raw: Handle,
  schema: string,
  options: ClaimOptions = {},
  close: () => Promise<void> = async () => {},
  prove?: (tx: Handle) => Promise<boolean>,
): AppClaim {
  const bound = {
    lock: Math.floor(options.lockTimeoutMs ?? 5000),
    statement: Math.floor(options.statementTimeoutMs ?? 10000),
    idle: Math.floor(options.idleInTransactionMs ?? 10000),
  };
  const every = options.heartbeatMs ?? 5000;
  const inside = new AsyncLocalStorage<true>();
  const listeners: Array<(e: Error) => void> = [];
  let lost: Error | null = null;
  let session: string | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;

  const markLost = (e: Error) => {
    if (lost) return;
    lost = e;
    if (timer) clearInterval(timer);
    for (const fn of listeners.splice(0))
      try {
        fn(e);
      } catch {
        /* a listener's failure must not hide the loss */
      }
  };
  const refuse = (): never => {
    throw lost as Error;
  };
  const lostError = (why: string) =>
    new ClaimLostError(
      `this host no longer holds its claim on the app in schema ${schema} (${why}); another host may have taken it over. Reopen the app; this call wrote nothing.`,
    );

  const proof = async (tx: Handle) => {
    if (prove) {
      if (!(await prove(tx)))
        throw lostError('the session lock is not held by this connection');
      return;
    }
    const row = (
      await tx.query(
        `SELECT l.pid AS pid, a.backend_start::text AS started FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid WHERE ${appLockMatch(schema)} AND l.pid = pg_backend_pid()`,
      )
    ).rows[0];
    const id = row ? `${row.pid}@${row.started}` : null;
    if (!id) throw lostError('the session lock is not held by this connection');
    session ??= id;
    if (id !== session) throw lostError('the claim session changed');
  };

  const run = <T>(cb: (tx: Handle) => Promise<T>): Promise<T> =>
    raw.transaction(async (tx: Handle) => {
      await tx.query(
        `SELECT set_config('lock_timeout', ?, true), set_config('statement_timeout', ?, true), set_config('idle_in_transaction_session_timeout', ?, true)`,
        [`${bound.lock}ms`, `${bound.statement}ms`, `${bound.idle}ms`],
      );
      await proof(tx);
      return inside.run(true, () => cb(tx));
    });

  const transaction = async <T>(cb: (tx: Handle) => Promise<T>): Promise<T> => {
    if (lost) refuse();
    if (inside.getStore())
      throw new EngineError(
        'a claim transaction cannot open another on the claim connection',
        'refused',
      );
    try {
      return await run(cb);
    } catch (e) {
      if (e instanceof ClaimLostError) markLost(e);
      else if (isConnectionError(e)) {
        // The connection failed: say at once whether the claim survived it.
        try {
          await run(async () => {});
        } catch (e2) {
          markLost(e2 instanceof ClaimLostError ? e2 : lostError(String(e2)));
          throw lost;
        }
      }
      throw e;
    }
  };

  let beating = false;
  let failures = 0;
  if (every > 0) {
    timer = setInterval(() => {
      if (beating || lost) return;
      beating = true;
      transaction(async () => {})
        .then(() => {
          failures = 0;
        })
        .catch((e) => {
          // A failed proof already lost the claim (`transaction` did it, and a
          // connection error re-proved at once). Any other error may be a
          // blip: lost only when it keeps happening.
          if (e instanceof ClaimLostError) markLost(e);
          else if (++failures >= MAX_HEARTBEAT_FAILURES)
            markLost(lostError(String(e)));
        })
        .finally(() => {
          beating = false;
        });
    }, every);
    timer.unref?.();
  }

  return {
    transaction,
    admin: { transaction },
    get lost() {
      return lost !== null;
    },
    onLost(fn) {
      if (lost) fn(lost);
      else listeners.push(fn);
    },
    async release() {
      if (timer) clearInterval(timer);
      lost ??= lostError('released');
      listeners.length = 0;
      await close();
    },
  };
}

/**
 * Tests only: a claim over `db` (an in-process PGlite handle, one session)
 * whose proof always passes. Production PGlite hosts have no claim; who else
 * could hold the lock needs a second session, which the server-lane tests
 * cover with the real proof.
 */
export function unprovenClaim(db: Handle): AppClaim {
  return createClaim(
    db,
    '',
    { heartbeatMs: 0 },
    async () => {},
    async () => true,
  );
}
