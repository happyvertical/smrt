/**
 * Money-column rescale: floating-point major units → integer minor units (#2401).
 *
 * SMRT's rule is that money is exact and is stored as **integer minor units**
 * at an application-defined scale — `$19.99` is `1999` at a cents scale.
 * Packages that predate the rule
 * declared their money fields `= 0.0`, which compiles to a floating-point
 * column holding *major* units. Flipping the declaration to `= 0` changes the
 * column type, and REAL→INTEGER is deliberately **not** one of the differ's
 * whitelisted upgrades: an automatic `ALTER … TYPE BIGINT` would truncate
 * `19.99` to `19`, silently destroying minor units on every row.
 *
 * So the conversion is an explicit, opt-in migration with two halves:
 *
 *  1. {@link preflightMinorUnitsRescale} — read-only. Reports, per column,
 *     whether it still needs converting, and lists the rows that would lose
 *     information: values whose scaled form is not a whole number (a half-cent
 *     that has to be rounded away) and values that exceed JavaScript's safe
 *     integer range once multiplied by the scale. Run it against a production
 *     snapshot and
 *     read the summary before converting anything.
 *  2. {@link rescaleMoneyColumnsToMinorUnits} — the conversion itself. The
 *     check of what still needs converting, every statement, and the
 *     {@link BackfillTracker} marker that says it is done are one transaction,
 *     so re-running it can never multiply a table by 100 twice: a run that
 *     fails or is killed part-way leaves every column and the marker as they
 *     were, and a second runner waits for the first and then finds the work
 *     done.
 *
 * Per-engine behaviour:
 *
 * | Engine | Column type | Values |
 * | --- | --- | --- |
 * | PostgreSQL | `ALTER COLUMN … TYPE BIGINT USING round(col * scale)` | converted by the cast |
 * | DuckDB | `ALTER COLUMN … TYPE BIGINT USING round(col * scale)` | converted by the cast |
 * | SQLite | **not changed here** — SQLite cannot alter a column's declared type in place | rescaled with an `UPDATE`, values become exact integers |
 *
 * SQLite's declared type only sets an affinity, so a rescaled column already
 * behaves as integer minor units; bringing the *declaration* into line needs
 * the table-rebuild path (#2370). The result flags that with
 * {@link MinorUnitsRescaleResult.declaredTypeChangePending} rather than
 * pretending the column type moved, and each such column gets its own marker
 * ({@link minorUnitsColumnMarker}) in the same transaction, from which the
 * next migrate rebuilds the declaration to integer (#5454).
 */

import { isJsonAdapterHandle } from '../native-duckdb.js';
import { detectEngine } from '../schema/ddl/index.js';
import { runBackfillOnceInTransaction } from './backfill-once.js';
import { BackfillTracker } from './backfill-tracker.js';
import { assertTablesReadable } from './row-security.js';
import type { DatabaseInterface } from './types.js';

/** Hydrated integers must remain exactly representable in JavaScript. */
const MIN_SAFE_INTEGER = -Number.MAX_SAFE_INTEGER;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

/**
 * How far a scaled value may sit from a whole number and still count as
 * integral.
 *
 * `19.99 * 100` is `1998.9999999999998` in IEEE-754, so a zero tolerance would
 * report every ordinary two-decimal price as non-integral. A genuine half-cent
 * is off by `0.5`, five orders of magnitude above this bound, so the two cases
 * never blur.
 */
const INTEGRALITY_TOLERANCE = 1e-6;

/** Default minor units per major unit — cents. */
const DEFAULT_SCALE = 100;

/**
 * The `_smrt_backfills` name recorded for one column the rescale converted
 * while leaving its floating-point declaration (SQLite): migrate reads it to
 * change that column's declared type to integer (#5454). It carries the
 * column's state right after the rescale ({@link minorUnitsColumnState}), so
 * it vouches only for those exact contents: any row written, changed or
 * removed since makes the state differ and the marker no longer applies.
 */
export function minorUnitsColumnMarker(
  table: string,
  column: string,
  state: string,
): string {
  return `smrt:minor-units:${table}.${column}@${state}`;
}

/**
 * SQL for a SQLite column's state as {@link minorUnitsColumnMarker} records
 * it: the row count, the sum of the column, the largest rowid and the sum of
 * the rowids. Returns one row with `n`, `s`, `m` and `r`.
 */
