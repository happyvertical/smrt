// The main-thread database broker (#5188). An app worker has no database
// connection of its own: every statement goes over a MessagePort to this
// module, which runs it inside ONE transaction per operation. Server
// PostgreSQL and PGlite share it; only the backend (how a connection with an
// open transaction is obtained) differs.
//
// The broker is where trusted main-thread code alone writes the caller's
// identity into the database: when an operation's first statement arrives it
// takes a connection, opens the transaction, writes the transaction-local
// `search_path`, `statement_timeout` and the six `smrt.*` settings of the
// registered principal, then `SET LOCAL ROLE <schema>_r` (or `_o` on the owner
// lane), then checks the ownership fence. The operation's call returns only
// after the broker has committed (`end`). A handle used after that is refused
// (the opId is gone), a worker that dies or an operation that runs past its
// deadline is rolled back, and `DISCARD ALL` runs as its own statement after
// every commit or rollback; a failure there destroys the connection.
//
// The worker and the host are trusted engine code (see engine.md "Trust
// model"): the broker is not a SQL sandbox and inspects no statements.

import type { MessagePort } from 'node:worker_threads';
import {
  CapacityError,
  EngineError,
  NoPrincipalError,
  OperationEndedError,
  PermissionDeniedError,
  StaleFenceError,
} from '../errors.ts';
import type { EnginePrincipal } from '../principal.ts';
import type { BrokerPool, PoolLane } from './pool.ts';
import { type AppRoles, assertAppRoles } from './roles.ts';
import { assertSchemaName } from './schema-name.ts';
import type { PGliteClient, PostgresConnection } from './types.ts';

/** Which database identity an operation runs as. `none` never touches the database. */
export type Lane = 'data' | 'owner' | 'none';

/** One checked-out connection with its transaction already open. */
export interface BrokerTx {
  query(sql: string, params?: unknown[]): Promise<any>;
  exec(sql: string): Promise<any[]>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  /**
   * After commit or rollback: `DISCARD ALL` as its own statement, then hand
   * the connection back. `broken` (a failed commit or rollback) or a failed
   * discard destroys the connection instead of pooling it.
   */
  finish(broken: boolean): Promise<void>;
  /**
   * Ask the server to cancel the statement this transaction is running, from
   * outside its connection (the deadline's first move; the rollback follows).
   * Absent where the backend cannot (PGlite has one connection).
   */
  cancel?(): Promise<void>;
}

export interface BrokerBackend {
  /**
   * Take a connection and begin a transaction on it. Waits when none is free.
   * The owner lane runs on the deployment's admin credentials when it has any.
   */
  open(lane?: Lane): Promise<BrokerTx>;
  close?(): Promise<void>;
}

export interface BrokerBinding {
  /** Every registered principal must belong to this tenant, or the broker refuses before `BEGIN`. */
  tenantId: string;
  schema: string;
  /** `<schema>_r` / `<schema>_o`; absent until the host has provisioned the roles. */
  roles?: AppRoles;
  /** The ownership generation the schema must hold (#5190). */
  fence?: number;
  statementTimeoutMs?: number;
  /** An operation (either lane) open longer than this is rolled back and revoked. */
  opDeadlineMs?: number;
  /**
   * The same for the data lane only, used when `opDeadlineMs` is not given.
   * Owner-lane work (boot, migration, snapshot, copy) legitimately runs long.
   */
  dataOpDeadlineMs?: number;
}

export interface OpRegistration {
  principal: EnginePrincipal;
  lane: Lane;
}

interface OpState {
  reg: OpRegistration;
  tx?: BrokerTx;
  opening?: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  /** Set when the broker rolled the operation back on its own (deadline, worker death). */
  dead?: Error;
  /** The pool had no room: the call fails with this instead of the worker's own error. */
  busy?: CapacityError;
}

/** Wait for `p`, but not past `ms`: true when it settled in time. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p.then(
        () => true,
        () => true,
      ),
      new Promise<boolean>((r) => {
        timer = setTimeout(() => r(false), ms);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** How long a rollback after a deadline may take before the connection is destroyed instead. */
