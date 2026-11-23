// PostgreSQL's side of the portable export (#5193): one app's schema as
// `PortableDb`. The transaction it gets has `search_path` set to the app's
// schema (the schema name comes only from the host's config, never from a
// bundle), so every name here is unqualified. Values travel as the database's
// own text and come back through a cast to the column's own type, exactly as
// the schema dump does, so no type is guessed. Nothing outside `engine/db/`
// may contain PostgreSQL SQL.

import { EngineError } from '../errors.ts';
import {
  assertIdentifier,
  type ColumnFamily,
  integerValue,
  type LogicalRow,
  type LogicalValue,
  type PortableColumn,
  type PortableDb,
  realValue,
} from './portable.ts';
import { lockForCopy, readAllRows } from './postgres-copy.ts';
import { postgresDialect } from './postgres-dialect.ts';

type Tx = {
  query(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: any[]; rowCount?: number | null }>;
};
const META_TABLE = '_app_meta';
const ARCHIVE_INDEX =
  'CREATE INDEX IF NOT EXISTS _archive_lookup ON _archive (version, tbl, col, record_id)';
const q = (s: string) => `"${s.replace(/"/g, '""')}"`;
const lit = (s: string) => `'${s.replace(/'/g, "''")}'`;

const TYPE_OF: Record<ColumnFamily, string> = {
  integer: 'BIGINT',
  real: 'DOUBLE PRECISION',
  boolean: 'BOOLEAN',
  date: 'TIMESTAMPTZ',
  json: 'JSONB',
  bytes: 'BYTEA',
  text: 'TEXT',
};

function familyOf(declared: string): ColumnFamily {
  const t = declared.toLowerCase();
  if (/bytea/.test(t)) return 'bytes';
  if (/bool/.test(t)) return 'boolean';
  if (/timestamp|^date|^time/.test(t)) return 'date';
  if (/int|serial/.test(t)) return 'integer';
  if (/double|real|float|numeric|decimal/.test(t)) return 'real';
  if (/json/.test(t)) return 'json';
  return 'text';
}

interface Attribute {
  name: string;
  type: string;
  identity: boolean;
}

/**
 * Point `tx` at `schema` for a read or a write of every table: acting as the
 * engine for row-level security (a copy that silently dropped hidden rows
 * would be worse than a refusal; see `readAllRows`) and one fixed text format
 * for every value.
 */
export async function scopeForPortable(tx: Tx, schema: string) {
  await tx.query(`SELECT set_config('search_path', ${lit(q(schema))}, true)`);
  await readAllRows(tx, schema);
  await tx.query(`SELECT set_config('timezone', 'UTC', true)`);
  await tx.query(`SELECT set_config('datestyle', 'ISO, MDY', true)`);
  await tx.query(`SELECT set_config('intervalstyle', 'postgres', true)`);
  await tx.query(`SELECT set_config('bytea_output', 'hex', true)`);
}

/**
 * Hold every table of `schema` still for reading (writers wait; see
 * `lockForCopy`): the transaction cannot ask for a repeatable-read snapshot,
 * and a copy of two tables from two moments is not one state.
 */
export const lockSchemaForRead = (tx: Tx, schema: string) =>
  lockForCopy(tx as any, schema);