export function minorUnitsColumnStateSql(
  table: string,
  column: string,
): string {
  return `SELECT COUNT(*) AS n, TOTAL(${quoteIdentifier(column)}) AS s, COALESCE(MAX(rowid), 0) AS m, TOTAL(rowid) AS r FROM ${quoteIdentifier(table)}`;
}

/**
 * A SQLite column's state (see {@link minorUnitsColumnStateSql}) as text,
 * or `null` when it cannot be read (a table without rowid, say): such a
 * column cannot be vouched for.
 */
export async function minorUnitsColumnState(
  db: DatabaseInterface,
  table: string,
  column: string,
): Promise<string | null> {
  try {
    const row = (await db.query(minorUnitsColumnStateSql(table, column)))
      .rows[0] as Record<string, unknown> | undefined;
    if (!row) return null;
    return ['n', 's', 'm', 'r']
      .map((key) => String(Number(row[key])))
      .join(':');
  } catch {
    return null;
  }
}

/**
 * Round half away from zero, the way SQL `round()` does — and the way
 * `Math.round` does not.
 *
 * `Math.round` rounds halves toward +∞, so `Math.round(-0.5)` is `-0` while
 * SQLite's and DuckDB's `round(-0.5)` is `-1`. Money here can legitimately be
 * negative (`BillingAdjustment.amount` is a signed credit), so a preflight that
 * predicted the conversion with `Math.round` would report a value one minor
 * unit above what the database actually stores. The PostgreSQL DDL casts to
 * `numeric` for the same reason — see {@link buildMinorUnitsStatements}.
 */
function roundHalfAwayFromZero(value: number): number {
  return Math.sign(value) * Math.round(Math.abs(value));
}

/** A table and the money columns on it that must move to minor units. */
export interface MoneyColumnTarget {
  /** Physical table name, e.g. `payments`. */
  table: string;
  /** Physical column names, e.g. `['amount', 'native_amount']`. */
  columns: string[];
}

/** What the preflight found about one column. */
export type MinorUnitsColumnState =
  /** Floating-point today: needs converting. */
  | 'pending'
  /** Already an integer column: nothing to do. */
  | 'converted'
  /** Table or column absent (package not installed, older schema). */
  | 'missing';

/** One row that cannot be converted without losing information. */
export interface MinorUnitsProblemRow {
  /** Primary key, when the table has an `id` column. */
  id: string | null;
  /** The stored major-unit value. */
  value: number;
  /** `value * scale`, before rounding. */
  scaled: number;
}

/** Preflight findings for a single column. */
export interface MinorUnitsColumnReport {
  table: string;
  column: string;
  state: MinorUnitsColumnState;
  /** Declared column type as the database reports it, when resolvable. */
  declaredType: string | null;
  /** Non-null values inspected. `0` unless `state` is `pending`. */
  inspectedRows: number;
  /** Values whose scaled form is not a whole number — rounding loses money. */
  nonIntegral: MinorUnitsProblemRow[];
  /** Values whose scaled form exceeds JavaScript's safe integer range. */
  overflow: MinorUnitsProblemRow[];
}

/** Result of {@link preflightMinorUnitsRescale}. */
export interface MinorUnitsPreflightResult {
  engine: string;
  scale: number;
  columns: MinorUnitsColumnReport[];
  /** Columns still holding floating-point major units. */
  pendingColumns: number;
  /** Columns already integer. */
  convertedColumns: number;
  /** Columns whose table/column does not exist. */
  missingColumns: number;
  /** Total rows that would be rounded. */
  nonIntegralRows: number;
  /** Total rows that would exceed JavaScript's safe integer range. */
  overflowRows: number;
  /** No row would lose information. */
  ok: boolean;
  /** Human-readable report, suitable for pasting into a migration log or PR. */
  summary: string;
}

/** Options shared by the preflight and the rescale. */
export interface MinorUnitsOptions {
  /** Minor units per major unit. Default `100` (cents). */
  scale?: number;
  /** Engine hint for adapters whose URL does not identify the engine. */
  engineHint?: string;
  /** Problem rows recorded per column before truncating. Default `20`. */
  maxProblemRows?: number;
}