const ROLLBACK_GRACE_MS = 2000;

const plain = (r: any) => ({
  rows: r.rows,
  fields: r.fields,
  affectedRows: r.affectedRows,
  rowCount: r.rowCount,
  command: r.command,
});

/** How many `cause` links of an error cross the port (the rest are dropped). */
const MAX_CAUSE_DEPTH = 4;

/**
 * An error as plain, clonable fields. A structured clone keeps only `name`,
 * `message`, `stack` and `cause` of an Error, so the PostgreSQL fields (`code`
 * the SQLSTATE, `severity`, `constraint`, `table`, `column`, `detail`, ...) are
 * copied by hand, on the error and on each `cause`, where core's db-errors
 * classification also looks for the SQLSTATE.
 */
export const packError = (e: unknown, depth = 0): Record<string, unknown> => {
  const out: Record<string, unknown> = {};
  if (e && typeof e === 'object') {
    for (const k of Object.getOwnPropertyNames(e)) {
      const v = (e as Record<string, unknown>)[k];
      if (typeof v === 'function' || k === 'cause') continue;
      out[k] = v;
    }
    const cause = (e as { cause?: unknown }).cause;
    if (cause && typeof cause === 'object' && depth < MAX_CAUSE_DEPTH)
      out.cause = packError(cause, depth + 1);
  }
  out.message ??= String(e);
  return out;
};

const quoteIdent = (s: string) => `"${s.replace(/"/g, '""')}"`;

let settingsOf:
  | typeof import('@happyvertical/smrt-users/postgres-settings').postgresPrincipalSettings
  | undefined;

/** The six `smrt.*` settings of a principal (the users package's own list, loaded on first use). */
async function principalSettings(p: EnginePrincipal) {
  settingsOf ??= (await import('@happyvertical/smrt-users/postgres-settings'))
    .postgresPrincipalSettings;
  return settingsOf({
    tenantId: p.tenantId,
    userId: p.userId,
    session: null,
    sessionId: null,
    permissions: p.permissions,
    superAdminBypass: false,
    systemContext: p.kind === 'system',
  });
}

export class Broker {
  private ops = new Map<number, OpState>();
  private readonly binding: BrokerBinding;
  private readonly backend: BrokerBackend;

  constructor(backend: BrokerBackend, binding: BrokerBinding) {
    assertSchemaName(binding.schema);
    this.backend = backend;
    this.binding = {
      ...binding,
      ...(binding.roles ? { roles: assertAppRoles(binding.roles) } : {}),
    };
  }

  /** Operations registered and not yet ended (tests, shutdown). */
  get openOps(): number {
    return this.ops.size;
  }

  /** Name an operation before its worker may use the database. A second registration of an id is refused. */
  register(opId: number, reg: OpRegistration): void {
    if (this.ops.has(opId))
      throw new EngineError(
        `operation ${opId} is already registered`,
        'refused',
      );
    this.ops.set(opId, { reg });
  }

  private state(opId: number): OpState {
    const st = this.ops.get(opId);
    if (!st)
      throw new OperationEndedError(
        'the operation is not open: it has ended or was never registered',
      );
    if (st.dead) throw st.dead;
    return st;
  }

  /** Open the operation's transaction (idempotent). Called before the operation's first statement. */
  async open(opId: number): Promise<BrokerTx> {
    const st = this.state(opId);
    if (st.reg.lane === 'none')
      throw new PermissionDeniedError('this operation has no database access');
    if (!st.tx) {
      st.opening ??= this.begin(opId, st);
      try {
        await st.opening;
      } catch (e) {
        st.opening = undefined;
        throw e;
      }
    }
    // Re-read: the operation may have been revoked while it opened.
    const tx = this.state(opId).tx;
    if (!tx) throw new OperationEndedError();
    return tx;
  }

