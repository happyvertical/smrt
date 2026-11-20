// The engine's database seam (#5186). The engine never names a database in its
// own SQL: everything that differs between SQLite and PostgreSQL sits behind
// `EngineDialect`, implemented once per database in `sqlite.ts` and
// `postgres.ts`. `index.ts` picks one from a `DatabaseConfig`.

import type { MessagePort } from 'node:worker_threads';
import type { FieldType } from '../definition.ts';

/** The part of a PGlite instance the engine's bridge drives (see `pglite-bridge.ts`). */
export interface PGliteClient {
  query(sql: string, params?: unknown[]): Promise<any>;
  exec(sql: string): Promise<any[]>;
  transaction<T>(callback: (tx: any) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** How a host reaches a server PostgreSQL (what `@happyvertical/sql` accepts). */
export interface PostgresConnection {
  url?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** Pool size of each app worker. */
  max?: number;
}

/**
 * Which database an app runs on, chosen by the HOST. Default: SQLite in the
 * app's data directory (`app.db`), as the desktop has always done.
 *
 * PostgreSQL layout: one schema per app, addressed by a transaction-local
 * `search_path` with UNQUALIFIED table names. A config without a schema is
 * refused, never run in `public`. The host (or its provisioning) creates the
 * schema; the engine does not.
 */
export type DatabaseConfig =
  | { kind: 'sqlite' }
  | {
      /** A server PostgreSQL. Plain data: each app worker opens its own connection. */
      kind: 'postgres';
      schema: string;
      connection: PostgresConnection;
    }
  | {
      /**
       * An in-process PGlite owned by the host's thread. A PGlite cannot be
       * shared across threads (nor opened twice on one storage), so each app
       * worker reaches it through a MessagePort bridge. Test harness and
       * single-process hosts; the host keeps ownership and closes it.
       */
      kind: 'pglite';
      schema: string;
      client: PGliteClient;
    };

/** What reaches a worker thread: the config with the instance replaced by a port. */
export type WorkerDatabaseConfig =
  | { kind: 'sqlite' }
  | { kind: 'postgres'; schema: string; connection: PostgresConnection }
  | { kind: 'pglite'; schema: string; port: MessagePort };

/** A database the host made for the engine and must close with the host. */
export interface HostDatabase {
  config: DatabaseConfig;
  release?: () => Promise<void>;
}

export type DatabaseKind = DatabaseConfig['kind'];

export interface ColumnInfo {
  /** The declared/catalog type as the database reports it. */
  type: string;
  /** A generated (computed) column. */
  generated: boolean;
}

/** Everything about SQL that differs between the databases the engine runs on. */
export interface EngineDialect {
  readonly name: 'sqlite' | 'postgres';
  /** The value core's DDL planner takes (`planRuntimeModelDDL(…, engine, …)`). */
  readonly ddlEngine: 'sqlite' | 'postgres';
  /** Column type of an app field, matching what core's own DDL creates. */
  columnType(t: FieldType): string;
  /** Comparable family of a column type the database reports. */
  storageFamily(declared: string): string;
  /** `CREATE TABLE IF NOT EXISTS _archive …` */
  readonly archiveTableDDL: string;
  /** Predicate: the column holds a value other than NULL or the empty string. */
  nonEmpty(column: string): string;
  /** `expr` as TEXT (comparing an id column with the archive's TEXT keys). */
  asText(expr: string): string;
  /** `expr` (TEXT, from the archive) as the value to assign to a column of field type `t`. */
  fromText(expr: string, t: FieldType): string;
  /** `CAST(expr AS <column type of t>)`, for comparing an archived value with a column. */
  castTo(expr: string, t: FieldType): string;
  /** Select item for a stored field; an integer past 2^53 must reach JS lossless. `column` is quoted, `alias` is not. */
  storedInteger(column: string, alias: string, isInteger: boolean): string;
  /** Post-process a row selected with `storedInteger`. */
  finishStoredInteger(row: Record<string, unknown>, alias: string): void;
  /** Size in bytes of the text `expr`. */
  byteLength(expr: string): string;
  /** `a IS NOT b` for any types (NULL-safe inequality). */
  isDistinct(a: string, b: string): string;
  /** Options for a transaction that must introspect tables (none on SQLite). */
  readonly transactionOptions: { introspection: true } | undefined;
  /**
   * Statement that stops other connections writing `table` until the
   * transaction ends (a method's write transaction re-reads and compares, which
   * needs the data to hold still). `null` where one connection does that
   * already (SQLite, PGlite): see `needsWriteLock`.
   */
  writeLock(table: string): string;
}