/** Options for {@link rescaleMoneyColumnsToMinorUnits}. */
export interface MinorUnitsRescaleOptions extends MinorUnitsOptions {
  /**
   * Stable marker name recorded in `_smrt_backfills`, e.g.
   * `@happyvertical/smrt-commerce:money-minor-units:v1`.
   *
   * This is what makes the migration idempotent on SQLite, where the rescale
   * is an `UPDATE` no column type can distinguish from an unconverted table.
   */
  backfillName: string;
  /** Package recorded alongside the marker. */
  packageName?: string;
  /**
   * Convert even when the preflight found rows that would be rounded or
   * overflow. Off by default: silently rounding a half-cent away is exactly
   * the failure this migration exists to prevent.
   */
  force?: boolean;
}

/** Result of {@link rescaleMoneyColumnsToMinorUnits}. */
export interface MinorUnitsRescaleResult {
  /** `false` when the backfill marker was already present. */
  ran: boolean;
  engine: string;
  scale: number;
  /** The preflight that gated the run. */
  preflight: MinorUnitsPreflightResult;
  /** Columns whose values were rescaled. */
  rescaledColumns: Array<{ table: string; column: string }>;
  /** Statements executed, in order — useful for logs and tests. */
  statements: string[];
  /**
   * Columns whose values are now minor units but whose *declared* type is
   * still floating-point. Only ever populated on SQLite, which cannot alter a
   * column type in place; clearing it needs the table-rebuild path (#2370).
   */
  declaredTypeChangePending: Array<{ table: string; column: string }>;
}

/**
 * A money-losing preflight finding blocked the conversion.
 *
 * Carries the full preflight so a caller can print the summary, fix the data,
 * and retry rather than re-deriving what went wrong.
 */
export class MinorUnitsPreflightError extends Error {
  constructor(readonly preflight: MinorUnitsPreflightResult) {
    super(
      `Money minor-units rescale refused: ${preflight.nonIntegralRows} row(s) ` +
        `would be rounded and ${preflight.overflowRows} row(s) would overflow ` +
        "JavaScript's safe integer range. Fix the data or pass `force: true` to accept the rounding.\n" +
        preflight.summary,
    );
    this.name = 'MinorUnitsPreflightError';
  }
}

function resolveDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseInterface & { config?: { url?: string } };
  return db.url || dbWithConfig.config?.url || '';
}

function resolveEngine(db: DatabaseInterface, engineHint?: string): string {
  if (typeof (db as { exportTable?: unknown }).exportTable === 'function')
    return 'json';
  // A DuckDB handle (a transaction one too) names its engine; its URL
  // (`:memory:`) alone reads as SQLite.
  const own = (db as { engine?: unknown }).engine;
  return detectEngine(
    resolveDatabaseUrl(db),
    engineHint ?? (own === 'duckdb' ? 'duckdb' : undefined),
  );
}

/**
 * Does `exportTable` prove the handle never exports a table by itself?
 *
 * A native DuckDB handle exposes `exportTable` whatever its write strategy is.
 * With the default strategy (`none`) it refuses before touching anything and
 * says so; with `manual` or `immediate` it tries to export the table and fails
 * on one that does not exist (nothing is written). Only the first answer proves
 * the handle has no JSON export in play: any other outcome is treated as
 * export-backed.
 */
async function exportNeverRuns(db: DatabaseInterface): Promise<boolean> {
  try {
    await (
      db as unknown as { exportTable(table: string): Promise<void> }
    ).exportTable('smrt_export_probe_missing_table');
  } catch (error) {
    const context = (error as { context?: { writeStrategy?: unknown } })
      ?.context;
    return context?.writeStrategy === 'none';
  }
  return false;
}

/**
 * Refuse a handle backed by JSON-file export (the JSON adapter, a transaction
 * scope reporting the `json` engine, or a DuckDB handle whose write strategy
 * exports tables) before anything is read or written.
 *
 * Such a handle keeps its tables in an in-memory DuckDB database and exports a
 * table to disk from its own `insert`/`update`/`delete`. A raw conversion and
 * its marker change memory only, so a later ordinary write would persist one
 * table without the marker, and a rerun after a restart would convert it
 * again. Run the rescale on a SQLite, PostgreSQL or DuckDB handle without JSON
 * export (a native DuckDB handle with write strategy `none`, or the handle of a
 * DuckDB transaction). A `json` engine hint is refused the same way, so
 * `preflight.engine` read back from a JSON-backed root and fed in as the hint
 * is refused too. The hint is trimmed and lowercased first.
 */
