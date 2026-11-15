/**
 * Planning the retire step (#5005).
 *
 * Input: the tables a package declares retired, what still declares tables,
 * and the live database. Output: schema changes of type `retire_table`, never
 * anything else. A change that drops carries `DROP TABLE IF EXISTS` (with an
 * in-batch row check and, on PostgreSQL, a lock, when rows must not be
 * discarded) and is the kind `table.retire`. Everything that keeps a table
 * from being dropped is a named stop, never a thrown error, checked in this
 * order:
 *
 * 1. `table.retire-owner`: the entry fails its checks (a `lastOwner` outside
 *    the declaring package, a `_smrt_` table retired by a package outside
 *    smrt, no generated definition). Every loader refuses these already;
 *    the plan checks again, since a build description can be registered
 *    directly.
 * 2. `table.retire-declared`: a model, a stored run-time model or smrt itself
 *    still declares the table.
 * 3. `table.retire-mismatch`: the live table is not the table the declaration
 *    describes. Its `definition` (the columns and types the owning model last
 *    declared) is compared with the live table by the differ, and any
 *    difference beyond the drift the differ already tolerates stops it. This
 *    proves the table, not just its name, and needs no migrate record.
 * 4. `table.retire-rows`: the table holds rows and a declaration does not say
 *    `rows: 'discard'`.
 * 5. `table.retire-dependent`: something undeclared depends on it. One stop
 *    per dependent: a foreign key; a view or materialized view; on PostgreSQL
 *    anything `pg_depend` records (a policy, another table's default on its
 *    sequence, a row-type column, an inheriting table, a function using its
 *    row type) and a function or trigger whose body names it; on DuckDB a
 *    macro.
 * 6. `table.retire-unsupported`: the JSON adapter has no catalog to read
 *    dependents from. It never drops; a live retired table stops the run, so
 *    no migrate record claims it is gone.
 *
 * Names: declarations are lower case. SQLite and DuckDB compare table names
 * without case, so their live tables match without case; PostgreSQL matches
 * exactly. On PostgreSQL every read and every statement names the `public`
 * schema, the one the differ reads live tables from, whatever the
 * `search_path`.
 *
 * A table that is not live is nothing to do, so the step is idempotent. Only a
 * declared table is ever considered; nothing here reads orphans. Reads are
 * SELECT-only; the statements run inside the migrate run's one atomic batch.
 */
import type { DatabaseInterface } from '@happyvertical/sql';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import { schemaForeignKeys } from '../schema/foreign-key-ddl.js';
import {
  quoteIdentifier,
  quoteStringLiteral,
} from '../schema/sql-identifiers.js';
import type { SchemaChange, SchemaDefinition } from '../schema/types.js';
import { classifySchemaChange } from './change-kinds.js';
import { retireRowsGuardSql } from './retire-guard.js';
import {
  parseCarriedRetiredTable,
  type RetiredTable,
  type RetiredTableDefinition,
} from './retired-tables.js';
import { readStoredRuntimeModelTables } from './stored-runtime-models.js';

/** The PostgreSQL schema the migrator reads and writes. */
export const RETIRE_POSTGRES_SCHEMA = 'public';

/** One thing that depends on a retired table. */
export interface RetireDependent {
  /** `foreign key`, `view`, `trigger`, `function`, `policy`, ... */
  kind: string;
  /** The object, as an operator would name it. */
  name: string;
}

/** What a run knows about retirements before it reads the live database. */
export interface RetirementContext {
  /** Tables declared retired (see `resolveRetiredTables`). */
  retired: readonly RetiredTable[];
  /**
   * Lower-cased table name to what declares it: model classes, packages of
   * the build, or smrt itself. A retired table with an entry is a stop.
   */
  declaredBy: ReadonlyMap<string, readonly string[]>;
  /** The schemas the build declares, to find declared references. */
  schemas: Readonly<Record<string, SchemaDefinition>>;
}

