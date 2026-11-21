// The shape every database gives the portable export (#5193): the same logical
// view of one app's tables whether the app runs on SQLite (`app.db`) or in a
// PostgreSQL schema, so a bundle from either can be read, verified and
// written into either. Each database's SQL lives in its own file
// (`sqlite-portable.ts`, `postgres-portable.ts`); nothing here names one.

import { EngineError } from '../errors.ts';

/**
 * What a column holds, as far as moving it between databases cares. `boolean`
 * and `integer` travel as numbers (SQLite stores a boolean as 0/1), `date` as
 * the text the database stores (PostgreSQL: UTC ISO-8601), `json` as JSON
 * text, `bytes` as base64.
 */
export type ColumnFamily =
  | 'integer'
  | 'real'
  | 'boolean'
  | 'date'
  | 'json'
  | 'bytes'
  | 'text';

export const COLUMN_FAMILIES: readonly ColumnFamily[] = [
  'integer',
  'real',
  'boolean',
  'date',
  'json',
  'bytes',
  'text',
];

export interface PortableColumn {
  name: string;
  family: ColumnFamily;
}

/** A value as a database hands it over: null, a number, text, or bytes. */
export type LogicalValue = null | number | string | Uint8Array;
export type LogicalRow = Record<string, LogicalValue>;

/** One database, in one transaction, as the portable export sees it. */
export interface PortableDb {
  readonly dialect: 'sqlite' | 'postgres';
  /** Real tables except the engine's meta record; refuses a kind it cannot move. */
  tables(): Promise<string[]>;
  /** Stored (not generated) columns in declaration order; `[]` when the table is absent. */
  columns(table: string): Promise<PortableColumn[]>;
  /** Every row. An integer past 2^53 is refused. */
  rows(table: string, columns: PortableColumn[]): Promise<LogicalRow[]>;
  count(table: string): Promise<number>;
  /** `_app_meta`: the recorded version and definition text. */
  meta(): Promise<{ version: unknown; definition: unknown } | null>;
  /** The engine's `_archive` (undo data) with its own DDL and index, when the engine did not make it. */
  createArchive(): Promise<void>;
  /** A table the definition does not describe (an archived one kept for undo). */
  create(table: string, columns: PortableColumn[]): Promise<void>;
  /**
   * A column the definition does not build (a hidden field keeps its column and
   * data, but the engine registers only visible fields): added to an existing table.
   */
  addColumn(table: string, column: PortableColumn): Promise<void>;
  insert(
    table: string,
    columns: PortableColumn[],
    rows: LogicalRow[],
  ): Promise<void>;
  /** After a table's rows are in (PostgreSQL: advance identity sequences). */
  finish(table: string, columns: PortableColumn[]): Promise<void>;
}

/** Plain identifiers only: a bundle is untrusted input and names go into SQL. */
export const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,62}$/;

export function assertIdentifier(name: unknown, what: string): string {
  if (typeof name !== 'string' || !IDENTIFIER.test(name))
    throw new EngineError(`${what} '${String(name)}' is not usable`, 'refused');
  return name;
}

/**
 * An integer column's value as the database returned it (a number, a bigint,
 * or the digits a server pool returns). Past 2^53 it is refused, never rounded
 * (a digest over a rounded value would call two different rows the same). A
 * value that is not a whole number (SQLite lets any column hold anything) is
 * returned as it is.
 */
export function integerValue(value: unknown, where: string): LogicalValue {
  if (value === null || value === undefined) return null;
  const refuse = () =>
    new EngineError(
      `${where} holds an integer beyond 2^53, which a portable export cannot carry exactly`,
      'refused',
    );
  if (typeof value === 'bigint') {
    if (value > 9007199254740991n || value < -9007199254740991n) throw refuse();
    return Number(value);
  }
  if (typeof value === 'number') {
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw refuse();
    return value;
  }
  if (typeof value === 'string' && /^-?\d+$/.test(value)) {
    const n = Number(value);
    if (!Number.isSafeInteger(n)) throw refuse();
    return n;
  }
  return value as LogicalValue;
}

/** A real column's value; a non-finite number cannot ride in JSON. */
export function realValue(value: unknown, where: string): LogicalValue {
  if (value === null || value === undefined) return null;
  const n = typeof value === 'number' ? value : Number(value);
  if (typeof value === 'string' && Number.isNaN(n)) return value;
  if (!Number.isFinite(n))
    throw new EngineError(`${where} holds a non-finite number`, 'refused');
  return n;
}
