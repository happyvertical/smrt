// Picks the engine's database from the host's `DatabaseConfig`. The engine
// asks this module (never a database) for its dialect, its worker-side handle
// and the few operations that exist on one database only.

import { randomBytes } from 'node:crypto';
import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { EngineError } from '../errors.ts';
import {
  Broker,
  pgliteBackend,
  pooledBackend,
  postgresBackendFor,
} from './broker.ts';
import type { BrokerPool } from './pool.ts';
import { postgresDialect } from './postgres-dialect.ts';
import { assertAppSchema, assertSchemaName, sideName } from './schema-name.ts';
import { sqliteDialect } from './sqlite-dialect.ts';
import type {
  AppClaim,
  ClaimOptions,
  DatabaseConfig,
  DatabaseKind,
  EngineDialect,
  PostgresConnection,
  WorkerDatabaseConfig,
} from './types.ts';

export { Broker } from './broker.ts';
export {
  BrokerPool,
  type BrokerPoolOptions,
  POOL_CANCEL_RESERVE,
  POOL_DEFAULTS,
  type PoolDriver,
  type PoolLane,
  type PoolLease,
  type PoolSession,
  type PoolStats,
  type PostgresPoolConnections,
  poolKey,
  postgresPoolDriver,
} from './pool.ts';
export {
  type AppRoles,
  appRoles,
  provisionAppRoles,
  provisionAppRolesSql,
} from './roles.ts';
export {
  assertRuntimeLogin,
  type RuntimeLoginFacts,
  runtimeLoginProblems,
} from './runtime-login.ts';
export type {
  AppClaim,
  ClaimOptions,
  DatabaseConfig,
  EngineDialect,
  HostDatabase,
  PGliteClient,
  PostgresConnection,
  WorkerDatabaseConfig,
} from './types.ts';

/** Refuse a config the host got wrong, before any worker starts. */
export function assertDatabaseConfig(config: DatabaseConfig) {
  if (config.kind === 'sqlite') return;
  if (config.kind !== 'postgres' && config.kind !== 'pglite')
    throw new EngineError(
      `unknown database kind '${String((config as { kind?: unknown }).kind)}'`,
      'refused',
    );
  assertAppSchema(config.schema);
}

export const SQLITE: DatabaseConfig = { kind: 'sqlite' };

export const dialectFor = (config: { kind: DatabaseKind }): EngineDialect =>
  config.kind === 'sqlite' ? sqliteDialect : postgresDialect;

/**
 * The dialect of an open handle (a connection or a transaction), for helpers
 * that receive only the handle. `engine` is set on every adapter's handles.
 */
export const dialectOf = (h: { engine?: string }): EngineDialect =>
  h.engine === 'postgres' || h.engine === 'pglite'
    ? postgresDialect
    : sqliteDialect;

/** Open the database in a worker (or wherever the runtime runs): SQLite directly. */
export async function openDatabase(dataDir: string) {
  // Loaded on use: the host thread never needs the database drivers.
  return (await import('./sqlite.ts')).openSqlite(dataDir);
}

/**
 * Open the broker-backed database of a worker (PostgreSQL or PGlite): the
 * handle exists only inside operations, see `BrokeredDatabase`.
 */
export async function openBrokered(
  config: Extract<WorkerDatabaseConfig, { kind: 'postgres' | 'pglite' }>,
) {
  return (await import('./postgres.ts')).openBrokered(config);
}

export type { BrokeredDatabase } from './broker-client.ts';

/** What a host's `AppWorker` hands `forWorker`. */
export interface ForWorkerOptions {
  /** The app's tenant: every principal the broker is told about must belong to it. */
  tenantId: string;
  statementTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Roll an operation back after this long (ms). */
  opDeadlineMs?: number;
  /** The same for data-lane operations only, when `opDeadlineMs` is not given. */
  dataOpDeadlineMs?: number;
  /**
   * The process's shared connection pool (hosted PostgreSQL): the broker takes
   * its connections there instead of opening a pool of its own.
   */
  pool?: BrokerPool;
}

/**
 * The config as a worker receives it: plain data, with the database replaced
 * by one end of a fresh MessagePort whose other end this thread's `Broker`
 * serves. `transfer` goes in the worker's `transferList`; `dispose` rolls back
 * whatever is still open and ends the bridge. SQLite has no broker.
 */
export function forWorker(
  config: DatabaseConfig,
  options: ForWorkerOptions = { tenantId: 'desktop' },
): {
  config: WorkerDatabaseConfig;
  transfer: MessagePort[];
  dispose: () => Promise<void>;
  broker?: Broker;
} {
  if (config.kind === 'sqlite')
    return { config, transfer: [], dispose: async () => {} };
  const { port1, port2 } = new MessageChannel();
  let closeBackend: (() => Promise<void>) | undefined;
  // A server PostgreSQL's connection is opened with the first operation.
  const backend: import('./broker.ts').BrokerBackend =
    config.kind === 'pglite'
      ? pgliteBackend(config.client)
      : options.pool
        ? pooledBackend(options.pool, options.tenantId)
        : (() => {
            // No shared pool: this worker's own SDK pool, one per credential set.
            const opened = new Map<
              PostgresConnection,
              ReturnType<typeof postgresBackendFor>
            >();
            const closers: Array<() => Promise<void>> = [];
            closeBackend = async () => {
              await Promise.all(closers.map((c) => c()));
            };
            return {
              async open(lane) {
                const connection =
                  lane === 'owner' && config.admin
                    ? config.admin
                    : config.connection;
                let p = opened.get(connection);
                if (!p) {
                  p = postgresBackendFor(connection);
                  opened.set(connection, p);
                  p.then((b) => closers.push(() => b.close()));
                }
                return (await p).open(lane);
              },
            };
          })();
  const broker = new Broker(backend, {
    tenantId: options.tenantId,
    schema: config.schema,
    ...(config.roles ? { roles: config.roles } : {}),
    ...(config.fence === undefined ? {} : { fence: config.fence }),
    ...(options.statementTimeoutMs === undefined
      ? {}
      : { statementTimeoutMs: options.statementTimeoutMs }),
    ...(options.opDeadlineMs === undefined
      ? {}
      : { opDeadlineMs: options.opDeadlineMs }),
    ...(options.dataOpDeadlineMs === undefined
      ? {}
      : { dataOpDeadlineMs: options.dataOpDeadlineMs }),
  });
  const stop = broker.serve(port1);
  return {
    config: {
      kind: config.kind,
      schema: config.schema,
      port: port2,
      ...(options.lockTimeoutMs === undefined
        ? {}
        : { lockTimeoutMs: options.lockTimeoutMs }),
    },
    transfer: [port2],
    dispose: async () => {
      await stop();
      await closeBackend?.();
    },
    broker,
  };
}