async function refuseJsonBackedHandle(
  db: DatabaseInterface,
  engineHint?: string,
): Promise<void> {
  const own = (db as { engine?: unknown }).engine;
  const exports =
    typeof (db as { exportTable?: unknown }).exportTable === 'function';
  if (
    String(engineHint ?? '')
      .trim()
      .toLowerCase() === 'json' ||
    own === 'json' ||
    isJsonAdapterHandle(db) ||
    (exports && !(await exportNeverRuns(db)))
  ) {
    throw new Error(
      'Money minor-units rescale does not support a handle backed by JSON export: its converted values and marker would not be persisted together. Run it on a SQLite, PostgreSQL or DuckDB handle without JSON export.',
    );
  }
}

/**
 * Quote an identifier for DDL.
 *
 * Table and column names here come from a package's own migration module, not
 * from user input, but a rejected embedded quote is cheaper than trusting that
 * forever.
 */
function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `Money minor-units rescale: '${name}' is not a plain SQL identifier.`,
    );
  }
  return `"${name}"`;
}

/** Is this declared type a floating-point one that still needs converting? */
function isFloatingType(declaredType: string): boolean {
  return /^(REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|NUMBER)/i.test(
    declaredType.trim(),
  );
}

/** Is this declared type already an integer one? */
function isIntegerType(declaredType: string): boolean {
  return /^(INTEGER|INT|INT4|INT8|BIGINT|SMALLINT|TINYINT|HUGEINT)\b/i.test(
    declaredType.trim(),
  );
}

/**
 * Read declared column types for one table.
 *
 * PostgreSQL and DuckDB both expose `information_schema.columns`; SQLite does
 * not, so it uses `PRAGMA table_xinfo`. Returns an empty map when the table does
 * not exist, which the caller reports as `missing` rather than an error — a
 * package's migration lists its own tables, and a deployment may legitimately
 * not have created all of them yet. A catalog read that fails is not a missing
 * table: the error propagates, so a conversion never skips a table it could not
 * inspect and still records its marker.
 */
async function readColumnTypes(
  db: DatabaseInterface,
  engine: string,
  table: string,
): Promise<Map<string, string>> {
  const types = new Map<string, string>();
  if (engine === 'postgres' || engine === 'duckdb') {
    // One table, not every table of that name: `information_schema.columns`
    // spans every schema, and a same-named table elsewhere (a copy, another
    // tenant's schema) must not decide whether this one still needs
    // converting. On PostgreSQL it is the table the conversion statements
    // themselves resolve the unqualified name to.
    const result =
      engine === 'postgres'
        ? await db.query(
            `SELECT column_name, data_type
                 FROM information_schema.columns
                WHERE table_name = ?
                  AND table_schema = (
                    SELECT n.nspname
                      FROM pg_catalog.pg_class c
                      JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
                     WHERE c.oid = to_regclass(?))`,
            table,
            quoteIdentifier(table),
          )
        : await db.query(
            `SELECT column_name, data_type
                 FROM information_schema.columns
                WHERE table_name = ?
                  AND table_schema = current_schema()
                  AND table_catalog = current_database()`,
            table,
          );
    for (const row of result.rows as {
      column_name?: string;
      data_type?: string;
    }[]) {
      if (row.column_name) types.set(row.column_name, row.data_type ?? '');
    }
    return types;
  }
  // SQLite. `PRAGMA table_xinfo` (not `table_info`, which omits generated
  // columns) does not accept a bound parameter, and the identifier has
  // already been validated by `quoteIdentifier`.
  const result = await db.query(
    `PRAGMA table_xinfo(${quoteIdentifier(table)})`,
  );
  for (const row of result.rows as { name?: string; type?: string }[]) {
    if (row.name) types.set(row.name, row.type ?? '');
  }
  return types;
}