  private async begin(opId: number, st: OpState): Promise<void> {
    const { principal } = st.reg;
    // Before BEGIN: a principal of another app's tenant never gets a connection.
    if (principal.tenantId !== this.binding.tenantId)
      throw new PermissionDeniedError(
        'this principal belongs to another tenant',
      );
    let tx: BrokerTx;
    try {
      tx = await this.backend.open(st.reg.lane);
    } catch (e) {
      // A saturated pool is the server's state: the call fails with it (503).
      if (e instanceof CapacityError) st.busy = e;
      throw e;
    }
    if (this.ops.get(opId) !== st || st.dead) {
      // Ended (or aborted) while waiting for the connection.
      await tx.rollback().catch(() => {});
      await tx.finish(true).catch(() => {});
      throw st.dead ?? new OperationEndedError();
    }
    st.tx = tx;
    // A retry after a refused open found room: the call is no longer a refusal.
    st.busy = undefined;
    try {
      await this.prepare(tx, st.reg);
    } catch (e) {
      await this.discardTx(st, true);
      throw e;
    }
    const opDeadlineMs =
      this.binding.opDeadlineMs ??
      (st.reg.lane === 'data' ? this.binding.dataOpDeadlineMs : undefined);
    if (opDeadlineMs !== undefined) {
      st.timer = setTimeout(
        () =>
          void this.abort(
            opId,
            new EngineError(
              `the operation ran past its ${opDeadlineMs} ms deadline and was rolled back`,
              'refused',
            ),
          ),
        opDeadlineMs,
      );
      st.timer.unref?.();
    }
  }

  /** Settings, role, fence: the first statements of every transaction, written by this thread only. */
  private async prepare(tx: BrokerTx, reg: OpRegistration) {
    const { schema, statementTimeoutMs, fence, roles } = this.binding;
    const settings: Array<[string, string]> = [
      ['search_path', quoteIdent(schema)],
    ];
    if (statementTimeoutMs !== undefined)
      settings.push(['statement_timeout', `${statementTimeoutMs}ms`]);
    settings.push(...(await principalSettings(reg.principal)));
    await tx.query(
      `SELECT ${settings
        .map((_, i) => `set_config($${i * 2 + 1}, $${i * 2 + 2}, true)`)
        .join(', ')}`,
      settings.flat(),
    );
    if (roles)
      await tx.query(
        `SET LOCAL ROLE ${quoteIdent(reg.lane === 'owner' ? roles.owner : roles.app)}`,
      );
    if (fence === undefined) return;
    const found = (
      await tx.query(
        `SELECT value FROM _app_meta WHERE key = 'fence' FOR SHARE`,
      )
    ).rows;
    const actual = found.length ? Number(found[0].value) : null;
    if (actual !== fence)
      throw new StaleFenceError(
        `this host no longer owns the app in schema ${schema} (it holds generation ${fence}, the database is at ${actual ?? 'none'}); another host opened it or a publish or restore replaced its data. Reopen the app; nothing was written.`,
        { schema, expected: fence, actual },
      );
  }

  async query(opId: number, sql: string, params?: unknown[]) {
    return plain(await (await this.open(opId)).query(sql, params));
  }

  async exec(opId: number, sql: string) {
    return (await (await this.open(opId)).exec(sql)).map(plain);
  }

  /**
   * The operation is over: commit (`ok`) or roll back, then clean the
   * connection. Resolves after COMMIT; rejects when the commit failed or the
   * broker had already rolled the operation back. The id is gone afterwards.
   */
  async end(opId: number, ok: boolean): Promise<void> {
    const st = this.ops.get(opId);
    if (!st) return;
    this.ops.delete(opId);
    clearTimeout(st.timer);
    // An open still waiting for its connection resolves (and cleans up) first.
    await st.opening?.catch(() => {});
    if (st.dead) {
      if (ok) throw st.dead;
      return;
    }
    // The worker saw the pool refuse and replied with its own failure; the
    // caller must see the capacity error itself.
    if (st.busy) throw st.busy;
    const tx = st.tx;
    if (!tx) return;
    let failure: unknown;
    let broken = false;
    try {
      if (ok) await tx.commit();
      else await tx.rollback();
    } catch (e) {
      failure = e;
      broken = true;
      await tx.rollback().catch(() => {});
    }
    st.tx = undefined;
    await tx.finish(broken).catch(() => {});
    if (failure) throw failure;
  }

