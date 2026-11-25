// PostgreSQL (server) and PGlite: the engine's dialect for them, the schema
// scope, and how a worker opens either one. Nothing outside `engine/db/` may
// contain PostgreSQL-specific SQL.
//
// Layout (decided, #5183): one PostgreSQL schema per app, addressed by a
// TRANSACTION-LOCAL `search_path` with UNQUALIFIED table names, so core needs
// no schema-qualified names. `scopeDatabase` is the only code that sets it, and
// it sits beneath the `DatabaseInterface` the engine and core receive, so
// every statement (collections, REST, tools, migrations) is scoped, with or
// without a transaction of its own.

import { randomUUID } from 'node:crypto';
import { declareRuntimeManagedDatabase } from '@happyvertical/smrt-core/migrations';
import { getDatabase } from '@happyvertical/sql';
import { EngineError, StaleFenceError } from '../errors.ts';
import {
  BrokeredDatabase,
  brokerClient,
  createTransport,
} from './broker-client.ts';
import { createClaim } from './claim.ts';
import { releaseAppLock, tryAppLock } from './postgres-copy.ts';
import { assertSchemaName } from './schema-name.ts';
import type {
  AppClaim,
  ClaimOptions,
  DatabaseConfig,
  WorkerDatabaseConfig,
} from './types.ts';

type Handle = any;

/** Statements that carry their own scope (they take the same arguments as on the raw handle). */
const STATEMENTS = [
  'query',
  'execute',
  'many',
  'single',
  'pluck',
  'oo',
  'oO',
  'ox',
  'xx',
  'get',
  'list',
  'insert',
  'update',
  'upsert',
  'delete',
  'count',
  'getOrInsert',
  'tableExists',
] as const;

/**
 * Wrap a PostgreSQL/PGlite handle so every statement runs with
 * `search_path = <schema>`, set transaction-locally (`set_config(…, true)`) as
 * the first statement of the transaction it runs in. A statement issued
 * outside any transaction gets a transaction of its own. Fail closed: only
 * the listed operations exist on the result; anything else (`table()`,
 * sessions, schema sync) is absent or throws, never an unscoped path.
 *
 * With `statementTimeoutMs`, the same first statement sets `statement_timeout`
 * transaction-locally too (what `SET LOCAL` does): the server cancels any one
 * statement of the operation that runs longer, the transaction rolls back and
 * the connection goes back to its pool exactly as it was, so the limit never
 * reaches another app's use of that connection.
 *
 * With `fence` (#5190), the same first step also reads the schema's ownership
 * generation (`_app_meta`, key `fence`) `FOR SHARE` and refuses with a
 * `StaleFenceError` unless it equals `fence`. The share lock is held to the
 * end of the transaction, so a publish or restore (which locks every table of
 * the schema exclusively before it moves the generation) either waits for this
 * transaction to finish or runs first and this one fails: no commit can
 * straddle the swap. A session still pointed at the renamed old schema is NOT
 * caught by this (the new number is written only into the new live schema):
 * retiring workers at the swap and revoking the aside's privileges before it
 * is dropped cover it; a cached plan on an old table could write into the
 * aside until that revoke.
 */