/** Does this table expose an `id` column we can name in problem rows? */
function hasIdColumn(types: Map<string, string>): boolean {
  return types.has('id');
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Inspect every non-null value in one floating-point money column.
 *
 * Rows are read rather than aggregated in SQL because the integrality test has
 * to survive three dialects' differing `round`/modulo semantics, and a money
 * table small enough to be worth converting by hand is small enough to scan.
 */
async function inspectColumn(
  db: DatabaseInterface,
  table: string,
  column: string,
  scale: number,
  maxProblemRows: number,
  withId: boolean,
): Promise<{
  inspectedRows: number;
  nonIntegral: MinorUnitsProblemRow[];
  overflow: MinorUnitsProblemRow[];
}> {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  const selection = withId
    ? `"id", ${quotedColumn} AS value`
    : `${quotedColumn} AS value`;
  const result = await db.query(
    `SELECT ${selection} FROM ${quotedTable} WHERE ${quotedColumn} IS NOT NULL`,
  );

  const nonIntegral: MinorUnitsProblemRow[] = [];
  const overflow: MinorUnitsProblemRow[] = [];
  let inspectedRows = 0;

  for (const row of result.rows as { id?: unknown; value?: unknown }[]) {
    const value = toFiniteNumber(row.value);
    if (value === null) continue;
    inspectedRows += 1;
    const scaled = value * scale;
    const rounded = roundHalfAwayFromZero(scaled);
    const id = row.id == null ? null : String(row.id);
    if (Math.abs(scaled - rounded) > INTEGRALITY_TOLERANCE) {
      if (nonIntegral.length < maxProblemRows) {
        nonIntegral.push({ id, value, scaled });
      }
    }
    if (rounded > MAX_SAFE_INTEGER || rounded < MIN_SAFE_INTEGER) {
      if (overflow.length < maxProblemRows) {
        overflow.push({ id, value, scaled });
      }
    }
  }

  return { inspectedRows, nonIntegral, overflow };
}

function renderSummary(result: Omit<MinorUnitsPreflightResult, 'summary'>) {
  const lines: string[] = [
    `Money minor-units preflight (engine=${result.engine}, scale=${result.scale})`,
    `  columns: ${result.pendingColumns} pending, ${result.convertedColumns} already integer, ${result.missingColumns} missing`,
    `  rows that would be rounded: ${result.nonIntegralRows}`,
    `  rows that would exceed JavaScript's safe integer range: ${result.overflowRows}`,
  ];
  for (const column of result.columns) {
    const label = `${column.table}.${column.column}`;
    if (column.state === 'missing') {
      lines.push(`  - ${label}: missing`);
      continue;
    }
    if (column.state === 'converted') {
      lines.push(
        `  - ${label}: already integer (${column.declaredType ?? 'unknown'})`,
      );
      continue;
    }
    lines.push(
      `  - ${label}: pending (${column.declaredType ?? 'unknown'}), ` +
        `${column.inspectedRows} row(s) inspected, ` +
        `${column.nonIntegral.length} non-integral, ${column.overflow.length} overflow`,
    );
    for (const row of column.nonIntegral) {
      lines.push(
        `      non-integral id=${row.id ?? '<no id>'} value=${row.value} scaled=${row.scaled}`,
      );
    }
    for (const row of column.overflow) {
      lines.push(
        `      overflow id=${row.id ?? '<no id>'} value=${row.value} scaled=${row.scaled}`,
      );
    }
  }
  return lines.join('\n');
}

/**
 * The statements that convert one column, for one engine.
 *
 * Exported so the emitted DDL can be asserted without a live PostgreSQL or
 * DuckDB connection; each owning package's `test:postgres` lane then proves the
 * same SQL runs against a real server.
 *
 * @param engine - `postgres`, `duckdb`, or anything SQLite-shaped.
 * @param table - Physical table name.
 * @param column - Physical column name.
 * @param scale - Minor units per major unit.
 * @returns Statements in execution order.
 */
export function buildMinorUnitsStatements(
  engine: string,
  table: string,
  column: string,
  scale: number,
): string[] {
  const quotedTable = quoteIdentifier(table);
  const quotedColumn = quoteIdentifier(column);
  if (engine === 'postgres' || engine === 'duckdb') {
    // PostgreSQL's `round(double precision)` is banker's rounding — it breaks
    // ties to even, so `round(-0.5)` is `-0` and `round(2.5)` is `2`. Casting
    // to `numeric` first selects the half-away-from-zero overload, which is
    // what SQLite and DuckDB do and what the preflight predicts. Money can be
    // negative here (a billing credit), so the tie-break is not academic.
    const scaled =
      engine === 'postgres'
        ? `round((${quotedColumn})::numeric * ${scale})`
        : `round(${quotedColumn} * ${scale})`;
    // A `0.0` DEFAULT is not assignable to an integer column on PostgreSQL, so
    // it is dropped before the type change and restored after it. `0` is the
    // framework default for every money field.
    return [
      `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedColumn} DROP DEFAULT`,
      `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedColumn} TYPE BIGINT ` +
        `USING ${scaled}`,
      `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedColumn} SET DEFAULT 0`,
    ];
  }
  // SQLite: the declared type is only an affinity and cannot be altered in
  // place, so rescale the values and leave the declaration to the table-rebuild
  // path (#2370).
  return [
    `UPDATE ${quotedTable} SET ${quotedColumn} = CAST(round(${quotedColumn} * ${scale}) AS INTEGER) ` +
      `WHERE ${quotedColumn} IS NOT NULL`,
  ];
}

/**
 * Report what {@link rescaleMoneyColumnsToMinorUnits} would do, without
 * writing anything.
 *
 * @param db - Root database handle.
 * @param targets - Tables and money columns owned by the calling package.
 * @param options - Scale, engine hint, problem-row cap.
 * @returns Per-column state plus the rows that would lose information.
 */
export async function preflightMinorUnitsRescale(
  db: DatabaseInterface,
  targets: MoneyColumnTarget[],
  options: MinorUnitsOptions = {},
): Promise<MinorUnitsPreflightResult> {
  const scale = options.scale ?? DEFAULT_SCALE;
  if (!Number.isInteger(scale) || scale <= 0) {
    throw new Error(
      `Money minor-units rescale: scale must be a positive integer (got ${scale}).`,
    );
  }
  await refuseJsonBackedHandle(db, options.engineHint);
  const engine = resolveEngine(db, options.engineHint);
  const maxProblemRows = options.maxProblemRows ?? 20;

  // Validate every identifier up front. A malformed name is a bug in the
  // caller's migration module and must fail here, before any catalog read.
  for (const target of targets) {
    quoteIdentifier(target.table);
    for (const column of target.columns) quoteIdentifier(column);
  }
  // The preflight decides what may be rounded from the rows it reads; under
  // row-level security for this role it would not see them all (#5452).
  if (engine === 'postgres')
    await assertTablesReadable(
      db,
      targets.map((target) => target.table),
      'postgres',
    );

  const columns: MinorUnitsColumnReport[] = [];
  for (const target of targets) {
    const types = await readColumnTypes(db, engine, target.table);
    const withId = hasIdColumn(types);
    for (const column of target.columns) {
      const declaredType = types.get(column) ?? null;
      if (declaredType === null) {
        columns.push({
          table: target.table,
          column,
          state: 'missing',
          declaredType: null,
          inspectedRows: 0,
          nonIntegral: [],
          overflow: [],
        });
        continue;
      }
      if (isIntegerType(declaredType) || !isFloatingType(declaredType)) {
        // Anything that is not floating-point is either already converted or a
        // type this migration has no business rewriting.
        columns.push({
          table: target.table,
          column,
          state: 'converted',
          declaredType,
          inspectedRows: 0,
          nonIntegral: [],
          overflow: [],
        });
        continue;
      }
      const inspected = await inspectColumn(
        db,
        target.table,
        column,
        scale,
        maxProblemRows,
        withId,
      );
      columns.push({
        table: target.table,
        column,
        state: 'pending',
        declaredType,
        ...inspected,
      });
    }
  }

  const base = {
    engine,
    scale,
    columns,
    pendingColumns: columns.filter((c) => c.state === 'pending').length,
    convertedColumns: columns.filter((c) => c.state === 'converted').length,
    missingColumns: columns.filter((c) => c.state === 'missing').length,
    nonIntegralRows: columns.reduce((sum, c) => sum + c.nonIntegral.length, 0),
    overflowRows: columns.reduce((sum, c) => sum + c.overflow.length, 0),
  };
  const ok = base.nonIntegralRows === 0 && base.overflowRows === 0;
  return { ...base, ok, summary: renderSummary({ ...base, ok }) };
}

/**
 * Convert floating-point major-unit money columns to integer minor units.
 *
 * **One unit, at most once.** Deciding what still needs converting, every
 * conversion statement and the {@link BackfillTracker} marker run in one
 * transaction on every engine (PostgreSQL, SQLite and DuckDB all roll DDL
 * back). A failure anywhere, or a killed process, leaves every column and the
 * marker as they were, so the next call starts from the beginning. This
 * matters most on SQLite, where a rescaled column still declares a
 * floating-point type and only the marker says it was converted.
 *
 * **One runner at a time.** Inside its transaction it claims the marker,
 * looks for it again, and on PostgreSQL locks each table before reading its
 * column types, so what it converts is what it just read. A runner that
 * waited finds the marker and returns `ran: false`.
 *
 * @param db - Root database handle. A transaction handle is accepted: the
 *   caller's transaction is then the unit, and a failure leaves none of the
 *   conversion in it.
 * @param targets - Tables and money columns owned by the calling package.
 * @param options - Marker name, scale, and whether to convert despite
 *   information-losing rows.
 * @throws {MinorUnitsPreflightError} when the preflight found rows that would
 *   be rounded or overflow and `force` was not set.
 */
export async function rescaleMoneyColumnsToMinorUnits(
  db: DatabaseInterface,
  targets: MoneyColumnTarget[],
  options: MinorUnitsRescaleOptions,
): Promise<MinorUnitsRescaleResult> {
  await refuseJsonBackedHandle(db, options.engineHint);
  const scale = options.scale ?? DEFAULT_SCALE;
  const engine = resolveEngine(db, options.engineHint);
  const tracker = new BackfillTracker({ db });
  const alreadyApplied = async (): Promise<MinorUnitsRescaleResult> => ({
    ran: false,
    engine,
    scale,
    preflight: await preflightMinorUnitsRescale(db, targets, options),
    rescaledColumns: [],
    statements: [],
    declaredTypeChangePending: [],
  });

  if (await tracker.isApplied(options.backfillName)) return alreadyApplied();

  const outcome = await runBackfillOnceInTransaction(
    db,
    options.backfillName,
    (unit) => rescaleInTransaction(unit, engine, scale, targets, options),
    {
      description:
        `Money columns rescaled from major units to integer minor units ` +
        `(scale ${scale}).`,
      packageName: options.packageName,
      engine,
    },
  );
  return outcome.ran ? outcome.result : alreadyApplied();
}

/**
 * The conversion, on the handle of the transaction that also records the
 * marker. Every read and write goes through `unit`.
 */
async function rescaleInTransaction(
  unit: DatabaseInterface,
  engine: string,
  scale: number,
  targets: MoneyColumnTarget[],
  options: MinorUnitsRescaleOptions,
): Promise<MinorUnitsRescaleResult> {
  if (engine === 'postgres') {
    // `ALTER ... TYPE BIGINT USING round(col * scale)` scales whatever the
    // column holds when it runs, a float or an integer another session just
    // converted. Lock each table before reading its types, so nothing can
    // change a column between the read that calls it floating-point and the
    // statement that scales it.
    for (const target of targets) {
      const table = quoteIdentifier(target.table);
      const exists = await unit.query(
        'SELECT to_regclass(?) IS NOT NULL AS present',
        table,
      );
      if (exists.rows[0]?.present === true)
        await unit.query(`LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE`);
    }
  }

  const preflight = await preflightMinorUnitsRescale(unit, targets, options);
  if (!preflight.ok && !options.force) {
    throw new MinorUnitsPreflightError(preflight);
  }

  const statements: string[] = [];
  const rescaledColumns: Array<{ table: string; column: string }> = [];
  const declaredTypeChangePending: Array<{ table: string; column: string }> =
    [];

  const altersColumnType = engine === 'postgres' || engine === 'duckdb';
  for (const report of preflight.columns) {
    if (report.state !== 'pending') continue;
    for (const sql of buildMinorUnitsStatements(
      engine,
      report.table,
      report.column,
      scale,
    )) {
      await unit.query(sql);
      statements.push(sql);
    }
    if (!altersColumnType) {
      declaredTypeChangePending.push({
        table: report.table,
        column: report.column,
      });
      // The values are minor units now but the column still declares a
      // floating-point type. This per-column marker, written in the same
      // transaction, is what lets migrate change the declared type to
      // integer instead of stopping on it (#5454). It records the column's
      // state, so it covers exactly what this transaction wrote.
      const state = await minorUnitsColumnState(
        unit,
        report.table,
        report.column,
      );
      if (state !== null)
        await new BackfillTracker({ db: unit }).recordApplied(
          minorUnitsColumnMarker(report.table, report.column, state),
          {
            description: `${report.table}.${report.column} holds integer minor units (scale ${scale}); its declared type is still floating-point.`,
            packageName: options.packageName,
          },
        );
    }
    rescaledColumns.push({ table: report.table, column: report.column });
  }

  return {
    ran: true,
    engine,
    scale,
    preflight,
    rescaledColumns,
    statements,
    declaredTypeChangePending,
  };
}