  private async discardTx(
    st: OpState,
    broken: boolean,
    graceMs = Number.POSITIVE_INFINITY,
  ) {
    const tx = st.tx;
    st.tx = undefined;
    if (!tx) return;
    // After a cancel the rollback is quick; if it stalls (the statement did
    // not stop) the connection is destroyed instead of waited for.
    let rolled = true;
    if (Number.isFinite(graceMs)) rolled = await within(tx.rollback(), graceMs);
    else await tx.rollback().catch(() => {});
    await tx.finish(broken || !rolled).catch(() => {});
  }

  /** Roll an operation back on the broker's own authority and revoke it. */
  async abort(opId: number, why: Error): Promise<void> {
    const st = this.ops.get(opId);
    if (!st || st.dead) return;
    st.dead = why;
    clearTimeout(st.timer);
    await st.opening?.catch(() => {});
    // Stop the statement that is running first: the rollback queues behind it
    // on the same connection otherwise.
    if (st.tx?.cancel) await within(st.tx.cancel(), ROLLBACK_GRACE_MS);
    await this.discardTx(st, false, ROLLBACK_GRACE_MS);
  }

  /** Worker death or shutdown: roll back every operation that is still open. */
  async abortAll(
    why: Error = new OperationEndedError('the worker is gone'),
  ): Promise<void> {
    await Promise.all([...this.ops.keys()].map((id) => this.abort(id, why)));
    this.ops.clear();
  }

  /** Serve the worker on the other end of `port`; returns a function that stops serving and rolls everything back. */
  serve(port: MessagePort): () => Promise<void> {
    type Msg =
      | { id: number; kind: 'open'; opId: number }
      | {
          id: number;
          kind: 'q';
          opId: number;
          sql: string;
          params?: unknown[];
        }
      | { id: number; kind: 'x'; opId: number; sql: string };
    port.on('message', (m: Msg) => {
      const run = async (): Promise<unknown> => {
        if (!m || !Number.isInteger(m.opId))
          throw new NoPrincipalError('a database message names no operation');
        if (m.kind === 'open') return void (await this.open(m.opId));
        if (m.kind === 'q' && typeof m.sql === 'string')
          return this.query(m.opId, m.sql, m.params);
        if (m.kind === 'x' && typeof m.sql === 'string')
          return this.exec(m.opId, m.sql);
        throw new EngineError('unknown database message', 'refused');
      };
      run().then(
        (value) => port.postMessage({ id: m?.id, ok: true, value }),
        (e) => port.postMessage({ id: m?.id, ok: false, error: packError(e) }),
      );
    });
    const stopped = () => this.abortAll();
    port.on('close', () => void stopped());
    return async () => {
      port.close();
      await stopped();
    };
  }
}

// ---------- backends ----------

/**
 * A PGlite owned by this thread. It has one connection, so an operation's
 * transaction is PGlite's own held `transaction()`: every other user of the
 * instance (another host, the host's admin work) waits for it exactly as it
 * waits for any transaction. A failed discard or commit poisons the backend
 * (the host's client is never closed here).
 */
export function pgliteBackend(client: PGliteClient): BrokerBackend {
  let poisoned: Error | null = null;
  return {
    async open() {
      if (poisoned) throw poisoned;
      let tx: any;
      let finish: (() => void) | undefined;
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const done = client.transaction(async (t) => {
        await new Promise<void>((fin) => {
          tx = t;
          finish = fin;
          ready();
        });
      });
      done.catch(() => {});
      // A transaction that fails to start settles before it is ready.
      done.then(ready, ready);
      await started;
      if (!tx || !finish) {
        await done;
        throw new EngineError('could not open a transaction', 'refused');
      }
      const release = finish;
      let ended = false;
      const end = async () => {
        if (ended) return;
        ended = true;
        release();
        await done;
      };
      return {
        query: (sql, params) => tx.query(sql, params),
        exec: (sql) => tx.exec(sql),
        async commit() {
          // PostgreSQL answers COMMIT of an aborted transaction with a
          // ROLLBACK tag and no error: probe while there is an error to throw.
          await tx.query('SELECT 1');
          await end();
        },
        async rollback() {
          if (ended) return;
          if (!tx.closed) await tx.rollback().catch(() => {});
          await end().catch(() => {});
        },
        async finish() {
          // A failed commit is the operation's own failure; only a failed
          // discard means the shared connection may hold state.
          try {
            await client.exec('DISCARD ALL');
          } catch (e) {
            poisoned = new EngineError(
              `the database connection was destroyed: ${(e as Error).message}`,
              'refused',
            );
          }
        },
      };
    },
  };
}

