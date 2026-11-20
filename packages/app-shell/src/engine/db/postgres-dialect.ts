// PostgreSQL's side of the engine dialect (server PostgreSQL and PGlite). Pure
// (no database import), so the host thread can use it without loading
// `@happyvertical/sql`.

import type { FieldType } from '../definition.ts';
import type { EngineDialect } from './types.ts';

// Match the column types core's own PostgreSQL DDL creates (BIGINT, BOOLEAN,
// JSONB, TIMESTAMPTZ, DOUBLE PRECISION), so an engine ADD COLUMN and core's
// planned DDL agree. `db-types.test.ts` compares them per field type.
const COLUMN_TYPES: Record<FieldType, string> = {
  text: 'TEXT',
  number: 'DOUBLE PRECISION',
  integer: 'BIGINT',
  boolean: 'BOOLEAN',
  date: 'TIMESTAMPTZ',
  money: 'BIGINT', // minor units (cents)
  choice: 'TEXT',
  reference: 'TEXT', // the referenced record's id
  json: 'JSONB',
};

const TEXT_ALIAS = '__text';

export const postgresDialect: EngineDialect = {
  name: 'postgres',
  ddlEngine: 'postgres',
  columnType: (t) => COLUMN_TYPES[t],
  /** Family of a catalog type name (`bigint`, `timestamp with time zone`, ...). */
  storageFamily(declared) {
    const t = declared.toLowerCase();
    if (/bool/.test(t)) return 'boolean';
    if (/timestamp|^date|^time/.test(t)) return 'date';
    if (/int|serial/.test(t)) return 'integer';
    if (/double|real|float|numeric|decimal/.test(t)) return 'real';
    if (/json/.test(t)) return 'json';
    return 'text';
  },
  archiveTableDDL: `CREATE TABLE IF NOT EXISTS _archive (id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY, version INTEGER NOT NULL, tbl TEXT NOT NULL, col TEXT NOT NULL, record_id TEXT NOT NULL, value TEXT, created_at TEXT NOT NULL)`,
  nonEmpty: (c) => `${c} IS NOT NULL AND CAST(${c} AS TEXT) <> ''`,
  asText: (e) => `CAST(${e} AS TEXT)`,
  fromText: (e, t) => `CAST(${e} AS ${COLUMN_TYPES[t]})`,
  storedInteger: (column, alias, isInteger) => {
    const a = alias.replace(/"/g, '""');
    return isInteger
      ? `${column} AS "${a}", CAST(${column} AS TEXT) AS "${a}${TEXT_ALIAS}"`
      : `${column} AS "${a}"`;
  },
  // A BIGINT may be past 2^53: the exact digits travel as text beside it.
  finishStoredInteger(row, alias) {
    const key = alias + TEXT_ALIAS;
    if (!(key in row)) return;
    const text = row[key];
    delete row[key];
    const v = row[alias];
    if (text != null && !(typeof v === 'number' && Number.isSafeInteger(v)))
      row[alias] = text;
  },
  byteLength: (e) => `octet_length(${e})`,
  isDistinct: (a, b) => `${a} IS DISTINCT FROM ${b}`,
  transactionOptions: { introspection: true },
  snapshots: false,
};
