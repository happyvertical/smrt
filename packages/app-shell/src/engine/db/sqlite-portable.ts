// SQLite's side of the portable export (#5193): the app.db tables as
// `PortableDb`. Nothing outside `engine/db/` may contain SQLite SQL.

import { EngineError } from '../errors.ts';
import {
  assertIdentifier,
  type ColumnFamily,
  integerValue,
  type LogicalRow,
  type LogicalValue,
  type PortableDb,
  realValue,
} from './portable.ts';
import { sqliteDialect } from './sqlite-dialect.ts';

type Handle = any;
const META_TABLE = '_app_meta';
const ARCHIVE_INDEX =
  'CREATE INDEX IF NOT EXISTS _archive_lookup ON _archive (version, tbl, col, record_id)';
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Family of a declared SQLite column type. */
function familyOf(declared: string): ColumnFamily {
  const t = String(declared ?? '').toUpperCase();
  if (/BLOB/.test(t)) return 'bytes';
  if (/BOOL/.test(t)) return 'boolean';
  if (/JSON/.test(t)) return 'json';
  if (/DATE|TIME/.test(t)) return 'date';
  if (/INT/.test(t)) return 'integer';
  if (/REAL|FLOA|DOUB|DEC|NUMERIC/.test(t)) return 'real';
  return 'text';
}

const TYPE_OF: Record<ColumnFamily, string> = {
  integer: 'INTEGER',
  real: 'REAL',
  boolean: 'INTEGER',
  date: 'DATETIME',
  json: 'TEXT',
  bytes: 'BLOB',
  text: 'TEXT',
};

/** The tables of `h` (an open transaction on app.db). */
export function sqlitePortable(h: Handle): PortableDb {
  return {
    dialect: 'sqlite',
    async tables() {
      const rows = (
        await h.query(
          `SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name <> ? ORDER BY name`,
          [META_TABLE],
        )
      ).rows as Array<{ name: string; sql: string | null }>;
      const virtual = rows.find((r) =>
        /^\s*CREATE\s+VIRTUAL/i.test(r.sql ?? ''),
      );
      if (virtual)
        throw new EngineError(
          `table ${virtual.name} is a virtual table; it cannot be moved`,
          'refused',
        );
      return rows.map((r) => r.name);
    },
    async columns(table) {
      return (
        (
          await h.query(
            `SELECT name, type FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid`,
            [table],
          )
        ).rows as Array<{ name: string; type: string }>
      ).map((r) => ({ name: String(r.name), family: familyOf(r.type) }));
    },
    async rows(table, columns) {
      const raw = (
        await h.query(
          `SELECT ${columns.map((c) => q(c.name)).join(', ')} FROM ${q(table)} ORDER BY rowid`,
        )
      ).rows as Array<Record<string, unknown>>;
      return raw.map((r) => {
        const out: LogicalRow = {};
        for (const c of columns)
          out[c.name] = logical(r[c.name], c.family, `${table}.${c.name}`);
        return out;
      });
    },
    async count(table) {
      return Number(
        (await h.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n,
      );
    },
    async meta() {
      const there = (
        await h.query(`SELECT 1 AS x FROM sqlite_master WHERE name = ?`, [
          META_TABLE,
        ])
      ).rows.length;
      if (!there) return null;
      const rows = (await h.query(`SELECT key, value FROM ${META_TABLE}`))
        .rows as Array<{ key: string; value: string }>;
      const get = (k: string) => rows.find((r) => r.key === k)?.value;
      return { version: get('version'), definition: get('definition') };
    },
    async createArchive() {
      await h.query(sqliteDialect.archiveTableDDL);
      await h.query(ARCHIVE_INDEX);
    },
    async create(table, columns) {
      assertIdentifier(table, 'table');
      const cols = columns.map(
        (c) =>
          `${q(assertIdentifier(c.name, 'column'))} ${TYPE_OF[c.family]}${c.name === 'id' ? ' PRIMARY KEY' : ''}`,
      );
      await h.query(`CREATE TABLE ${q(table)} (${cols.join(', ')})`);
    },
    async addColumn(table, column) {
      assertIdentifier(table, 'table');
      await h.query(
        `ALTER TABLE ${q(table)} ADD COLUMN ${q(assertIdentifier(column.name, 'column'))} ${TYPE_OF[column.family]}`,
      );
    },
    async insert(table, columns, rows) {
      if (!rows.length) return;
      const sql = `INSERT INTO ${q(table)} (${columns.map((c) => q(c.name)).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`;
      for (const row of rows)
        await h.query(
          sql,
          columns.map((c) => {
            const v = row[c.name] ?? null;
            return v instanceof Uint8Array ? Buffer.from(v) : v;
          }),
        );
    },
    async finish() {},
  };
}

/** One stored value as a logical one. */
function logical(
  value: unknown,
  family: ColumnFamily,
  where: string,
): LogicalValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === 'bigint') return integerValue(value, where);
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'number') {
    if (family === 'integer' || family === 'boolean')
      return integerValue(value, where);
    return realValue(value, where);
  }
  return value as LogicalValue;
}
