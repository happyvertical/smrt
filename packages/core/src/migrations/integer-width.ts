/**
 * Explicit one-time widening for deployments created before #2373.
 *
 * Fresh PostgreSQL and DuckDB schemas now materialize SMRT's abstract
 * `INTEGER` as `BIGINT`. The migration differ deliberately treats int4 and
 * int8 as equivalent, so existing deployments need this separate, operator
 * initiated maintenance-window migration rather than an automatic repair.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import { parsePostgresTimeoutMs } from '../postgres-timeouts.js';
import { detectEngine } from '../schema/ddl/index.js';
import { getSystemTableShapes } from '../schema/system-table-shapes.js';
import type { SchemaDefinition } from '../schema/types.js';
import { toSafeInteger } from '../utils/safe-integer.js';
import { BackfillTracker } from './backfill-tracker.js';

const DEFAULT_POSTGRES_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 60_000;

/** A table and its SMRT-owned integer columns. */
export interface IntegerWidthTarget {
  table: string;
  columns: string[];
}

/** The width state of one declared integer column. */
export type IntegerWidthColumnState =
  | 'pending'
  | 'current'
  | 'missing'
  | 'unexpected';

/** Preflight finding for one declared integer column. */
export interface IntegerWidthColumnReport {
  table: string;
  column: string;
  state: IntegerWidthColumnState;
  /** Live `information_schema.columns.data_type`, when the column exists. */
  declaredType: string | null;
}

/** Preflight findings for a single SMRT-owned table. */
export interface IntegerWidthTableReport {
  table: string;
  /** Number of rows when at least one column still needs widening. */
  rowCount: number | null;
  columns: IntegerWidthColumnReport[];
}

/** Read-only assessment of a deployment's legacy int4 columns. */
export interface IntegerWidthPreflightResult {
  engine: string;
  /** False for SQLite and adapters without a native 32-bit integer width. */
  supported: boolean;
  tables: IntegerWidthTableReport[];
  pendingColumns: number;
  currentColumns: number;
  missingColumns: number;
  unexpectedColumns: number;
  /** Tables that need a maintenance-window table rewrite. */
  pendingTables: number;
  /** Human-readable output suitable for an operator change record. */
  summary: string;
}

/** Shared options for the read-only preflight and mutating widening pass. */
export interface IntegerWidthOptions {
  /** Adapter hint when its URL does not identify the engine. */
  engineHint?: string;
}

/** Options that make the widening pass safely repeatable. */
export interface IntegerWidthWidenOptions extends IntegerWidthOptions {
  /** Stable `_smrt_backfills` audit marker, unique to this migration owner. */
  backfillName: string;
  /** Package recorded alongside the marker. */
  packageName?: string;
  /** PostgreSQL lock timeout in milliseconds (defaults to 30 seconds). */
  lockTimeout?: number;
  /** PostgreSQL statement timeout in milliseconds (defaults to 60 seconds). */
  statementTimeout?: number;
}

/** Result of {@link widenIntegerColumnsToBigInt}. */
export interface IntegerWidthWidenResult {
  /** False when no legacy columns remain or the engine is unsupported. */
  ran: boolean;
  preflight: IntegerWidthPreflightResult;
  widenedColumns: Array<{ table: string; column: string }>;
  statements: string[];
}

/**
 * Collect every integer column owned by loaded application schemas and, when
 * requested, by hand-written core system-table DDL.
 */
export function collectIntegerWidthTargets(
  schemas: Record<string, SchemaDefinition>,
  options: { includeSystemTables?: boolean } = {},
): IntegerWidthTarget[] {
  const byTable = new Map<string, Set<string>>();
  const add = (table: string, column: string) => {
    if (!byTable.has(table)) byTable.set(table, new Set());
    byTable.get(table)?.add(column);
  };

  for (const [key, schema] of Object.entries(schemas)) {
    const table = schema?.tableName || key;
    for (const [column, definition] of Object.entries(schema?.columns ?? {})) {
      if (definition.type === 'INTEGER') add(table, column);
    }
  }

  if (options.includeSystemTables ?? true) {
    for (const shape of getSystemTableShapes('postgres').values()) {
      for (const column of shape.columns) {
        if (isBigIntType(column.type)) add(shape.tableName, column.name);
      }
    }
  }

  return [...byTable]
    .map(([table, columns]) => ({ table, columns: [...columns].sort() }))
    .sort((left, right) => left.table.localeCompare(right.table));
}

/** Build the exact, lossless ALTER statement for one target column. */
export function buildIntegerWidthStatements(
  engine: string,
  table: string,
  column: string,
): string[] {
  return buildIntegerWidthTableStatements(engine, table, [column]);
}

/**
 * Build lossless widening statements for every pending column in one table.
 *
 * PostgreSQL performs a table rewrite for an integer-width change, so all of
 * one table's pending columns must share one ALTER TABLE and one lock window.
 * DuckDB keeps its one-column form because its ALTER COLUMN grammar is not
 * equivalently composable across supported adapter versions.
 */