/** File name suffix of a standalone copy: a SQLite file, or a PostgreSQL dump. */
export const copySuffix = (config: { kind: DatabaseKind }) =>
  config.kind === 'sqlite' ? 'db' : 'pgdump';

/**
 * A consistent, standalone, restore-only copy of the app's database at `file`:
 * `VACUUM INTO` on SQLite, a dump of the app's schema on PostgreSQL (no live
 * tables added). `db` is the app's own handle.
 */
export async function copyAppDatabase(
  db: any,
  config: WorkerDatabaseConfig,
  file: string,
): Promise<void> {
  if (config.kind === 'sqlite')
    return (await import('./sqlite.ts')).copyDatabaseTo(db, file);
  await (await import('./postgres-copy.ts')).dumpSchema(
    db,
    config.schema,
    file,
    config.lockTimeoutMs,
  );
}

/**
 * Run the host's schema work (copy, swap, drop a schema) on a connection of
 * its own. Loaded on use: a SQLite host never reaches the database drivers.
 */
export async function withSchemaAdmin<T>(
  config: DatabaseConfig,
  work: (db: import('./postgres-copy.ts').SqlDatabase) => Promise<T>,
): Promise<T> {
  if (config.kind === 'sqlite')
    throw new EngineError('schema operations need PostgreSQL', 'refused');
  const { openAdmin } = await import('./postgres.ts');
  const admin = await openAdmin(config);
  try {
    return await work(admin.db);
  } finally {
    await admin.close();
  }
}

/**
 * Claim the app's database for this host (PostgreSQL server only; see
 * `claimApp`). Resolves to the claim, whose `release()` runs when the host
 * closes.
 */
export async function claimAppDatabase(
  config: DatabaseConfig,
  options?: ClaimOptions,
): Promise<AppClaim | undefined> {
  if (config.kind !== 'postgres') return undefined;
  return (await import('./postgres.ts')).claimApp(config, options);
}

/**
 * Take ownership of the app's schema for this host: advance its generation
 * (#5190). PostgreSQL and PGlite only; SQLite keeps its writer lease and has no
 * generation. Resolves to the generation to hold, or `undefined` for SQLite.
 */
export async function acquireAppOwnership(
  config: DatabaseConfig,
  lockTimeoutMs?: number,
): Promise<number | undefined> {
  if (config.kind === 'sqlite') return undefined;
  const { acquireOwnership } = await import('./postgres-copy.ts');
  return withSchemaAdmin(config, (db) =>
    acquireOwnership(db, config.schema, lockTimeoutMs),
  );
}

/** A schema name for a copy of `base` (draft, rehearsal, aside, restore), new on each call. */
export function sideSchemaName(base: string, tag: 'd' | 'r' | 'o' | 'n') {
  return assertSchemaName(sideName(base, tag, randomBytes(4).toString('hex')));
}

/**
 * Take the app's caps lock for the rest of the transaction `h` is in (#5188):
 * a transaction-scoped advisory lock, so it is released by COMMIT or ROLLBACK
 * and never outlives the operation, whatever happens to the connection. Keyed
 * by the app's schema, in a namespace of its own (the host's ownership claim
 * is a session lock in another one). PostgreSQL and PGlite.
 */
export async function takeCapsLock(
  h: { query(sql: string): Promise<unknown> },
  schema: string,
): Promise<void> {
  await h.query(
    `SELECT pg_advisory_xact_lock(hashtext('smrt-app-caps'), hashtext('${assertSchemaName(schema)}'))`,
  );
}

/** A column as `@happyvertical/sql` reports it. */
export interface TableColumn {
  name: string;
  type: string;
  generated: boolean;
}

/**
 * The columns of `table` in declaration order, generated ones included and
 * flagged; `[]` when the table does not exist. Goes through the database
 * adapter's own introspection (`getTableSchema`), which resolves an unqualified
 * name through the current `search_path` on PostgreSQL. A transaction handle
 * needs `{ introspection: true }` on PostgreSQL (`AppRuntime.tx`).
 */
export async function tableColumns(
  h: any,
  table: string,
): Promise<TableColumn[]> {
  if (typeof h.getTableSchema !== 'function')
    throw new EngineError(
      'this database handle cannot introspect tables (open its transaction with { introspection: true })',
      'refused',
    );
  const info = await h.getTableSchema(table, {
    includeGenerated: true,
    includeHidden: true,
  });
  if (!info) return [];
  return Object.entries(
    info.columns as Record<string, { type: string; generated?: boolean }>,
  ).map(([name, c]) => ({
    name,
    type: String(c.type),
    generated: c.generated === true,
  }));
}