/** What `@happyvertical/sql`'s `acquireSession()` returns: a pinned connection. */
export interface PgSession {
  query(
    sql: string,
    ...values: unknown[]
  ): Promise<{ rows: any[]; rowCount?: number }>;
  release(): Promise<void>;
}

/**
 * A server PostgreSQL through pinned session connections: each operation pins
 * one, begins on it, and gives it back (the SDK destroys it on release, so a
 * session's state can never reach the next operation). `cancel`, when given,
 * is how a deadline stops the running statement from outside the connection.
 */
export function postgresBackend(
  acquire: (lane: Lane) => Promise<PgSession>,
  cancel?: (lane: Lane, pid: number) => Promise<void>,
): BrokerBackend {
  return {
    async open(lane = 'data') {
      const s = await acquire(lane);
      let pid: number | undefined;
      try {
        await s.query('BEGIN');
        if (cancel)
          pid = Number(
            (await s.query('SELECT pg_backend_pid() AS pid')).rows[0]?.pid,
          );
      } catch (e) {
        await s.release().catch(() => {});
        throw e;
      }
      return {
        query: async (sql, params) => {
          const r = await s.query(sql, ...(params ?? []));
          return { rows: r.rows, rowCount: r.rowCount };
        },
        exec: async (sql) => {
          const r = await s.query(sql);
          return [{ rows: r.rows, rowCount: r.rowCount }];
        },
        async commit() {
          await s.query('SELECT 1');
          await s.query('COMMIT');
        },
        async rollback() {
          await s.query('ROLLBACK');
        },
        ...(cancel && pid !== undefined && Number.isInteger(pid)
          ? { cancel: () => cancel(lane, pid as number) }
          : {}),
        async finish(broken) {
          if (!broken) {
            try {
              await s.query('DISCARD ALL');
            } catch {
              broken = true;
            }
          }
          // The SDK destroys a session connection on release either way.
          await s.release().catch(() => {});
        },
      };
    },
  };
}

/**
 * The shared pool as a backend: every operation takes a slot for `app` (its
 * tenant) from the process-wide `BrokerPool`, so the pool's caps, queue and
 * timeout bound what the server sees. The slot is returned when the session is
 * released, after the connection's `DISCARD ALL`.
 */
export function pooledBackend(pool: BrokerPool, app: string): BrokerBackend {
  return postgresBackend(
    async (lane) => {
      const poolLane: PoolLane = lane === 'owner' ? 'owner' : 'data';
      const lease = await pool.acquire(app, poolLane);
      return {
        query: (sql, ...values) => lease.session.query(sql, ...values),
        release: () => lease.release(),
      };
    },
    pool.canCancel
      ? (lane, pid) => pool.cancel(lane === 'owner' ? 'owner' : 'data', pid)
      : undefined,
  );
}

/** A backend for a server PostgreSQL named by `connection`; the SDK pool behind it is closed with `close`. */
export async function postgresBackendFor(
  connection: PostgresConnection,
): Promise<BrokerBackend & { close(): Promise<void> }> {
  const { getDatabase } = await import('@happyvertical/sql');
  const raw: any = await getDatabase({
    type: 'postgres',
    ...connection,
    cache: false,
  } as any);
  return {
    ...postgresBackend(() => raw.acquireSession()),
    close: () => raw.close?.(),
  };
}
