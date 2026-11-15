/**
 * Planning the retire step (#5005).
 *
 * Input: the tables a package declares retired, the tables the build still
 * declares, and the live database. Output: schema changes of type
 * `retire_table`, never anything else. A change that drops carries one
 * `DROP TABLE IF EXISTS` and is the kind `table.retire`. Everything that keeps
 * a table from being dropped is a named stop, never a thrown error:
 *
 * 1. `table.retire-declared`: a model (or smrt itself) still declares the table.
 * 2. `table.retire-rows`: the table holds rows and the declaration does not say
 *    `rows: 'discard'`.
 * 3. `table.retire-dependent`: something undeclared depends on it. One stop per
 *    dependent: a foreign key, a view, a trigger.
 *
 * A table that is not live is nothing to do, so the step is idempotent. Only a
 * declared table is ever considered; nothing here reads orphans.
 *
 * Reads are SELECT-only. Nothing is written; the statements run inside the
 * migrate run's one atomic batch.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { schemaForeignKeys } from '../schema/foreign-key-ddl.js';
import {
  quoteIdentifier,
  quoteStringLiteral,
} from '../schema/sql-identifiers.js';
import type { SchemaChange, SchemaDefinition } from '../schema/types.js';
import { retireRowsGuardSql } from './retire-guard.js';
import type { RetiredTable } from './retired-tables.js';
import { readStoredRuntimeModelTables } from './stored-runtime-models.js';

/** One thing that depends on a retired table. */
export interface RetireDependent {
  kind: 'foreign key' | 'view' | 'trigger';
  /** The object, as an operator would name it. */
  name: string;
}

/** What a run knows about retirements before it reads the live database. */
export interface RetirementContext {
  /** Tables declared retired, by the packages loaded and the build. */
  retired: readonly RetiredTable[];
  /**
   * Table name to what declares it: model classes, packages of the build, or
   * `smrt system table`. A retired table with an entry is stop 1.
   */
  declaredBy: ReadonlyMap<string, readonly string[]>;
  /** The schemas the build declares, to find declared references. */
  schemas: Readonly<Record<string, SchemaDefinition>>;
}

export interface PlanTableRetirementsOptions extends RetirementContext {
  db: DatabaseInterface;
  engine: DatabaseEngine;
  /** The tables the live database holds. */
  liveTables: ReadonlySet<string>;
}

type Row = Record<string, unknown>;

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}
const text = (value: unknown) =>
  value === null || value === undefined ? '' : String(value);