/** The app's schema as `PortableDb`; `tx` is already scoped by {@link scopeForPortable}. */
export function postgresPortable(tx: Tx, tenantId: string): PortableDb {
  /** The engine's own column: bundles never carry it, an import stamps it. */
  const TENANT_COLUMN = 'tenant_id';
  /**
   * The tables whose `tenant_id` is the engine's: the app's own, which carry
   * forced row-level-security policies (#5189) and a NOT NULL tenant column.
   * A nullable column of that name (the shipped profiles table inherits one)
   * or one on a core system table is data, which a bundle keeps.
   */
  let stamped: Set<string> | undefined;
  const stampedTables = async (): Promise<Set<string>> => {
    stamped ??= new Set(
      (
        await tx.query(
          `SELECT c.relname AS name FROM pg_class c
            WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
              AND c.relkind = 'r' AND c.relforcerowsecurity
              AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = ${lit(TENANT_COLUMN)} AND a.attnotnull AND NOT a.attisdropped)`,
        )
      ).rows.map((r) => String(r.name)),
    );
    return stamped;
  };
  const attributes = new Map<string, Attribute[]>();
  const attributesOf = async (table: string): Promise<Attribute[]> => {
    const cached = attributes.get(table);
    if (cached) return cached;
    const rows = (
      await tx.query(
        `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type, a.attidentity <> '' AS identity
           FROM pg_attribute a
          WHERE a.attrelid = to_regclass(${lit(q(table))}) AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = ''
          ORDER BY a.attnum`,
      )
    ).rows;
    const out = rows.map((r) => ({
      name: String(r.name),
      type: String(r.type),
      identity: r.identity === true || r.identity === 't',
    }));
    attributes.set(table, out);
    return out;
  };

  /** The select item that returns a column as one fixed text. */
  const readItem = (c: PortableColumn, declared: string, i: number) => {
    const col = q(c.name);
    const alias = `c${i}`;
    switch (c.family) {
      case 'boolean':
        return `CASE WHEN ${col} IS NULL THEN NULL WHEN ${col} THEN '1' ELSE '0' END AS ${alias}`;
      case 'bytes':
        return `encode(${col}, 'base64') AS ${alias}`;
      case 'date':
        return /with time zone/i.test(declared)
          ? `to_char(${col} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS ${alias}`
          : `CAST(${col} AS text) AS ${alias}`;
      default:
        return `CAST(${col} AS text) AS ${alias}`;
    }
  };

  return {
    dialect: 'postgres',
    async tables() {
      const rows = (
        await tx.query(
          `SELECT c.relname AS name, c.relkind AS kind, c.relispartition AS part
             FROM pg_class c
            WHERE c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = current_schema())
              AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
            ORDER BY c.relname COLLATE "C"`,
        )
      ).rows;
      const odd = rows.find(
        (r) => r.kind !== 'r' || r.part === true || r.part === 't',
      );
      if (odd)
        throw new EngineError(
          `${odd.name} is a view, foreign or partitioned table; it cannot be moved`,
          'refused',
        );
      // Core's `_smrt_*` system tables are made by the target's own boot, never the app's data.
      return rows
        .map((r) => String(r.name))
        .filter((n) => n !== META_TABLE && !n.startsWith('_smrt_'));
    },
    async columns(table) {
      const engineOwned = (await stampedTables()).has(table);
      return (await attributesOf(table))
        .filter((a) => !(engineOwned && a.name === TENANT_COLUMN))
        .map((a) => ({
          name: a.name,
          family: familyOf(a.type),
        }));
    },
    async rows(table, columns) {
      const attrs = await attributesOf(table);
      const type = (name: string) =>
        attrs.find((a) => a.name === name)?.type ?? '';
      const items = columns.map((c, i) => readItem(c, type(c.name), i));
      if (!items.length) return [];
      const raw = (
        await tx.query(`SELECT ${items.join(', ')} FROM ${q(table)}`)
      ).rows as Array<Record<string, unknown>>;
      return raw.map((r) => {
        const out: LogicalRow = {};
        columns.forEach((c, i) => {
          out[c.name] = decodeText(r[`c${i}`], c.family, `${table}.${c.name}`);
        });
        return out;
      });
    },
    async count(table) {
      return Number(
        (await tx.query(`SELECT COUNT(*) AS n FROM ${q(table)}`)).rows[0].n,
      );
    },
    async meta() {
      const there = (
        await tx.query(
          `SELECT to_regclass(${lit(q(META_TABLE))}) IS NOT NULL AS has`,
        )
      ).rows[0]?.has;
      if (!(there === true || there === 't')) return null;
      const rows = (await tx.query(`SELECT key, value FROM ${q(META_TABLE)}`))
        .rows as Array<{ key: string; value: string }>;
      const get = (k: string) => rows.find((r) => r.key === k)?.value;
      return { version: get('version'), definition: get('definition') };
    },
    async metaValue(key) {
      const there = (
        await tx.query(
          `SELECT to_regclass(${lit(q(META_TABLE))}) IS NOT NULL AS has`,
        )
      ).rows[0]?.has;
      if (!(there === true || there === 't')) return null;
      const rows = (
        await tx.query(`SELECT value FROM ${q(META_TABLE)} WHERE key = $1`, [
          key,
        ])
      ).rows as Array<{ value: string }>;
      return rows[0]?.value ?? null;
    },
    async recordMeta(key, value) {
      await tx.query(
        `INSERT INTO ${q(META_TABLE)} (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
        [key, value],
      );
      const rows = (
        await tx.query(`SELECT value FROM ${q(META_TABLE)} WHERE key = $1`, [
          key,
        ])
      ).rows as Array<{ value: string }>;
      if (rows[0]?.value !== value)
        throw new EngineError(
          `${key} is already recorded differently`,
          'refused',
        );
    },
    async createArchive() {
      await tx.query(postgresDialect.archiveTableDDL);
      await tx.query(ARCHIVE_INDEX);
      attributes.delete('_archive');
    },
    async create(table, columns) {
      assertIdentifier(table, 'table');
      const cols = columns.map(
        (c) =>
          `${q(assertIdentifier(c.name, 'column'))} ${TYPE_OF[c.family]}${c.name === 'id' ? ' PRIMARY KEY' : ''}`,
      );
      await tx.query(`CREATE TABLE ${q(table)} (${cols.join(', ')})`);
      attributes.delete(table);
    },
    async addColumn(table, column) {
      assertIdentifier(table, 'table');
      await tx.query(
        `ALTER TABLE ${q(table)} ADD COLUMN ${q(assertIdentifier(column.name, 'column'))} ${TYPE_OF[column.family]}`,
      );
      attributes.delete(table);
    },
    async insert(table, columns, rows) {
      if (!rows.length) return;
      assertIdentifier(table, 'table');
      const attrs = await attributesOf(table);
      const by = new Map(attrs.map((a) => [a.name, a]));
      // The tenant of the app goes on every row of a table that has the column.
      if (
        (await stampedTables()).has(table) &&
        !columns.some((c) => c.name === TENANT_COLUMN)
      ) {
        columns = [...columns, { name: TENANT_COLUMN, family: 'text' }];
        rows = rows.map((r) => ({ ...r, [TENANT_COLUMN]: tenantId }));
      }
      const types = columns.map((c) => {
        const a = by.get(assertIdentifier(c.name, 'column'));
        if (!a)
          throw new EngineError(
            `Table ${table} does not define column ${c.name}.`,
            'refused',
          );
        return a.type;
      });
      const overriding = columns.some((c) => by.get(c.name)?.identity);
      const per = Math.max(
        1,
        Math.min(500, Math.floor(30000 / columns.length)),
      );
      for (let i = 0; i < rows.length; i += per) {
        const params: unknown[] = [];
        const values = rows
          .slice(i, i + per)
          .map(
            (row) =>
              `(${columns
                .map((c, k) => {
                  params.push(toText(row[c.name] ?? null));
                  return `CAST(? AS ${types[k]})`;
                })
                .join(', ')})`,
          )
          .join(', ');
        await tx.query(
          `INSERT INTO ${q(table)} (${columns.map((c) => q(c.name)).join(', ')})${overriding ? ' OVERRIDING SYSTEM VALUE' : ''} VALUES ${values}`,
          params,
        );
      }
    },
    async finish(table, columns) {
      const attrs = await attributesOf(table);
      for (const a of attrs) {
        if (!a.identity || !columns.some((c) => c.name === a.name)) continue;
        // Rows went in with their own ids: the next generated one must follow them.
        await tx.query(
          `SELECT setval(pg_get_serial_sequence(${lit(q(table))}, ${lit(a.name)}), COALESCE(MAX(${q(a.name)}), 1), MAX(${q(a.name)}) IS NOT NULL) FROM ${q(table)}`,
        );
      }
    },
  };
}

/** A logical value as the text the cast reads it from. */
function toText(v: LogicalValue): string | null {
  if (v === null) return null;
  if (v instanceof Uint8Array) return `\\x${Buffer.from(v).toString('hex')}`;
  return String(v);
}

/** The text the database returned as a logical value of the column's family. */
function decodeText(
  value: unknown,
  family: ColumnFamily,
  where: string,
): LogicalValue {
  if (value === null || value === undefined) return null;
  const text = String(value);
  switch (family) {
    case 'integer':
      return integerValue(text, where);
    case 'boolean':
      return Number(text);
    case 'real':
      return realValue(text, where);
    case 'bytes':
      return new Uint8Array(Buffer.from(text, 'base64'));
    default:
      return text;
  }
}
