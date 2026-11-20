// Picks the engine's database from the host's `DatabaseConfig`. The engine
// asks this module (never a database) for its dialect, its worker-side handle
// and the few operations that exist on one database only.

import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { EngineError } from '../errors.ts';
import { serveBridge } from './pglite-bridge.ts';
import { postgresDialect } from './postgres-dialect.ts';
import { assertAppSchema } from './schema-name.ts';
import { sqliteDialect } from './sqlite-dialect.ts';
import type {
  DatabaseConfig,
  DatabaseKind,
  EngineDialect,
  WorkerDatabaseConfig,
} from './types.ts';

export type {
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

/** Open the database in a worker (or wherever the runtime runs). */
export async function openDatabase(
  config: WorkerDatabaseConfig,
  dataDir: string,
) {
  // Loaded on use: the host thread never needs the database drivers.
  if (config.kind === 'sqlite')
    return (await import('./sqlite.ts')).openSqlite(dataDir);
  return (await import('./postgres.ts')).openPostgres(config);
}

/**
 * The config as a worker receives it: plain data, with a PGlite instance
 * replaced by one end of a fresh MessagePort whose other end the host serves.
 * `transfer` goes in the worker's `transferList`; `dispose` ends the bridge.
 */
export function forWorker(config: DatabaseConfig): {
  config: WorkerDatabaseConfig;
  transfer: MessagePort[];
  dispose: () => void;
} {
  if (config.kind !== 'pglite')
    return { config, transfer: [], dispose: () => {} };
  const { port1, port2 } = new MessageChannel();
  const stop = serveBridge(config.client, port1);
  return {
    config: {
      kind: 'pglite',
      schema: config.schema,
      port: port2,
    },
    transfer: [port2],
    dispose: stop,
  };
}

/**
 * A method re-reads and writes in one transaction and re-runs if the data
 * moved in between. That check needs the one connection of an embedded
 * database; a server pool at default isolation would not hold it against
 * other connections, and SERIALIZABLE with retry is not built yet (#5183).
 */
export function requireSingleWriter(
  config: { kind: DatabaseKind },
  what: string,
) {
  if (config.kind === 'postgres')
    throw new EngineError(
      `${what} is not supported on a PostgreSQL server yet (it needs serializable isolation)`,
      'refused',
    );
}

/** Refuse what exists on SQLite only (snapshots, copies, drafts, publish, portable export; #5187). */
export function requireSnapshots(config: { kind: DatabaseKind }, what: string) {
  if (config.kind !== 'sqlite')
    throw new EngineError(
      `${what} is not supported on this database yet (it needs SQLite; PostgreSQL is #5187)`,
      'refused',
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