/** Word-boundary match: `x` is not part of a longer name, quoted or not. */
function mentions(sql: string, table: string): boolean {
  const name = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_])${name}(?![A-Za-z0-9_])`, 'i').test(sql);
}

async function countRows(
  db: DatabaseInterface,
  table: string,
): Promise<number | null> {
  try {
    const rows = rowsOf(
      await db.query(`SELECT COUNT(*) AS n FROM ${quoteIdentifier(table)}`),
    );
    const n = Number(String(rows[0]?.n ?? rows[0]?.count));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

interface InboundForeignKey {
  child: string;
  columns: string;
}

/** Foreign keys of other tables that reference `table`. */
async function readInboundForeignKeys(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
): Promise<InboundForeignKey[]> {
  const literal = quoteStringLiteral(table);
  if (engine === 'postgres') {
    return rowsOf(
      await db.query(
        `SELECT child.relname AS child, ` +
          `array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord) ` +
          `JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord), ',') AS columns ` +
          `FROM pg_constraint con ` +
          `JOIN pg_class child ON child.oid = con.conrelid ` +
          `JOIN pg_class parent ON parent.oid = con.confrelid ` +
          `JOIN pg_namespace ns ON ns.oid = parent.relnamespace ` +
          `WHERE con.contype = 'f' AND ns.nspname = current_schema() ` +
          `AND parent.relname = ${literal} AND child.oid <> parent.oid ` +
          `ORDER BY child.relname, con.conname`,
      ),
    ).map((row) => ({ child: text(row.child), columns: text(row.columns) }));
  }
  if (engine === 'duckdb') {
    return rowsOf(
      await db.query(
        `SELECT table_name AS child, array_to_string(constraint_column_names, ',') AS columns ` +
          `FROM duckdb_constraints() ` +
          `WHERE database_name = current_database() AND schema_name = current_schema() ` +
          `AND constraint_type = 'FOREIGN KEY' AND referenced_table = ${literal} ` +
          `AND table_name <> ${literal} ORDER BY table_name`,
      ),
    ).map((row) => ({ child: text(row.child), columns: text(row.columns) }));
  }
  // SQLite: one PRAGMA per table; a self-reference is not a dependent.
  const found: InboundForeignKey[] = [];
  const target = table.toLowerCase();
  const tables = rowsOf(
    await db.query(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    ),
  );
  for (const { name } of tables) {
    const child = text(name);
    if (!child || child.toLowerCase() === target) continue;
    const keys = rowsOf(
      await db.query(`PRAGMA foreign_key_list(${quoteIdentifier(child)})`),
    ).filter((fk) => text(fk.table).toLowerCase() === target);
    const byId = new Map<string, string[]>();
    for (const fk of keys)
      byId.set(text(fk.id), [...(byId.get(text(fk.id)) ?? []), text(fk.from)]);
    for (const columns of byId.values())
      found.push({ child, columns: columns.join(',') });
  }
  return found;
}

/** Views, and triggers on other tables, that read or write `table`. */
async function readOtherDependents(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
): Promise<RetireDependent[]> {
  const literal = quoteStringLiteral(table);
  if (engine === 'postgres') {
    const dependents: RetireDependent[] = [];
    // A view or materialized view depends on the table in pg_depend.
    for (const row of rowsOf(
      await db.query(
        `SELECT DISTINCT c.relname AS name FROM pg_depend d ` +
          `JOIN pg_rewrite r ON r.oid = d.objid ` +
          `JOIN pg_class c ON c.oid = r.ev_class ` +
          `JOIN pg_class t ON t.oid = d.refobjid ` +
          `JOIN pg_namespace ns ON ns.oid = t.relnamespace ` +
          `WHERE d.classid = 'pg_rewrite'::regclass AND d.refclassid = 'pg_class'::regclass ` +
          `AND ns.nspname = current_schema() AND t.relname = ${literal} AND c.oid <> t.oid ` +
          `ORDER BY c.relname`,
      ),
    ))
      dependents.push({ kind: 'view', name: text(row.name) });
    // A trigger on another table whose function body names the table. The
    // catalog does not track that dependency; the text is the best evidence.
    for (const row of rowsOf(
      await db.query(
        `SELECT t.tgname AS name, c.relname AS on_table FROM pg_trigger t ` +
          `JOIN pg_class c ON c.oid = t.tgrelid ` +
          `JOIN pg_namespace ns ON ns.oid = c.relnamespace ` +
          `JOIN pg_proc p ON p.oid = t.tgfoid ` +
          `WHERE NOT t.tgisinternal AND ns.nspname = current_schema() ` +
          `AND c.relname <> ${literal} ` +
          `AND position(lower(${literal}) in lower(p.prosrc)) > 0 ` +
          `ORDER BY c.relname, t.tgname`,
      ),
    ))
      dependents.push({
        kind: 'trigger',
        name: `${text(row.name)} on ${text(row.on_table)}`,
      });
    return dependents;
  }
  if (engine === 'duckdb') {
    // DuckDB has no triggers.
    return rowsOf(
      await db.query(
        `SELECT view_name AS name, sql FROM duckdb_views() ` +
          `WHERE NOT internal AND database_name = current_database() ` +
          `AND schema_name = current_schema() ORDER BY view_name`,
      ),
    )
      .filter((row) => mentions(text(row.sql), table))
      .map((row) => ({ kind: 'view' as const, name: text(row.name) }));
  }
  return rowsOf(
    await db.query(
      `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('view', 'trigger') ORDER BY type, name`,
    ),
  )
    .filter(
      (row) =>
        text(row.tbl_name).toLowerCase() !== table.toLowerCase() &&
        mentions(text(row.sql), table),
    )
    .map((row) =>
      text(row.type) === 'view'
        ? { kind: 'view' as const, name: text(row.name) }
        : {
            kind: 'trigger' as const,
            name: `${text(row.name)} on ${text(row.tbl_name)}`,
          },
    );
}

const label = (entry: RetiredTable) =>
  `${entry.lastOwner}, retired in ${entry.since}`;

function stop(
  entry: RetiredTable,
  kind:
    | 'table.retire-declared'
    | 'table.retire-rows'
    | 'table.retire-dependent',
  message: string,
): SchemaChange {
  return {
    type: 'retire_table',
    kindHint: kind,
    table: entry.table,
    advisory: { severity: 'warning', message },
    retirement: retirementOf(entry, null),
  };
}

function retirementOf(
  entry: RetiredTable,
  rows: number | null,
): NonNullable<SchemaChange['retirement']> {
  return {
    packageName: entry.packageName,
    lastOwner: entry.lastOwner,
    since: entry.since,
    reason: entry.reason,
    rows,
  };
}

/**
 * Plan every declared retirement against the live database. Changes come back
 * stops first in table order, then the drops in an order that drops a table
 * before the retired tables it references.
 */
export async function planTableRetirements(
  options: PlanTableRetirementsOptions,
): Promise<SchemaChange[]> {
  const { db, engine, liveTables, declaredBy, schemas } = options;
  // The JSON adapter has no catalog to read dependents from: nothing is
  // dropped there, which is the safe side.
  if (engine === 'json') return [];

  // One entry per table; two packages naming a table must agree to discard.
  const entries = new Map<string, RetiredTable>();
  for (const entry of options.retired) {
    const prior = entries.get(entry.table);
    if (!prior || (prior.rows === 'discard' && entry.rows !== 'discard'))
      entries.set(entry.table, entry);
  }
  const live = [...entries.values()]
    .filter((entry) => liveTables.has(entry.table))
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));

  const stops: SchemaChange[] = [];
  const candidates: RetiredTable[] = [];
  // Run-time models stored in the database declare tables too, though this
  // process never registered them (R10).
  const stored = live.length
    ? await readStoredRuntimeModelTables(db, engine, liveTables)
    : { tables: new Map<string, string[]>() };
  for (const entry of live) {
    if (stored.unreadable) {
      stops.push(
        stop(
          entry,
          'table.retire-declared',
          `${entry.table} is declared retired (${label(entry)}: ${entry.reason}) but ${stored.unreadable}, so a run-time model may still declare the table. It is not dropped.`,
        ),
      );
      continue;
    }
    const owners = [
      ...(declaredBy.get(entry.table) ?? []),
      ...(stored.tables.get(entry.table.toLowerCase()) ?? []),
    ];
    if (owners.length) {
      stops.push(
        stop(
          entry,
          'table.retire-declared',
          `${entry.table} is declared retired (${label(entry)}: ${entry.reason}) but ${owners.join(', ')} still declare${owners.length === 1 ? 's' : ''} it. A table cannot be both. Remove the retirement, or remove the model.`,
        ),
      );
      continue;
    }
    candidates.push(entry);
  }
  const retiring = new Set(candidates.map((entry) => entry.table));

  // Edges between tables retired in this run: the referencing table goes first.
  const edges = new Map<string, Set<string>>();
  const droppable: Array<{ entry: RetiredTable; rows: number | null }> = [];
  for (const entry of candidates) {
    const rows = await countRows(db, entry.table);
    if (entry.rows !== 'discard') {
      if (rows === null || rows > 0) {
        stops.push(
          stop(
            entry,
            'table.retire-rows',
            rows === null
              ? `${entry.table} is declared retired (${label(entry)}: ${entry.reason}) without rows: 'discard', and its rows could not be counted. It is not dropped.`
              : `${entry.table} holds ${rows} row(s) and its retirement (${label(entry)}: ${entry.reason}) does not say rows: 'discard'. It is not dropped.`,
          ),
        );
        continue;
      }
    }

    const dependents: RetireDependent[] = [];
    const seen = new Set<string>();
    for (const fk of await readInboundForeignKeys(db, engine, entry.table)) {
      if (retiring.has(fk.child)) {
        const parents = edges.get(fk.child) ?? new Set<string>();
        parents.add(entry.table);
        edges.set(fk.child, parents);
        continue;
      }
      const key = `${fk.child}.${fk.columns}`;
      seen.add(key);
      dependents.push({ kind: 'foreign key', name: key });
    }
    // A model the build declares that references the table also depends on it.
    for (const [child, schema] of Object.entries(schemas)) {
      if (child === entry.table || retiring.has(child)) continue;
      for (const fk of schemaForeignKeys(schema)) {
        if (fk.referencesTable !== entry.table) continue;
        const key = `${child}.${fk.column}`;
        if (seen.has(key)) continue;
        seen.add(key);
        dependents.push({ kind: 'foreign key', name: key });
      }
    }
    dependents.push(...(await readOtherDependents(db, engine, entry.table)));

    if (dependents.length) {
      for (const dependent of dependents)
        stops.push(
          stop(
            entry,
            'table.retire-dependent',
            `${entry.table} is declared retired (${label(entry)}: ${entry.reason}) but ${dependent.kind} ${dependent.name} depends on it. It is not dropped.`,
          ),
        );
      continue;
    }
    droppable.push({ entry, rows });
  }

  // Drop referencing tables first. What cannot be ordered is a cycle: named.
  const dropping = new Set(droppable.map(({ entry }) => entry.table));
  const ordered: typeof droppable = [];
  const pending = [...droppable];
  while (pending.length) {
    const next = pending.findIndex(({ entry }) =>
      [...dropping].every(
        (other) => other === entry.table || !edges.get(other)?.has(entry.table),
      ),
    );
    if (next === -1) break;
    const [done] = pending.splice(next, 1);
    ordered.push(done);
    dropping.delete(done.entry.table);
  }
  for (const { entry } of pending)
    stops.push(
      stop(
        entry,
        'table.retire-dependent',
        `${entry.table} is declared retired (${label(entry)}: ${entry.reason}) but retired tables ${pending.map((item) => item.entry.table).join(', ')} reference each other, so no order drops them. Remove one foreign key first. It is not dropped.`,
      ),
    );

  const drops = ordered.map(({ entry, rows }): SchemaChange => {
    const target = quoteIdentifier(entry.table);
    const sql = `DROP TABLE IF EXISTS ${target}`;
    // The count above ran outside any transaction. Without rows: 'discard'
    // the batch counts again right before the drop and rolls back if rows
    // appeared; PostgreSQL first locks out every writer (R2).
    const sqlStatements =
      entry.rows === 'discard'
        ? [sql]
        : [
            ...(engine === 'postgres'
              ? [`LOCK TABLE ${target} IN ACCESS EXCLUSIVE MODE`]
              : []),
            retireRowsGuardSql(target),
            sql,
          ];
    return {
      type: 'retire_table',
      kindHint: 'table.retire',
      table: entry.table,
      sql,
      ...(sqlStatements.length > 1 ? { sqlStatements } : {}),
      note: `Retired in ${entry.since} (${entry.lastOwner}): ${entry.reason}${
        entry.rows === 'discard'
          ? rows === null
            ? ' Its rows are discarded.'
            : ` ${rows} row(s) discarded.`
          : ''
      }`,
      retirement: retirementOf(entry, rows),
    };
  });
  return [...stops, ...drops];
}