export function scopeDatabase<T extends object>(
  db: T,
  schema: string,
  options: {
    statementTimeoutMs?: number;
    fence?: number;
    /**
     * The host's broker already opened the transaction and wrote the search
     * path, the statement timeout, the caller's settings and role and checked
     * the fence (`broker.ts`), so nothing is applied per statement.
     */
    brokered?: boolean;
    /**
     * Report this `url` (a `postgres:` marker without credentials) instead of
     * the adapter's: core treats a handle with no `postgres:` url as embedded
     * (one connection, an in-process write queue), which a broker-backed server
     * is not.
     */
    serverUrl?: string;
  } = {},
): T {
  const path = `"${assertSchemaName(schema)}"`;
  const timeout = options.statementTimeoutMs;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1))
    throw new RangeError('statementTimeoutMs must be a whole ms, 1 or more');
  const raw = db as Handle;
  const fence = options.fence;
  if (fence !== undefined && (!Number.isSafeInteger(fence) || fence < 1))
    throw new RangeError('fence must be a whole number, 1 or more');
  const apply = async (h: Handle) => {
    if (options.brokered) return;
    await (timeout === undefined
      ? h.query(`SELECT set_config('search_path', ?, true)`, [path])
      : h.query(
          `SELECT set_config('search_path', ?, true), set_config('statement_timeout', ?, true)`,
          [path, `${timeout}ms`],
        ));
    if (fence === undefined) return;
    const found = (
      await h.query(`SELECT value FROM _app_meta WHERE key = 'fence' FOR SHARE`)
    ).rows;
    const actual = found.length ? Number(found[0].value) : null;
    if (actual !== fence)
      throw new StaleFenceError(
        `this host no longer owns the app in schema ${schema} (it holds generation ${fence}, the database is at ${actual ?? 'none'}); another host opened it or a publish or restore replaced its data. Reopen the app; nothing was written.`,
        { schema, expected: fence, actual },
      );
  };
  // Core keys per-connection state (shared initialisation, the runtime-managed
  // declaration) on `db.client`, reads its class name, and tells a PostgreSQL
  // adapter by its `query`/`exec`. The real client would run SQL on the
  // default search_path, so the scoped handle and every transaction handle it
  // hands out show one stand-in: the same class name and `query`/`exec` that
  // run scoped, nothing else.
  const token = inertClient(raw.client, (sql: string, values?: unknown[]) =>
    scoped((tx) => (values ? tx.query(sql, values) : tx.query(sql))),
  );
  const guarded = new WeakMap<object, object>();
  const guardTx = (tx: Handle): Handle => {
    const cached = guarded.get(tx);
    if (cached) return cached;
    const g: Handle = new Proxy(tx, {
      get(target, prop) {
        if (prop === 'client') return token;
        if (prop === 'transaction')
          return (cb: (t: Handle) => Promise<unknown>, o?: object) =>
            target.transaction((inner: Handle) => cb(guardTx(inner)), o);
        const value = Reflect.get(target, prop, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    guarded.set(tx, g);
    return g;
  };
  const scoped = <R>(
    run: (tx: Handle) => Promise<R>,
    options?: { introspection?: boolean },
  ): Promise<R> =>
    raw.transaction(async (tx: Handle) => {
      await apply(tx);
      return run(tx);
    }, options);
  const members: Record<string, unknown> = {};
  for (const name of STATEMENTS)
    members[name] = (...args: unknown[]) => scoped((tx) => tx[name](...args));
  members.getTableSchema = (...args: unknown[]) =>
    scoped((tx) => tx.getTableSchema(...args), { introspection: true });
  members.transaction = (
    cb: (tx: Handle) => Promise<unknown>,
    options?: object,
  ) =>
    raw.transaction(async (tx: Handle) => {
      await apply(tx);
      return cb(guardTx(tx));
    }, options);
  members.beginTransaction = async (options?: object) => {
    const h = await raw.beginTransaction(options);
    try {
      await apply(h);
    } catch (e) {
      await h.rollback?.().catch(() => {});
      throw e;
    }
    return guardTx(h);
  };
  members.table = () => {
    throw new EngineError(
      'table() is not available on a schema-scoped database',
      'refused',
    );
  };
  if (token !== undefined) members.client = token;
  return new Proxy(raw, {
    get(target, prop, receiver) {
      if (typeof prop === 'string' && Object.hasOwn(members, prop))
        return members[prop];
      if (prop === 'url' && options.serverUrl !== undefined)
        return options.serverUrl;
      const value = Reflect.get(target, prop, receiver);
      // Only plain values (the adapter's `engine`, `url`, flags) and the
      // table-free operations pass. A function or an object member
      // (`alterTable`, `vector`, `notifications`, ...) would reach the raw
      // handle with the default search_path: hide it, so a caller cannot use
      // it by mistake and a future adapter member is closed by default.
      if (typeof value === 'function')
        return PASS_THROUGH.has(String(prop)) ? value.bind(target) : undefined;
      if (value !== null && typeof value === 'object') return undefined;
      return value;
    },
  }) as T;
}

/** The client stand-in of `scopeDatabase`: class name, `connection` marker, scoped `query`/`exec`. */
function inertClient(
  client: unknown,
  run: (sql: string, values?: unknown[]) => Promise<unknown>,
): object | undefined {
  if (client === null || typeof client !== 'object') return undefined;
  const token: Record<string, unknown> = {
    constructor: (client as { constructor: unknown }).constructor,
    query: run,
    exec: (sql: string) => run(sql),
  };
  if ('connection' in client) token.connection = true;
  return token;
}

/** Operations that do not touch tables, so need no scope. */
export const PASS_THROUGH = new Set(['close']);
export const SCOPED_MEMBERS = new Set<string>([
  ...STATEMENTS,
  'getTableSchema',
  'transaction',
  'beginTransaction',
  'table',
]);

/**
 * The database a worker was told to open, behind the host's broker: one
 * schema-scoped handle over the port, used only inside operations
 * (`BrokeredDatabase.run`). The worker holds no connection and no credentials.
 */
export async function openBrokered(
  config: Extract<WorkerDatabaseConfig, { kind: 'postgres' | 'pglite' }>,
): Promise<BrokeredDatabase> {
  const schema = assertSchemaName(config.schema);
  const transport = await createTransport(config.port);
  const raw: Handle = await getDatabase({
    type: 'pglite',
    client: brokerClient(transport),
    cache: false,
  } as any);
  // A statement runs in the transaction the host opened for the operation.
  // The url is a `postgres:` marker, unique to this worker: core then tracks
  // "system tables exist" once per worker (not once per operation's handle) and
  // does not treat the handle as an embedded, single-connection database.
  const scoped = scopeDatabase(raw, schema, {
    brokered: true,
    serverUrl: `postgres://broker.invalid/${schema}/${randomUUID()}`,
  });
  // As `openAppDatabase` does for SQLite: the engine versions its own schema.
  // The per-operation handles share this handle's `client`, which is what core reads.
  declareRuntimeManagedDatabase(scoped as any, {
    owner: '@happyvertical/smrt-app-shell',
    reason:
      "The engine builds app.db's schema from the app definition with its own versioned steps (_app_meta.version); core's migrate never runs against it.",
  });
  // The schema must exist before anything runs (the host creates it).
  return new BrokeredDatabase(transport, scoped, async (db) => {
    const found = (
      await db.query('SELECT 1 AS x FROM pg_namespace WHERE nspname = ?', [
        schema,
      ])
    ).rows;
    if (!found.length)
      throw new EngineError(
        `schema ${schema} does not exist; the host creates an app's schema before it starts`,
        'refused',
      );
  });
}

/**
 * A connection for the host's own schema work (copy, swap, drop): outside any
 * app schema, so it can name two schemas in one transaction. The host thread
 * opens one briefly; an app worker never does. A PGlite is the host's own
 * instance and stays open.
 */
export async function openAdmin(
  config: Extract<DatabaseConfig, { kind: 'postgres' | 'pglite' }>,
) {
  if (config.kind === 'postgres') {
    const raw: Handle = await getDatabase({
      type: 'postgres',
      ...(config.admin ?? config.connection),
      max: 1,
      // A pool of its own: the shared per-process cache would hand back (and
      // closing would end) a connection another operation is using.
      cache: false,
    } as any);
    return { db: raw, close: () => raw.close?.() };
  }
  const client = config.client;
  // PGlite's own client takes numbered parameters; the helpers use `?`.
  const numbered = (sql: string) => {
    let n = 0;
    return sql.replace(/\?/g, () => `$${++n}`);
  };
  const wrap = (c: {
    query(sql: string, params?: unknown[]): Promise<any>;
  }) => ({
    query: (sql: string, params?: unknown[]) =>
      params?.length ? c.query(numbered(sql), params) : c.query(sql),
  });
  return {
    db: {
      ...wrap(client),
      transaction: <T>(cb: (tx: any) => Promise<T>) =>
        client.transaction((tx) => cb(wrap(tx))),
    },
    close: async () => {},
  };
}

/**
 * Claim an app on a PostgreSQL SERVER for this host (#5187): one host process
 * per app, because a host's start-up recovery and sweep drop the app's side
 * schemas, which a second host's publish or draft would be using. A session
 * advisory lock on a connection of its own (never pooled with anything else,
 * never idle-closed) is held until the returned claim is released or the
 * process ends; a connection the network drops frees the lock server-side.
 * Refuses with an `EngineError` when another host holds it. PGlite is one
 * process's own instance: nothing to claim there.
 *
 * The claim is also where the host's swap and version-store commit run
 * (#5470): see `createClaim`. `connectionTimeoutMillis: 0` is pinned (after
 * the caller's connection options) so a heartbeat queued behind a long
 * transaction on the one connection never times out waiting for it.
 */
export async function claimApp(
  config: DatabaseConfig,
  options?: ClaimOptions,
): Promise<AppClaim | undefined> {
  if (config.kind !== 'postgres') return undefined;
  const raw: Handle = await getDatabase({
    type: 'postgres',
    ...(config.admin ?? config.connection),
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 0,
    cache: false,
  } as any);
  try {
    if (!(await tryAppLock(raw, config.schema)))
      throw new EngineError(
        `another host already runs the app in schema ${config.schema}; one host per app. Stop it, or point this host at its own schema.`,
        'refused',
      );
    // #5486: the server ends a session that goes quiet (the heartbeat speaks
    // every `heartbeatMs`), so a frozen host's ghost session cannot hold the
    // lock or a half-answered COMMIT forever. 0 (no heartbeat) leaves it off.
    // PostgreSQL 14 is the floor (docs/content/postgres-permissions.md).
    const beat = options?.heartbeatMs ?? 5000;
    await raw.query(`SELECT set_config('idle_session_timeout', ?, false)`, [
      `${beat > 0 ? Math.max(30_000, 6 * beat) : 0}ms`,
    ]);
  } catch (e) {
    await raw.close?.().catch(() => {});
    throw e;
  }
  return createClaim(raw, config.schema, options, async () => {
    await releaseAppLock(raw, config.schema).catch(() => {});
    await raw.close?.().catch(() => {});
  });
}
