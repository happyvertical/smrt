// SQLite's side of the engine dialect. Pure (no database import), so the host
// thread can use it without loading `@happyvertical/sql`.

import type { FieldType } from '../definition.ts';
import type { EngineDialect } from './types.ts';

const COLUMN_TYPES: Record<FieldType, string> = {
  text: 'TEXT',
  number: 'REAL',
  integer: 'INTEGER',
  boolean: 'INTEGER',
  date: 'DATETIME',
  money: 'INTEGER', // minor units (cents)
  choice: 'TEXT',
  reference: 'TEXT', // the referenced record's id
  json: 'TEXT',
};

export const sqliteDialect: EngineDialect = {
  name: 'sqlite',
  ddlEngine: 'sqlite',
  columnType: (t) => COLUMN_TYPES[t],
  /** Storage family of a declared SQLite column type, to compare columns. */
  storageFamily(declared) {
    const t = declared.toUpperCase();
    if (/DATE|TIME/.test(t)) return 'date';
    if (/INT|BOOL/.test(t)) return 'integer';
    if (/REAL|FLOA|DOUB|DEC|NUMERIC/.test(t)) return 'real';
    return 'text';
  },
  archiveTableDDL: `CREATE TABLE IF NOT EXISTS _archive (id INTEGER PRIMARY KEY AUTOINCREMENT, version INTEGER NOT NULL, tbl TEXT NOT NULL, col TEXT NOT NULL, record_id TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL)`,
  nonEmpty: (c) => `${c} IS NOT NULL AND ${c} <> ''`,
  asText: (e) => e,
  // SQLite assigns the archived text and lets column affinity convert it,
  // exactly as the engine always did (a CAST would change a date to a number).
  fromText: (e) => e,
  castTo: (e, t) => `CAST(${e} AS ${COLUMN_TYPES[t]})`,
  storedInteger: (column, alias) =>
    `CASE WHEN typeof(${column}) = 'integer' AND (${column} > 9007199254740991 OR ${column} < -9007199254740991) THEN CAST(${column} AS TEXT) ELSE ${column} END AS "${alias.replace(/"/g, '""')}"`,
  finishStoredInteger() {},
  byteLength: (e) => `length(CAST(${e} AS BLOB))`,
  isDistinct: (a, b) => `${a} IS NOT ${b}`,
  transactionOptions: undefined,
  snapshots: true,
};