/** @internal The differ plans retirements; nothing else calls this. */
export interface PlanTableRetirementsOptions extends RetirementContext {
  db: DatabaseInterface;
  engine: DatabaseEngine;
  /** The tables the live database holds. */
  liveTables: ReadonlySet<string>;
  /**
   * The differ's comparison of a declared table with the live one, as for a
   * model table. Its changes are the drift beyond what it tolerates.
   */
  compareDefinition: (
    table: string,
    schema: SchemaDefinition,
  ) => Promise<SchemaChange[]>;
}

type Row = Record<string, unknown>;
type StopKind =
  | 'table.retire-owner'
  | 'table.retire-declared'
  | 'table.retire-mismatch'
  | 'table.retire-rows'
  | 'table.retire-dependent'
  | 'table.retire-unsupported';

function rowsOf(result: unknown): Row[] {
  if (Array.isArray(result)) return result as Row[];
  const rows = (result as { rows?: unknown } | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}
const text = (value: unknown) =>
  value === null || value === undefined ? '' : String(value);
const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Word-boundary match: `x` is not part of a longer name, quoted or not. */
function mentions(sql: string, table: string): boolean {
  const name = table.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9_$])${name}(?![A-Za-z0-9_$])`, 'i').test(
    sql,
  );
}

/** The table as statements name it: schema-qualified on PostgreSQL. */
function qualified(engine: DatabaseEngine, table: string): string {
  return engine === 'postgres'
    ? `${quoteIdentifier(RETIRE_POSTGRES_SCHEMA)}.${quoteIdentifier(table)}`
    : quoteIdentifier(table);
}

async function countRows(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
): Promise<number | null> {
  try {
    const rows = rowsOf(
      await db.query(`SELECT COUNT(*) AS n FROM ${qualified(engine, table)}`),
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
    // Children in any schema: a foreign key from elsewhere still holds rows
    // that point here.
    return rowsOf(
      await db.query(
        `SELECT CASE WHEN child_ns.nspname = ${quoteStringLiteral(RETIRE_POSTGRES_SCHEMA)} THEN child.relname ELSE child_ns.nspname || '.' || child.relname END AS child, ` +
          `array_to_string(ARRAY(SELECT a.attname FROM unnest(con.conkey) WITH ORDINALITY AS k(num, ord) ` +
          `JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.num ORDER BY k.ord), ',') AS columns ` +
          `FROM pg_constraint con ` +
          `JOIN pg_class child ON child.oid = con.conrelid ` +
          `JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace ` +
          `JOIN pg_class parent ON parent.oid = con.confrelid ` +
          `JOIN pg_namespace ns ON ns.oid = parent.relnamespace ` +
          `WHERE con.contype = 'f' AND ns.nspname = ${quoteStringLiteral(RETIRE_POSTGRES_SCHEMA)} ` +
          `AND parent.relname = ${literal} AND child.oid <> parent.oid ` +
          `ORDER BY 1, con.conname`,
      ),
    ).map((row) => ({ child: text(row.child), columns: text(row.columns) }));
  }
  if (engine === 'duckdb') {
    // `duckdb_constraints().referenced_table` (DuckDB 1.4).
    return rowsOf(
      await db.query(
        `SELECT table_name AS child, array_to_string(constraint_column_names, ',') AS columns ` +
          `FROM duckdb_constraints() ` +
          `WHERE database_name = current_database() AND schema_name = current_schema() ` +
          `AND constraint_type = 'FOREIGN KEY' AND lower(referenced_table) = lower(${literal}) ` +
          `AND lower(table_name) <> lower(${literal}) ORDER BY table_name`,
      ),
    ).map((row) => ({ child: text(row.child), columns: text(row.columns) }));
  }
  // SQLite: one PRAGMA per table, whether foreign keys are enforced or not;
  // a self-reference is not a dependent.
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

/**
 * PostgreSQL: every object `pg_depend` records as depending on the table, its
 * row type, or a sequence it owns, other than what goes with the table itself
 * and the foreign keys read above. PostgreSQL refuses most of these without
 * CASCADE; named here they are a stop, not a failed run.
 */
async function readPostgresCatalogDependents(
  db: DatabaseInterface,
  table: string,
): Promise<RetireDependent[]> {
  const schema = quoteStringLiteral(RETIRE_POSTGRES_SCHEMA);
  const literal = quoteStringLiteral(table);
  const rows = rowsOf(
    await db.query(
      `WITH target AS (` +
        `SELECT c.oid, c.reltype FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ` +
        `WHERE n.nspname = ${schema} AND c.relname = ${literal}), ` +
        `owned AS (` +
        `SELECT d.classid, d.objid FROM pg_depend d JOIN target ON d.refobjid = target.oid ` +
        `WHERE d.refclassid = 'pg_class'::regclass AND d.deptype IN ('a', 'i')), ` +
        `referenced AS (` +
        `SELECT 'pg_class'::regclass AS classid, oid AS objid FROM target ` +
        `UNION ALL SELECT 'pg_type'::regclass, reltype FROM target ` +
        `UNION ALL SELECT 'pg_type'::regclass, t.typarray FROM pg_type t JOIN target ON t.oid = target.reltype WHERE t.typarray <> 0 ` +
        `UNION ALL SELECT 'pg_class'::regclass, o.objid FROM owned o JOIN pg_class s ON s.oid = o.objid ` +
        `WHERE o.classid = 'pg_class'::regclass AND s.relkind = 'S') ` +
        `SELECT DISTINCT d.classid::regclass::text AS catalog, ` +
        `CASE ` +
        `WHEN d.classid = 'pg_rewrite'::regclass THEN (SELECT CASE v.relkind WHEN 'm' THEN 'materialized view' ELSE 'view' END FROM pg_rewrite r JOIN pg_class v ON v.oid = r.ev_class WHERE r.oid = d.objid) ` +
        `WHEN d.classid = 'pg_policy'::regclass THEN 'policy' ` +
        `WHEN d.classid = 'pg_attrdef'::regclass THEN 'column default' ` +
        `WHEN d.classid = 'pg_proc'::regclass THEN 'function' ` +
        `WHEN d.classid = 'pg_trigger'::regclass THEN 'trigger' ` +
        `WHEN d.classid = 'pg_constraint'::regclass THEN 'constraint' ` +
        `WHEN d.classid = 'pg_class'::regclass AND d.objsubid > 0 THEN 'column' ` +
        `WHEN d.classid = 'pg_class'::regclass THEN (SELECT CASE WHEN EXISTS (SELECT 1 FROM pg_inherits i WHERE i.inhrelid = d.objid) THEN 'inheriting table' ELSE 'relation' END) ` +
        `ELSE 'object' END AS kind, ` +
        `CASE ` +
        `WHEN d.classid = 'pg_rewrite'::regclass THEN (SELECT v.relname FROM pg_rewrite r JOIN pg_class v ON v.oid = r.ev_class WHERE r.oid = d.objid) ` +
        `WHEN d.classid = 'pg_policy'::regclass THEN (SELECT p.polname || ' on ' || c.relname FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid WHERE p.oid = d.objid) ` +
        `WHEN d.classid = 'pg_attrdef'::regclass THEN (SELECT c.relname || '.' || a.attname FROM pg_attrdef ad JOIN pg_class c ON c.oid = ad.adrelid JOIN pg_attribute a ON a.attrelid = ad.adrelid AND a.attnum = ad.adnum WHERE ad.oid = d.objid) ` +
        `WHEN d.classid = 'pg_proc'::regclass THEN d.objid::regprocedure::text ` +
        `WHEN d.classid = 'pg_class'::regclass AND d.objsubid > 0 THEN (SELECT c.relname || '.' || a.attname FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = d.objsubid WHERE c.oid = d.objid) ` +
        `WHEN d.classid = 'pg_class'::regclass THEN (SELECT c.relname FROM pg_class c WHERE c.oid = d.objid) ` +
        `ELSE pg_describe_object(d.classid, d.objid, d.objsubid) END AS name ` +
        `FROM pg_depend d JOIN referenced r ON d.refclassid = r.classid AND d.refobjid = r.objid ` +
        `WHERE d.deptype = 'n' ` +
        `AND NOT EXISTS (SELECT 1 FROM owned o WHERE o.classid = d.classid AND o.objid = d.objid) ` +
        `AND NOT (d.classid = 'pg_class'::regclass AND d.objid IN (SELECT oid FROM target)) ` +
        `AND NOT (d.classid = 'pg_constraint'::regclass AND EXISTS (SELECT 1 FROM pg_constraint k WHERE k.oid = d.objid AND k.contype = 'f')) ` +
        `ORDER BY kind, name`,
    ),
  );
  return rows.map((row) => ({ kind: text(row.kind), name: text(row.name) }));
}

/**
 * PostgreSQL: functions whose body names the table. `pg_depend` records none
 * of this for a PL/pgSQL body, so the text is the evidence, matched as a whole
 * word. A function used only by triggers on the retired table goes unused
 * with it and is no dependent; one called by a trigger on another table names
 * that trigger; any other is named itself.
 */
async function readPostgresBodyDependents(
  db: DatabaseInterface,
  table: string,
): Promise<RetireDependent[]> {
  const functions = rowsOf(
    await db.query(
      `SELECT p.oid::text AS oid, p.oid::regprocedure::text AS name, p.prosrc AS src FROM pg_proc p ` +
        `JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang ` +
        `WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND l.lanname NOT IN ('c', 'internal') ` +
        `AND NOT EXISTS (SELECT 1 FROM pg_depend e WHERE e.classid = 'pg_proc'::regclass AND e.objid = p.oid AND e.deptype = 'e') ` +
        `ORDER BY 2`,
    ),
  ).filter((row) => mentions(text(row.src), table));
  const dependents: RetireDependent[] = [];
  for (const fn of functions) {
    const triggers = rowsOf(
      await db.query(
        `SELECT t.tgname AS name, c.relname AS on_table, ns.nspname AS schema FROM pg_trigger t ` +
          `JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_namespace ns ON ns.oid = c.relnamespace ` +
          `WHERE NOT t.tgisinternal AND t.tgfoid = ${quoteStringLiteral(text(fn.oid))}::oid ORDER BY c.relname, t.tgname`,
      ),
    );
    const elsewhere = triggers.filter(
      (row) =>
        !(
          text(row.schema) === RETIRE_POSTGRES_SCHEMA &&
          text(row.on_table) === table
        ),
    );
    if (triggers.length && !elsewhere.length) continue;
    if (elsewhere.length)
      for (const row of elsewhere)
        dependents.push({
          kind: 'trigger',
          name: `${text(row.name)} on ${text(row.on_table)}`,
        });
    else dependents.push({ kind: 'function', name: text(fn.name) });
  }
  return dependents;
}

/** Views, triggers, macros and functions that read or write `table`. */
async function readOtherDependents(
  db: DatabaseInterface,
  engine: DatabaseEngine,
  table: string,
): Promise<RetireDependent[]> {
  if (engine === 'postgres')
    return [
      ...(await readPostgresCatalogDependents(db, table)),
      ...(await readPostgresBodyDependents(db, table)),
    ];
  if (engine === 'duckdb') {
    // DuckDB has no triggers; a view or a macro names the table in its text.
    const views = rowsOf(
      await db.query(
        `SELECT view_name AS name, sql FROM duckdb_views() ` +
          `WHERE NOT internal AND database_name = current_database() ` +
          `AND schema_name = current_schema() ORDER BY view_name`,
      ),
    )
      .filter((row) => mentions(text(row.sql), table))
      .map((row) => ({ kind: 'view', name: text(row.name) }));
    const macros = rowsOf(
      await db.query(
        `SELECT DISTINCT function_name AS name, macro_definition AS sql FROM duckdb_functions() ` +
          `WHERE NOT internal AND function_type IN ('macro', 'table_macro') ORDER BY function_name`,
      ),
    )
      .filter((row) => mentions(text(row.sql), table))
      .map((row) => ({ kind: 'macro', name: text(row.name) }));
    return [...views, ...macros];
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
        ? { kind: 'view', name: text(row.name) }
        : {
            kind: 'trigger',
            name: `${text(row.name)} on ${text(row.tbl_name)}`,
          },
    );
}

/** One live table and every declaration that retires it. */
interface Retiring {
  /** The live table's own spelling. */
  table: string;
  /** Lower-cased, the key every lookup uses. */
  key: string;
  /** The declarations, by package. */
  entries: RetiredTable[];
  /** Rows may go only when every declaration says so. */
  discard: boolean;
}

const label = (item: Retiring) =>
  item.entries
    .map(
      (entry) =>
        `${entry.lastOwner}, retired in ${entry.since}: ${entry.reason}`,
    )
    .join('; ');

function retirementOf(
  item: Retiring,
  rows: number | null,
): NonNullable<SchemaChange['retirement']> {
  const [entry] = item.entries;
  return {
    packageName: item.entries.map((e) => e.packageName).join(', '),
    lastOwner: entry.lastOwner,
    since: entry.since,
    reason: entry.reason,
    rows,
  };
}

function stop(item: Retiring, kind: StopKind, message: string): SchemaChange {
  return {
    type: 'retire_table',
    kindHint: kind,
    table: item.table,
    advisory: { severity: 'warning', message },
    retirement: retirementOf(item, null),
  };
}

/** The declared definition as a table the differ can compare. */
function definitionSchema(
  table: string,
  definition: RetiredTableDefinition,
): SchemaDefinition {
  return {
    tableName: table,
    columns: Object.fromEntries(
      Object.entries(definition.columns).map(([name, column]) => [
        name,
        {
          type: column.type,
          ...(column.referenceKind
            ? { referenceKind: column.referenceKind }
            : {}),
        },
      ]),
    ),
    indexes: [],
    foreignKeys: [],
    triggers: [],
    dependencies: [],
    version: `retired:${definition.release}`,
  };
}

/**
 * What the differ found between the declared columns and the live ones: a
 * missing or extra column, or a type it does not tolerate. Constraints,
 * defaults and indexes are not part of the definition and are ignored.
 */
function shapeDifferences(changes: readonly SchemaChange[]): string[] {
  const out: string[] = [];
  for (const change of changes) {
    const column = change.name ?? '?';
    switch (change.type) {
      case 'add_column':
        out.push(`column ${column} is missing`);
        break;
      case 'orphan_column':
      case 'drop_column':
        out.push(`column ${column} is not in the definition`);
        break;
      case 'type_mismatch':
      case 'type_upgrade':
        if (classifySchemaChange(change) === 'type.noop') break;
        out.push(
          `column ${column} is ${change.mismatch?.actual ?? 'another type'}, declared ${change.mismatch?.expected ?? 'otherwise'}`,
        );
        break;
      case 'rename_data_pending':
        out.push(`column ${column} looks renamed`);
        break;
      default:
        break;
    }
  }
  return [...new Set(out)].sort(byName);
}

/**
 * Plan every declared retirement against the live database. Changes come back
 * stops first in table order, then the drops in an order that drops a table
 * before the retired tables it references.
 * @internal The differ calls this; it is not part of the public API.
 */
export async function planTableRetirements(
  options: PlanTableRetirementsOptions,
): Promise<SchemaChange[]> {
  const { db, engine, liveTables, declaredBy, schemas } = options;
  const caseless = engine !== 'postgres';
  const live = new Map<string, string>();
  for (const name of liveTables)
    live.set(caseless ? name.toLowerCase() : name, name);

  // One item per live table; every declaration of it counts.
  const groups = new Map<string, Retiring>();
  for (const entry of options.retired) {
    const key = entry.table.toLowerCase();
    const table = live.get(caseless ? key : entry.table);
    if (!table) continue; // Absent: nothing to do.
    const item = groups.get(key) ?? {
      table,
      key,
      entries: [],
      discard: true,
    };
    item.entries.push(entry);
    item.discard &&= entry.rows === 'discard';
    groups.set(key, item);
  }
  const items = [...groups.values()].sort((a, b) => byName(a.key, b.key));
  for (const item of items)
    item.entries.sort((a, b) => byName(a.packageName, b.packageName));

  const stops: SchemaChange[] = [];
  if (!items.length) return stops;
  if (engine === 'json') {
    for (const item of items)
      stops.push(
        stop(
          item,
          'table.retire-unsupported',
          `${item.table} is declared retired (${label(item)}) but the JSON adapter cannot check what depends on a table, so it never drops one. Remove the table's data by hand. It is not dropped.`,
        ),
      );
    return stops;
  }

  // Run-time models stored in the database declare tables too, though this
  // process never registered them (R10).
  const stored = await readStoredRuntimeModelTables(db, engine, liveTables);
  const candidates: Retiring[] = [];
  for (const item of items) {
    const refused = item.entries.flatMap((entry) => {
      try {
        parseCarriedRetiredTable(entry);
        return [];
      } catch (error) {
        return [error instanceof Error ? error.message : String(error)];
      }
    });
    if (refused.length) {
      for (const why of refused)
        stops.push(
          stop(item, 'table.retire-owner', `${why} It is not dropped.`),
        );
      continue;
    }
    if (stored.unreadable) {
      stops.push(
        stop(
          item,
          'table.retire-declared',
          `${item.table} is declared retired (${label(item)}) but ${stored.unreadable}, so a run-time model may still declare the table. It is not dropped.`,
        ),
      );
      continue;
    }
    const owners = [
      ...(declaredBy.get(item.key) ?? []),
      ...(stored.tables.get(item.key) ?? []),
    ];
    if (owners.length) {
      stops.push(
        stop(
          item,
          'table.retire-declared',
          `${item.table} is declared retired (${label(item)}) but ${owners.join(', ')} still declare${owners.length === 1 ? 's' : ''} it. A table cannot be both. Remove the retirement, or remove the model.`,
        ),
      );
      continue;
    }
    // The live table must be the table the declaration describes.
    let mismatch: string | undefined;
    for (const entry of item.entries) {
      let differences: string[];
      try {
        differences = shapeDifferences(
          await options.compareDefinition(
            item.table,
            definitionSchema(item.table, entry.definition),
          ),
        );
      } catch (error) {
        differences = [
          `it could not be compared (${error instanceof Error ? error.message : String(error)})`,
        ];
      }
      if (differences.length) {
        mismatch = `${item.table} is declared retired (${label(item)}) but the live table is not the one ${entry.packageName} describes (its definition from release ${entry.definition.release}): ${differences.join('; ')}. It is not dropped.`;
        break;
      }
    }
    if (mismatch) {
      stops.push(stop(item, 'table.retire-mismatch', mismatch));
      continue;
    }
    candidates.push(item);
  }
  const retiring = new Set(candidates.map((item) => item.key));

  // Edges between tables retired in this run: the referencing table goes first.
  const edges = new Map<string, Set<string>>();
  const droppable: Array<{ item: Retiring; rows: number | null }> = [];
  for (const item of candidates) {
    const rows = await countRows(db, engine, item.table);
    if (!item.discard && (rows === null || rows > 0)) {
      stops.push(
        stop(
          item,
          'table.retire-rows',
          rows === null
            ? `${item.table} is declared retired (${label(item)}) without rows: 'discard', and its rows could not be counted. It is not dropped.`
            : `${item.table} holds ${rows} row(s) and its retirement (${label(item)}) does not say rows: 'discard'. It is not dropped.`,
        ),
      );
      continue;
    }

    const dependents: RetireDependent[] = [];
    const seen = new Set<string>();
    for (const fk of await readInboundForeignKeys(db, engine, item.table)) {
      const child = fk.child.toLowerCase();
      if (retiring.has(child)) {
        const parents = edges.get(child) ?? new Set<string>();
        parents.add(item.key);
        edges.set(child, parents);
        continue;
      }
      const key = `${fk.child}.${fk.columns}`;
      seen.add(key.toLowerCase());
      dependents.push({ kind: 'foreign key', name: key });
    }
    // A model the build declares that references the table also depends on it.
    for (const [child, schema] of Object.entries(schemas)) {
      const childKey = child.toLowerCase();
      if (childKey === item.key || retiring.has(childKey)) continue;
      for (const fk of schemaForeignKeys(schema)) {
        if (fk.referencesTable.toLowerCase() !== item.key) continue;
        const key = `${child}.${fk.column}`;
        if (seen.has(key.toLowerCase())) continue;
        seen.add(key.toLowerCase());
        dependents.push({ kind: 'foreign key', name: key });
      }
    }
    dependents.push(...(await readOtherDependents(db, engine, item.table)));

    if (dependents.length) {
      for (const dependent of dependents)
        stops.push(
          stop(
            item,
            'table.retire-dependent',
            `${item.table} is declared retired (${label(item)}) but ${dependent.kind} ${dependent.name} depends on it. It is not dropped.`,
          ),
        );
      continue;
    }
    droppable.push({ item, rows });
  }

  // Drop referencing tables first. What cannot be ordered is a cycle: named.
  const dropping = new Set(droppable.map(({ item }) => item.key));
  const ordered: typeof droppable = [];
  const pending = [...droppable];
  while (pending.length) {
    const next = pending.findIndex(({ item }) =>
      [...dropping].every(
        (other) => other === item.key || !edges.get(other)?.has(item.key),
      ),
    );
    if (next === -1) break;
    const [done] = pending.splice(next, 1);
    ordered.push(done);
    dropping.delete(done.item.key);
  }
  for (const { item } of pending)
    stops.push(
      stop(
        item,
        'table.retire-dependent',
        `${item.table} is declared retired (${label(item)}) but retired tables ${pending.map((other) => other.item.table).join(', ')} reference each other, so no order drops them. Remove one foreign key first. It is not dropped.`,
      ),
    );

  const drops = ordered.map(({ item, rows }): SchemaChange => {
    const target = qualified(engine, item.table);
    const sql = `DROP TABLE IF EXISTS ${target}`;
    // The count above ran outside any transaction. Without rows: 'discard'
    // the batch counts again right before the drop and rolls back if rows
    // appeared; PostgreSQL first locks out every writer (R2).
    const sqlStatements = item.discard
      ? [sql]
      : [
          ...(engine === 'postgres'
            ? [`LOCK TABLE ${target} IN ACCESS EXCLUSIVE MODE`]
            : []),
          retireRowsGuardSql(target),
          sql,
        ];
    const [entry] = item.entries;
    return {
      type: 'retire_table',
      kindHint: 'table.retire',
      table: item.table,
      sql,
      ...(sqlStatements.length > 1 ? { sqlStatements } : {}),
      note: `Retired in ${entry.since} (${item.entries.map((e) => e.lastOwner).join(', ')}): ${entry.reason}${
        item.discard
          ? rows === null
            ? ' Its rows are discarded.'
            : ` ${rows} row(s) discarded.`
          : ''
      }`,
      retirement: retirementOf(item, rows),
    };
  });
  return [...stops, ...drops];
}