export function buildIntegerWidthTableStatements(
  engine: string,
  table: string,
  columns: string[],
): string[] {
  const quotedTable = quoteIdentifier(table);
  const quotedColumns = columns.map(quoteIdentifier);
  if (quotedColumns.length === 0) return [];
  if (engine !== 'postgres' && engine !== 'duckdb') return [];
  if (engine === 'postgres') {
    return [
      `ALTER TABLE ${quotedTable} ${quotedColumns
        .map((column) => `ALTER COLUMN ${column} TYPE BIGINT`)
        .join(', ')}`,
    ];
  }
  return quotedColumns.map(
    (column) => `ALTER TABLE ${quotedTable} ALTER COLUMN ${column} TYPE BIGINT`,
  );
}

/**
 * Inspect explicit SMRT-owned integer targets without changing the database.
 *
 * PostgreSQL and DuckDB expose their live widths through
 * `information_schema.columns`. SQLite is deliberately a no-op because its
 * INTEGER storage class already holds signed 64-bit values.
 */
export async function preflightIntegerWidthWidening(
  db: DatabaseInterface,
  targets: IntegerWidthTarget[],
  options: IntegerWidthOptions = {},
): Promise<IntegerWidthPreflightResult> {
  const engine = resolveEngine(db, options.engineHint);
  const normalizedTargets = normalizeTargets(targets);
  if (engine !== 'postgres' && engine !== 'duckdb') {
    const result = {
      engine,
      supported: false,
      tables: [],
      pendingColumns: 0,
      currentColumns: 0,
      missingColumns: 0,
      unexpectedColumns: 0,
      pendingTables: 0,
    };
    return {
      ...result,
      summary:
        `Integer-width widening preflight (engine=${engine}): not applicable; ` +
        'this engine does not expose a distinct native int4 storage type.',
    };
  }

  const tables: IntegerWidthTableReport[] = [];
  for (const target of normalizedTargets) {
    const types = await readColumnTypes(db, engine, target.table);
    const columns = target.columns.map((column) => {
      const declaredType = types.get(column) ?? null;
      return {
        table: target.table,
        column,
        declaredType,
        state: classifyIntegerWidth(declaredType),
      };
    });
    const needsWidening = columns.some((column) => column.state === 'pending');
    tables.push({
      table: target.table,
      rowCount: needsWidening ? await countRows(db, target.table) : null,
      columns,
    });
  }

  const allColumns = tables.flatMap((table) => table.columns);
  const result = {
    engine,
    supported: true,
    tables,
    pendingColumns: allColumns.filter((column) => column.state === 'pending')
      .length,
    currentColumns: allColumns.filter((column) => column.state === 'current')
      .length,
    missingColumns: allColumns.filter((column) => column.state === 'missing')
      .length,
    unexpectedColumns: allColumns.filter(
      (column) => column.state === 'unexpected',
    ).length,
    pendingTables: tables.filter((table) =>
      table.columns.some((column) => column.state === 'pending'),
    ).length,
  };
  return { ...result, summary: renderSummary(result) };
}

/**
 * Widen legacy int4 columns to BIGINT and record a marker after every ALTER
 * succeeds. This is intentionally never called by normal schema migration or
 * framework bootstrap: PostgreSQL rewrites each altered table.
 */
export async function widenIntegerColumnsToBigInt(
  db: DatabaseInterface,
  targets: IntegerWidthTarget[],
  options: IntegerWidthWidenOptions,
): Promise<IntegerWidthWidenResult> {
  const preflight = await preflightIntegerWidthWidening(db, targets, options);
  if (!preflight.supported) {
    return { ran: false, preflight, widenedColumns: [], statements: [] };
  }
  if (preflight.unexpectedColumns > 0) {
    throw new Error(
      'Integer-width widening refused because declared integer columns have unexpected live types. Resolve ordinary schema drift first.\n' +
        preflight.summary,
    );
  }

  // Current declared widths are the idempotency guard. A fixed marker cannot
  // safely be the guard because a later successful discovery may reveal a
  // package/table absent from the earlier target set.
  if (preflight.pendingColumns === 0) {
    return { ran: false, preflight, widenedColumns: [], statements: [] };
  }

  const statements: string[] = [];
  const widenedColumns: Array<{ table: string; column: string }> = [];
  const tracker = new BackfillTracker({ db });
  await tracker.initialize();

  const applyWidening = async (writeDb: DatabaseInterface) => {
    for (const table of preflight.tables) {
      const pendingColumns = table.columns
        .filter((column) => column.state === 'pending')
        .map((column) => column.column);
      if (pendingColumns.length === 0) continue;
      for (const sql of buildIntegerWidthTableStatements(
        preflight.engine,
        table.table,
        pendingColumns,
      )) {
        await writeDb.query(sql);
        statements.push(sql);
      }
      widenedColumns.push(
        ...pendingColumns.map((column) => ({ table: table.table, column })),
      );
    }

    await new BackfillTracker({ db: writeDb }).recordApplied(
      options.backfillName,
      {
        description:
          'Widened legacy int4 SMRT columns to BIGINT after #2373 changed fresh-schema defaults.',
        packageName: options.packageName,
      },
    );
  };

  if (preflight.engine === 'postgres') {
    if (!db.transaction) {
      throw new Error(
        'Integer-width widening on PostgreSQL requires transaction support.',
      );
    }
    const lockTimeout = parsePostgresTimeoutMs(
      options.lockTimeout,
      DEFAULT_POSTGRES_LOCK_TIMEOUT_MS,
    );
    const statementTimeout = parsePostgresTimeoutMs(
      options.statementTimeout,
      DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
    );
    await db.transaction(async (tx) => {
      const txDb = {
        ...tx,
        transaction: async <T>(
          callback: (transactionDb: DatabaseInterface) => Promise<T>,
        ) => callback(tx as DatabaseInterface),
      } as DatabaseInterface;
      BackfillTracker.inheritInitialization(txDb, db);
      await txDb.query(
        `SET LOCAL lock_timeout = '${formatPostgresTimeout(lockTimeout)}'`,
      );
      await txDb.query(
        `SET LOCAL statement_timeout = '${formatPostgresTimeout(statementTimeout)}'`,
      );
      await applyWidening(txDb);
    });
  } else {
    await applyWidening(db);
  }

  return { ran: true, preflight, widenedColumns, statements };
}

function resolveEngine(db: DatabaseInterface, engineHint?: string): string {
  const dbWithConfig = db as DatabaseInterface & { config?: { url?: string } };
  return detectEngine(db.url || dbWithConfig.config?.url || '', engineHint);
}

function normalizeTargets(targets: IntegerWidthTarget[]): IntegerWidthTarget[] {
  const byTable = new Map<string, Set<string>>();
  for (const target of targets) {
    quoteIdentifier(target.table);
    if (!byTable.has(target.table)) byTable.set(target.table, new Set());
    for (const column of target.columns) {
      quoteIdentifier(column);
      byTable.get(target.table)?.add(column);
    }
  }
  return [...byTable]
    .map(([table, columns]) => ({ table, columns: [...columns].sort() }))
    .sort((left, right) => left.table.localeCompare(right.table));
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Integer-width widening: '${name}' is not a plain SQL identifier.`,
    );
  }
  return `"${name}"`;
}

function formatPostgresTimeout(milliseconds: number): string {
  return `${milliseconds}ms`;
}

function isLegacyInt4Type(type: string): boolean {
  return /^(INTEGER|INT|INT4)$/i.test(type.trim());
}

function isBigIntType(type: string): boolean {
  return /^(BIGINT|INT8)$/i.test(type.trim());
}

function classifyIntegerWidth(type: string | null): IntegerWidthColumnState {
  if (type === null) return 'missing';
  if (isLegacyInt4Type(type)) return 'pending';
  if (isBigIntType(type)) return 'current';
  return 'unexpected';
}

async function readColumnTypes(
  db: DatabaseInterface,
  engine: string,
  table: string,
): Promise<Map<string, string>> {
  const result = await db.query(
    engine === 'postgres'
      ? `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = ?`
      : `SELECT column_name, data_type
           FROM information_schema.columns
          WHERE table_name = ?`,
    table,
  );
  const types = new Map<string, string>();
  for (const row of result.rows as {
    column_name?: unknown;
    data_type?: unknown;
  }[]) {
    if (typeof row.column_name === 'string') {
      types.set(row.column_name, String(row.data_type ?? ''));
    }
  }
  return types;
}

async function countRows(
  db: DatabaseInterface,
  table: string,
): Promise<number> {
  const result = await db.query(
    `SELECT COUNT(*) AS row_count FROM ${quoteIdentifier(table)}`,
  );
  return toSafeInteger(
    result.rows?.[0]?.row_count ?? 0,
    `Integer-width row count for ${table}`,
  );
}

function renderSummary(
  result: Omit<IntegerWidthPreflightResult, 'summary'>,
): string {
  const lines = [
    `Integer-width widening preflight (engine=${result.engine})`,
    `  tables: ${result.pendingTables} pending`,
    `  columns: ${result.pendingColumns} pending, ${result.currentColumns} already BIGINT, ${result.missingColumns} missing, ${result.unexpectedColumns} unexpected`,
  ];
  for (const table of result.tables) {
    const pending = table.columns.filter(
      (column) => column.state === 'pending',
    );
    if (pending.length === 0) continue;
    lines.push(
      `  - ${table.table}: ${table.rowCount ?? 0} row(s); ${pending
        .map((column) => `${column.column} (${column.declaredType})`)
        .join(', ')}`,
    );
  }
  return lines.join('\n');
}
