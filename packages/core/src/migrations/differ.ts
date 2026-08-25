/**
 * Schema Differ
 *
 * Compares manifest schemas to database schemas and generates
 * a SchemaDiff with the differences.
 */

import { createLogger } from '@happyvertical/logger';
import { detectEngine, getDDLStrategy } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import {
  foreignKeyConstraintName,
  foreignKeyRelationshipKey,
  renderForeignKeyConstraint,
  renderForeignKeyOrphanDetector,
  renderForeignKeyOrphanRepair,
  schemaForeignKeys,
  schemaForeignKeysForEngine,
} from '../schema/foreign-key-ddl.js';
import {
  normalizeForeignKeyAction,
  requireForeignKeyAction,
} from '../schema/foreign-key-policy.js';
import type {
  ColumnAlteration,
  ColumnDefinition,
  IndexDefinition,
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
  SQLDataType,
} from '../schema/types.js';
import {
  isJsonPathIndex,
  isStiSubtypeUniqueIndex,
  renderIndexTarget,
} from '../schema/utils.js';
import {
  planSqliteTableRebuilds,
  sqliteRebuildPlaceholderSql,
} from './sqlite-rebuild.js';
import type { DatabaseInterface, SqlTableSchemaInfo } from './types.js';

const logger = createLogger({ level: 'info' });

/**
 * Valid SQLDataType values for validation
 */
const VALID_SQL_DATA_TYPES: Set<SQLDataType> = new Set([
  'TEXT',
  'INTEGER',
  'REAL',
  'BLOB',
  'BOOLEAN',
  'JSON',
  'TIMESTAMP',
  'UUID',
]);

interface GeneratedTypeUpgradeSQL {
  sql: string;
  statements?: string[];
}

/**
 * Check if a string is a valid SQLDataType
 */
function isValidSQLDataType(type: string): type is SQLDataType {
  return VALID_SQL_DATA_TYPES.has(type as SQLDataType);
}

/**
 * Options for schema comparison
 */
export interface DiffOptions {
  /**
   * Emit executable `DROP TABLE` entries (`dropped_tables`) for tables that
   * exist in the database but not in the manifest. Default: false. Orphan
   * tables are always *reported* via `SchemaDiff.orphan_tables` regardless.
   */
  includeDroppedTables?: boolean;
  /**
   * Emit executable `drop_column` changes for columns that exist in the
   * database but not in the manifest. Default: false. Orphan columns are
   * always *reported* as `orphan_column` advisories regardless — a NOT NULL
   * orphan without a default is flagged as a warning because every ORM
   * insert (which never supplies the column) will fail on it (#2369).
   */
  includeDroppedColumns?: boolean;
  /**
   * Execute constraint relaxations instead of only reporting them:
   * `DROP NOT NULL` / `DROP DEFAULT` on live columns that are stricter than
   * the manifest, and `DROP NOT NULL` on orphan NOT NULL columns. Default:
   * false — relaxations are reported as advisories with the suggested SQL.
   * Strengthening repairs (`SET NOT NULL`, `SET DEFAULT`) are always emitted
   * where the engine supports `ALTER COLUMN` (#2369).
   */
  relaxColumns?: boolean;
  /**
   * Drop indexes that exist in the database but are absent from the manifest
   * AND are not functionally equivalent to anything in the manifest. Default:
   * false. The differ always skips primary-key indexes (`*_pkey`) and the
   * implicit indexes that PostgreSQL creates from inline UNIQUE constraints
   * (`*_key`) — those are owned by table-level constraints, not by the
   * index list, and dropping them here would break the constraint.
   *
   * Independent of this flag, a redundant single-column index over the
   * table's primary key that the manifest no longer declares (the legacy
   * `<table>_id_idx`, #2359) is always dropped: the primary-key constraint
   * keeps serving every lookup, so the drop can only save write cost.
   */
  includeDroppedIndexes?: boolean;
  /** Ignore type mismatches (just log warnings) */
  ignoreTypeMismatches?: boolean;
  /**
   * Explicit engine hint forwarded to `detectEngine` when picking the DDL
   * strategy used for *existing-table* SQL (ALTER/CREATE INDEX/etc.). Use
   * this when `db.url` is empty or ambiguous (e.g. JSON adapter, in-memory
   * wrappers where the URL lives on `db.config?.url`). Without it the
   * comparer falls back to URL-only detection, which can produce SQLite-
   * flavored SQL on a connection whose caller meant Postgres or DuckDB.
   */
  engineHint?: string;
  /**
   * Explicit confirmation that every historical writer of legacy PostgreSQL
   * Date columns used UTC wall times. Without this acknowledgement,
   * TIMESTAMP/TEXT/JSON to TIMESTAMPTZ drift is reported as manual rather
   * than reinterpreted automatically.
   */
  postgresTimestampMigration?: { legacyTimezone: 'UTC' };
}

/**
 * Suffix patterns for indexes that the differ refuses to drop.
 * - `_pkey`: PostgreSQL primary key implicit index.
 * - `_key`: PostgreSQL implicit index for inline `UNIQUE (...)` table
 *   constraints, and the unique index the differ itself creates for a
 *   `unique: true` column added via ADD COLUMN on engines that reject an
 *   inline UNIQUE there (SQLite/DuckDB — see {@link uniqueColumnIndexName}).
 *   Dropping these by name does not drop the underlying constraint on
 *   PostgreSQL, and dropping the constraint requires a separate DDL path
 *   (`ALTER TABLE ... DROP CONSTRAINT`) the differ does not emit today.
 *   Unclaimed `_key` unique indexes are instead *reported* as
 *   `orphan_index` advisories (#2369).
 */
const PROTECTED_INDEX_SUFFIXES = ['_pkey', '_key'];

function isProtectedDbIndexName(name: string): boolean {
  return PROTECTED_INDEX_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

/**
 * Name of the unique index that backs a `unique: true` column. Mirrors the
 * `<table>_<column>_key` name PostgreSQL gives the implicit index of an
 * inline column UNIQUE constraint, so the same column ends up with the same
 * index name on every engine and the orphan-index sweep treats it as
 * constraint-owned.
 */
export function uniqueColumnIndexName(
  tableName: string,
  columnName: string,
): string {
  return `${tableName}_${columnName}_key`;
}

/**
 * True when a change is report-only: it carries an advisory and no
 * executable statement. Such changes never reach the migration stream.
 */
export function isAdvisoryOnlyChange(change: SchemaChange): boolean {
  if (!change.advisory) return false;
  const statements = change.sqlStatements ?? (change.sql ? [change.sql] : []);
  return statements.length === 0;
}

/**
 * True for an info-level report-only change: listed in `SchemaDiff.changes`
 * for visibility but not counted by `has_changes` (a harmless orphan column,
 * a live default the manifest no longer declares).
 */
export function isInfoOnlyChange(change: SchemaChange): boolean {
  return isAdvisoryOnlyChange(change) && change.advisory?.severity === 'info';
}

/**
 * True when a change has no executable DDL: `type_mismatch`, an advisory-only
 * change, or a change whose only SQL is an advisory comment (e.g. a SQLite
 * `ALTER COLUMN` the engine cannot perform in place).
 */
export function isManualOrAdvisoryChange(change: SchemaChange): boolean {
  if (change.type === 'type_mismatch') return true;
  if (isAdvisoryOnlyChange(change)) return true;
  const statements = change.sqlStatements ?? (change.sql ? [change.sql] : []);
  return (
    statements.length > 0 &&
    statements.every((statement) => statement.trim().startsWith('--'))
  );
}

function resolveDatabaseUrl(db: DatabaseInterface): string {
  const dbWithConfig = db as DatabaseInterface & {
    config?: { url?: string };
  };
  return db.url || dbWithConfig.config?.url || '';
}

/**
 * Normalize a partial-index `WHERE` predicate so semantically-identical
 * clauses from different sources compare equal (issue #1692).
 *
 * The manifest stores predicates roughly as written (`_meta_type = 'Article'`),
 * SQLite/DuckDB echo the original CREATE INDEX text verbatim, and PostgreSQL
 * re-renders them with type casts and extra parentheses
 * (`((_meta_type)::text = 'Article'::text)`). Normalization:
 *
 * - strips a leading `WHERE` keyword,
 * - removes PostgreSQL `::type` casts (single-word type names — the only kind
 *   SMRT-generated partial predicates produce, e.g. `_meta_type::text`),
 * - removes parentheses (SMRT only emits simple `col = 'literal'` predicates,
 *   so grouping carries no meaning here),
 * - lowercases everything OUTSIDE single-quoted string literals (SQL keywords
 *   and identifiers are case-insensitive; literals such as STI discriminator
 *   class names are case-sensitive, so they are preserved verbatim),
 * - collapses whitespace and tightens spacing around comparison operators.
 *
 * Returns '' for an absent/empty predicate (i.e. a non-partial index).
 */
export function normalizeIndexPredicate(where?: string | null): string {
  if (!where) return '';
  const stripped = where.trim().replace(/^WHERE\s+/i, '');
  if (!stripped) return '';

  let out = '';
  let i = 0;
  while (i < stripped.length) {
    if (stripped[i] === "'") {
      // Consume a single-quoted string literal verbatim, honoring the SQL
      // `''` escape for an embedded quote.
      let literal = "'";
      i++;
      while (i < stripped.length) {
        if (stripped[i] === "'") {
          if (stripped[i + 1] === "'") {
            literal += "''";
            i += 2;
            continue;
          }
          literal += "'";
          i++;
          break;
        }
        literal += stripped[i];
        i++;
      }
      out += literal;
    } else {
      let run = '';
      while (i < stripped.length && stripped[i] !== "'") {
        run += stripped[i];
        i++;
      }
      out += normalizeNonLiteralPredicateRun(run);
    }
  }
  return out;
}

/**
 * Normalize the non-literal portion of a predicate (everything outside a
 * single-quoted string literal). Type casts and parentheses are dropped,
 * keywords/identifiers are lowercased, and whitespace is canonicalized.
 */
function normalizeNonLiteralPredicateRun(run: string): string {
  return run
    .replace(/::[A-Za-z_]\w*/g, '') // drop single-word PostgreSQL type casts
    .replace(/[()]/g, '') // drop parentheses
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/\s*([=<>!]+)\s*/g, '$1') // tighten comparison operators
    .trim();
}

/**
 * Extract the normalized partial-index predicate from a `CREATE INDEX`
 * statement — the `WHERE` tail that follows the column-list close paren.
 * Works for both SQLite/DuckDB `sqlite_master.sql` text and PostgreSQL
 * `pg_indexes.indexdef`. Returns '' for a non-partial index.
 */
export function extractIndexPredicate(createIndexSql: string): string {
  // The predicate is the tail after the column-list ')': `... (cols) WHERE x`.
  // Anchoring on `) WHERE` (rather than a bare `WHERE`) avoids matching a
  // column literally named "where" inside the indexed column list.
  const match = createIndexSql.match(/\)\s*WHERE\s+([\s\S]+?)\s*;?\s*$/i);
  if (!match) return '';
  return normalizeIndexPredicate(match[1]);
}

/**
 * Canonical form of a column default for drift comparison (#2369).
 *
 * The manifest side is the DDL fragment `formatDefaultValue()` would emit
 * (`'anon'`, `0`, `TRUE`, `'{}'`, `current_timestamp`); the database side is
 * whatever the catalog reports, which each engine renders differently:
 * PostgreSQL appends casts (`'anon'::text`, `'{}'::jsonb`, `'-1'::integer`)
 * and upper-cases `CURRENT_TIMESTAMP`, DuckDB wraps booleans
 * (`CAST('t' AS BOOLEAN)`), SQLite echoes the literal verbatim. Both sides
 * are reduced by the *manifest column type* to a `{kind, key}` pair:
 *
 * - `none`   — no default (`undefined`, empty, or the `NULL` keyword)
 * - `now`    — the current-timestamp family (`current_timestamp`, `now()`,
 *              `transaction_timestamp()`, `datetime('now')`)
 * - `number` — numeric columns, compared by numeric value
 * - `bool`   — boolean columns (`true`/`false`/`t`/`f`/`1`/`0`)
 * - `text`   — string literal contents (JSON columns compare the parsed
 *              value when both sides parse)
 * - `func`   — other function calls / keywords, compared lowercase and
 *              whitespace-collapsed
 * - `raw`    — could not be classified; callers must skip the comparison
 *              rather than risk a false positive
 */
export function canonicalizeDefault(
  fragment: string | undefined,
  columnType: SQLDataType,
): {
  kind: 'none' | 'now' | 'number' | 'bool' | 'text' | 'func' | 'raw';
  key: string;
} {
  if (fragment === undefined) return { kind: 'none', key: '' };
  let s = fragment.trim();
  if (s === '') return { kind: 'none', key: '' };

  // Unwrap DuckDB `CAST(<inner> AS <type>)` and PostgreSQL trailing casts /
  // outer parentheses. Loop because forms can nest (`('x'::text)::text`).
  for (let guard = 0; guard < 8; guard++) {
    const before = s;
    const castMatch = s.match(/^CAST\s*\((.*)\s+AS\s+[A-Za-z_][\w\s()]*\)$/is);
    if (castMatch) s = castMatch[1].trim();
    if (s.startsWith('(') && s.endsWith(')')) s = s.slice(1, -1).trim();
    // Trailing PostgreSQL cast: `::type`, `::character varying`, `::type[]`,
    // `::timestamp with time zone`, `::numeric(10,2)`.
    s = s
      .replace(/::[A-Za-z_][\w ]*(\(\s*\d+(\s*,\s*\d+)?\s*\))?(\[\])?\s*$/i, '')
      .trim();
    if (s === before) break;
  }

  if (/^null$/i.test(s)) return { kind: 'none', key: '' };

  const lower = s.toLowerCase().replace(/\s+/g, ' ');
  if (
    lower === 'current_timestamp' ||
    lower === 'current_timestamp()' ||
    lower === 'now()' ||
    lower === 'transaction_timestamp()' ||
    lower === "datetime('now')" ||
    lower === 'localtimestamp'
  ) {
    return { kind: 'now', key: 'now' };
  }

  const upperType = String(columnType).toUpperCase();
  const isNumericType =
    upperType === 'INTEGER' || upperType === 'REAL' || upperType === 'DECIMAL';
  const isBooleanType = upperType === 'BOOLEAN';
  const isJsonType = upperType === 'JSON';

  // String literal (single-quoted, '' escape).
  const literalMatch = s.match(/^'((?:[^']|'')*)'$/s);
  const literal =
    literalMatch !== null ? literalMatch[1].replace(/''/g, "'") : null;

  if (isBooleanType) {
    const token = (literal ?? s).trim().toLowerCase();
    if (['true', 't', '1', 'yes', 'on'].includes(token))
      return { kind: 'bool', key: 'true' };
    if (['false', 'f', '0', 'no', 'off'].includes(token))
      return { kind: 'bool', key: 'false' };
    return { kind: 'raw', key: lower };
  }

  if (isNumericType) {
    const token = (literal ?? s).trim();
    if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(token)) {
      return { kind: 'number', key: String(Number(token)) };
    }
    if (literal !== null) {
      return { kind: 'text', key: literal };
    }
    // Not a numeric literal — fall through to function/keyword detection
    // (e.g. `nextval('seq'::regclass)`).
  }

  if (literal !== null) {
    if (isJsonType) {
      try {
        return { kind: 'text', key: JSON.stringify(JSON.parse(literal)) };
      } catch {
        // Not JSON — compare as plain text below.
      }
    }
    return { kind: 'text', key: literal };
  }

  // Bare numeric literal on a non-numeric column (e.g. SQLite `DEFAULT 0` on
  // a TEXT column) — compare textually.
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s)) {
    return { kind: 'text', key: String(Number(s)) };
  }

  // Function call / keyword.
  if (/^[A-Za-z_][\w.]*\s*\(.*\)$/s.test(s) || /^[A-Za-z_]\w*$/.test(s)) {
    return { kind: 'func', key: lower };
  }

  return { kind: 'raw', key: lower };
}

/**
 * SchemaComparer class for comparing manifest schemas to database
 */
export class SchemaComparer {
  private db: DatabaseInterface;
  private options: DiffOptions;
  private engine: DatabaseEngine;
  private ddlStrategy: ReturnType<typeof getDDLStrategy>;

  constructor(db: DatabaseInterface, options: DiffOptions = {}) {
    this.db = db;
    this.options = {
      includeDroppedTables: false,
      includeDroppedColumns: false,
      includeDroppedIndexes: false,
      ignoreTypeMismatches: false,
      ...options,
    };
    // Use the shared detectEngine utility for consistent detection.
    // Handles :memory:, .json, and other edge cases. The JSON adapter is
    // detected structurally (it exposes `exportTable`) because its url can be
    // empty; otherwise fall back to URL-based detection, where `engineHint`
    // lets callers override when `db.url` is empty or points at an adapter
    // whose engine isn't obvious from the URL alone (some in-memory wrappers).
    this.engine =
      typeof (this.db as { exportTable?: unknown }).exportTable === 'function'
        ? 'json'
        : detectEngine(resolveDatabaseUrl(this.db), this.options.engineHint);
    this.ddlStrategy = getDDLStrategy(this.engine);
  }

  /**
   * Compare manifest schemas to database and return differences
   */
  async compare(
    manifestSchemas: Record<string, SchemaDefinition>,
  ): Promise<SchemaDiff> {
    const diff: SchemaDiff = {
      added_tables: [],
      dropped_tables: [],
      changes: [],
      has_changes: false,
    };

    // Get list of existing tables
    const existingTables = await this.getExistingTables();

    // Check each manifest schema against database
    for (const [tableName, schema] of Object.entries(manifestSchemas)) {
      if (!existingTables.has(tableName)) {
        // Table doesn't exist - add to added_tables
        diff.added_tables.push(schema);
        diff.has_changes = true;
      } else {
        // Table exists - compare columns and indexes
        const tableChanges = await this.compareTable(tableName, schema);
        if (tableChanges.length > 0) {
          diff.changes.push(...tableChanges);
          // Info-level report-only notes (a harmless orphan column, a stale
          // default the manifest no longer declares) are listed but do not
          // make the schema "changed": executable, manual, and warning-level
          // findings do (#2369).
          if (tableChanges.some((change) => !isInfoOnlyChange(change))) {
            diff.has_changes = true;
          }
        }
      }
    }

    // Orphan tables are always reported (never silently retained); the
    // executable DROP TABLE stays opt-in via `includeDroppedTables` (#2369).
    const orphanTables: string[] = [];
    for (const tableName of existingTables) {
      // Skip system tables
      if (tableName.startsWith('_smrt_') || tableName.startsWith('sqlite_')) {
        continue;
      }
      if (!manifestSchemas[tableName]) {
        orphanTables.push(tableName);
      }
    }
    orphanTables.sort();
    diff.orphan_tables = orphanTables;
    if (this.options.includeDroppedTables && orphanTables.length > 0) {
      diff.dropped_tables.push(...orphanTables);
      diff.has_changes = true;
    }

    return diff;
  }

  /**
   * Compare a single table's schema to manifest
   */
  async compareTable(
    tableName: string,
    manifest: SchemaDefinition,
  ): Promise<SchemaChange[]> {
    const changes: SchemaChange[] = [];

    // Get current table schema from database
    const dbSchema = await this.db.getTableSchema?.(tableName);
    if (!dbSchema) {
      // Table doesn't exist - this is an add_table case
      return changes;
    }

    // Compare columns
    const columnChanges = await this.compareColumns(
      tableName,
      manifest,
      dbSchema,
    );
    // #2370: SQLite cannot change a column's type in place. Turn the
    // "requires table recreation" placeholders those comparisons emit into an
    // executable table rebuild (see `./sqlite-rebuild.ts`); anything the
    // rebuild can't do safely stays manual drift, as before. The planner only
    // consumes `type_upgrade` placeholders — SQLite `alter_column`
    // nullability/default drift (#2369) stays manual until the rebuild also
    // rewrites constraints.
    changes.push(
      ...(this.engine === 'sqlite'
        ? await planSqliteTableRebuilds({
            db: this.db,
            tableName,
            changes: columnChanges,
            mapType: (type) => this.ddlStrategy.mapType(type),
          })
        : columnChanges),
    );

    // Partial-index predicates are not surfaced by `getTableSchema()` (the
    // @happyvertical/sql introspection returns only name/columns/unique), so
    // introspect them separately. Without this, two indexes on the same
    // column(s) that differ only by their WHERE clause — e.g. distinct STI
    // child partial indexes — would compare equal and the differ would miss
    // adds/drops/changes of the predicate (issue #1692).
    const dbIndexPredicates = await this.getDbIndexPredicates(tableName);

    // Compare indexes
    const indexChanges = this.compareIndexes(
      tableName,
      manifest,
      dbSchema,
      dbIndexPredicates,
    );
    changes.push(...indexChanges);
    changes.push(
      ...(await this.compareForeignKeys(tableName, manifest, dbSchema)),
    );

    return changes;
  }

  private async compareForeignKeys(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: SqlTableSchemaInfo,
  ): Promise<SchemaChange[]> {
    const changes: SchemaChange[] = [];
    const liveForeignKeys = dbSchema.foreignKeys || [];
    const declaredForeignKeys = schemaForeignKeys(manifest);
    const enabledForeignKeys = schemaForeignKeysForEngine(
      manifest,
      this.engine,
    );
    const enabledKeys = new Set(
      enabledForeignKeys.map(foreignKeyRelationshipKey),
    );
    const disabledForeignKeys = declaredForeignKeys.filter(
      (foreignKey) => !enabledKeys.has(foreignKeyRelationshipKey(foreignKey)),
    );

    for (const foreignKey of disabledForeignKeys) {
      const live = liveForeignKeys.find(
        (candidate) =>
          foreignKeyRelationshipKey(candidate) ===
          foreignKeyRelationshipKey(foreignKey),
      );
      if (!live) continue;

      const constraintName = foreignKeyConstraintName(tableName, foreignKey);
      if (this.engine === 'postgres') {
        changes.push({
          type: 'drop_foreign_key',
          table: tableName,
          name: constraintName,
          foreignKey,
          advisory: {
            severity: 'warning',
            message:
              `Cannot safely remove the now-disabled physical foreign key ${tableName}.${foreignKey.column}: ` +
              '@happyvertical/sql schema introspection does not expose the live PostgreSQL constraint name. Drop the live constraint deliberately, then rerun the migration.',
          },
        });
      } else {
        changes.push({
          type: 'drop_foreign_key',
          table: tableName,
          name: constraintName,
          foreignKey,
          advisory: {
            severity: 'warning',
            message:
              `${this.engine === 'sqlite' ? 'SQLite' : 'DuckDB'} requires a table rebuild to remove the now-disabled physical foreign key ` +
              `${tableName}.${foreignKey.column}. Rebuild the table from the current manifest; relationship metadata and application-side enforcement remain active.`,
          },
        });
      }
    }

    for (const foreignKey of enabledForeignKeys) {
      const expectedDelete =
        foreignKey.onDelete === undefined
          ? 'NO ACTION'
          : requireForeignKeyAction(
              foreignKey.onDelete,
              `${tableName}.${foreignKey.column} ON DELETE`,
            );
      const expectedUpdate =
        foreignKey.onUpdate === undefined
          ? 'NO ACTION'
          : requireForeignKeyAction(
              foreignKey.onUpdate,
              `${tableName}.${foreignKey.column} ON UPDATE`,
            );
      const exact = liveForeignKeys.some(
        (live) =>
          live.column === foreignKey.column &&
          live.referencesTable === foreignKey.referencesTable &&
          live.referencesColumn === foreignKey.referencesColumn &&
          (normalizeForeignKeyAction(live.onDelete) || 'NO ACTION') ===
            expectedDelete &&
          (normalizeForeignKeyAction(live.onUpdate) || 'NO ACTION') ===
            expectedUpdate,
      );
      if (exact) continue;

      const detectorSql = renderForeignKeyOrphanDetector(tableName, foreignKey);
      const repairSql = renderForeignKeyOrphanRepair(tableName, foreignKey);
      const sameColumn = liveForeignKeys.some(
        (live) => live.column === foreignKey.column,
      );
      if (sameColumn) {
        changes.push({
          type: 'add_foreign_key',
          table: tableName,
          name: foreignKeyConstraintName(tableName, foreignKey),
          foreignKey,
          advisory: {
            severity: 'warning',
            message:
              `Foreign key ${tableName}.${foreignKey.column} exists with a different target or action. ` +
              'Drop the old constraint deliberately, repair any orphan rows, then rerun the migration.',
            suggestedSql: [detectorSql, repairSql],
          },
        });
        continue;
      }

      if (this.engine !== 'postgres') {
        const engineReason =
          this.engine === 'sqlite'
            ? 'SQLite requires a table rebuild to add a foreign key to an existing table.'
            : 'DuckDB does not support ALTER TABLE ADD CONSTRAINT.';
        changes.push({
          type: 'add_foreign_key',
          table: tableName,
          name: foreignKeyConstraintName(tableName, foreignKey),
          foreignKey,
          advisory: {
            severity: 'warning',
            message: `${engineReason} Run the orphan detector, repair rows, and rebuild the table with the generated constraint.`,
            suggestedSql: [detectorSql, repairSql],
          },
        });
        continue;
      }

      // A missing child column is added earlier in this same table diff, so
      // probing the pre-migration schema would fail and be misclassified as
      // an orphan. The subsequent NOT VALID + VALIDATE statements remain the
      // authoritative safety check once the prerequisite column exists.
      const childColumnExists = Boolean(dbSchema.columns[foreignKey.column]);
      if (
        childColumnExists &&
        (await this.foreignKeyHasOrphans(tableName, foreignKey))
      ) {
        changes.push({
          type: 'add_foreign_key',
          table: tableName,
          name: foreignKeyConstraintName(tableName, foreignKey),
          foreignKey,
          advisory: {
            severity: 'warning',
            message:
              `Cannot add foreign key ${tableName}.${foreignKey.column}: existing rows do not match ` +
              `${foreignKey.referencesTable}.${foreignKey.referencesColumn}. Repair them, then rerun.`,
            suggestedSql: [detectorSql, repairSql],
          },
        });
        continue;
      }

      const constraintName = foreignKeyConstraintName(tableName, foreignKey);
      changes.push({
        type: 'add_foreign_key',
        table: tableName,
        name: constraintName,
        foreignKey,
        sqlStatements: [
          `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD ${renderForeignKeyConstraint(tableName, foreignKey)} NOT VALID`,
          `ALTER TABLE ${this.quoteIdentifier(tableName)} VALIDATE CONSTRAINT ${this.quoteIdentifier(constraintName)}`,
        ],
      });
    }
    return changes;
  }

  private async foreignKeyHasOrphans(
    tableName: string,
    foreignKey: import('../schema/types.js').ForeignKeyDefinition,
  ): Promise<boolean> {
    try {
      const result = await this.db.query(
        renderForeignKeyOrphanDetector(tableName, foreignKey, {
          limitOne: true,
        }),
      );
      const rows = Array.isArray(result) ? result : result.rows || [];
      return rows.length > 0;
    } catch (error) {
      logger.debug(
        `[SchemaComparer] Foreign-key orphan probe unavailable for ${tableName}.${foreignKey.column}; refusing automatic constraint addition`,
        { error: error instanceof Error ? error.message : String(error) },
      );
      return true;
    }
  }

  /**
   * Compare columns between manifest and database.
   *
   * Three families of drift (#2369):
   *
   * 1. **Missing column** — emit `add_column` with an executable plan for the
   *    engine (see {@link generateAddColumnChanges}).
   * 2. **Existing column** — type drift (as before), then nullability and
   *    default drift (see {@link compareColumnConstraints}).
   * 3. **Orphan column** (in DB, not in manifest) — always reported. With
   *    `includeDroppedColumns` it becomes an executable `drop_column`; a
   *    NOT NULL orphan without a default is a `warning` advisory because ORM
   *    inserts never supply it and will fail (`23502`); with `relaxColumns`
   *    that orphan gets an executable `DROP NOT NULL` where the engine allows.
   */
  private async compareColumns(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: SqlTableSchemaInfo,
  ): Promise<SchemaChange[]> {
    const changes: SchemaChange[] = [];
    const dbColumnNames = new Set(Object.keys(dbSchema.columns));

    // Check for new and modified columns
    for (const [colName, colDef] of Object.entries(manifest.columns)) {
      if (!dbColumnNames.has(colName)) {
        // Column doesn't exist - add it
        changes.push(
          ...(await this.generateAddColumnChanges(tableName, colName, colDef)),
        );
      } else {
        // Column exists - check for type mismatch
        const dbCol = dbSchema.columns[colName];
        let typeDrifted = false;

        // Map manifest's abstract type to engine-specific type
        // e.g., JSON → TEXT for SQLite, JSON → JSONB for PostgreSQL
        // Validate the manifest type before mapping
        const manifestType = colDef.type;
        if (!isValidSQLDataType(manifestType)) {
          // Invalid manifest type - treat as TEXT (safest fallback)
          logger.warn(
            `[SchemaComparer] Invalid manifest type "${manifestType}" for ${tableName}.${colName}, treating as TEXT`,
          );
        }
        const validatedType: SQLDataType = isValidSQLDataType(manifestType)
          ? manifestType
          : 'TEXT';
        const expectedEngineType = this.ddlStrategy.mapType(validatedType);
        const normalizedExpected = this.normalizeType(expectedEngineType);
        const normalizedActual = this.normalizeType(dbCol.type);

        // R11: native `uuid` and `text` are interchangeable for SMRT-owned
        // identifiers/references, but not for arbitrary provenance text. Keep
        // the tolerance directional:
        //   - manifest UUID + DB text is tolerated for structural ID/ref
        //     columns so old deployments are not forced into native UUID.
        //   - manifest TEXT + DB uuid is tolerated only for structural ID/ref
        //     columns that are intentionally UUID-compatible.
        // Plain TEXT columns with DB uuid now surface as repairable drift.
        const isUuidTextEquivalent = this.isUuidTextEquivalentColumn(
          colName,
          colDef,
          normalizedExpected,
          normalizedActual,
        );

        // #1335: native `json`/`jsonb` (DB) and `text` (manifest) are
        // interchangeable for SMRT — the convention is to serialize JSON values
        // into TEXT columns, and a native-json column already holds exactly that
        // data. So the differ must NOT flag a json<->text difference in EITHER
        // direction:
        //   - manifest TEXT vs DB json   (native-json column, text-convention manifest)
        //   - manifest JSON vs DB text   (the canary case: an enum/plain field
        //     mis-inferred as JSON by a downstream scanner, sitting on a real
        //     `text` column holding bare values like 'active')
        // Generating an ALTER here is pure churn at best and data-destroying at
        // worst: `status::jsonb` on a column holding 'active' raises
        // "invalid input syntax for type json" and aborts the whole atomic
        // migration. Like the uuid/text tolerance, this lives at the equality
        // gate only (not in `normalizeType`) so `isCompatibleTypeUpgrade` still
        // treats JSON and TEXT as distinct buckets for OTHER upgrade paths.
        const isJsonTextEquivalent =
          (normalizedExpected === 'JSON' && normalizedActual === 'TEXT') ||
          (normalizedExpected === 'TEXT' && normalizedActual === 'JSON');

        if (
          normalizedExpected !== normalizedActual &&
          !isUuidTextEquivalent &&
          !isJsonTextEquivalent
        ) {
          typeDrifted = true;
          // Check if this is a safe type upgrade that SMRT can handle
          // Since SMRT owns the data lifecycle, we know the intent from the manifest
          if (this.isCompatibleTypeUpgrade(colDef.type, dbCol.type)) {
            // Generate type upgrade SQL
            const generatedSQL = this.generateTypeUpgradeSQL(
              tableName,
              colName,
              colDef,
              dbCol.type,
            );
            changes.push({
              type: 'type_upgrade',
              table: tableName,
              name: colName,
              column: colDef,
              mismatch: {
                expected: colDef.type,
                actual: dbCol.type,
              },
              sql: generatedSQL.sql,
              ...(generatedSQL.statements
                ? { sqlStatements: generatedSQL.statements }
                : {}),
            });
          } else if (!this.options.ignoreTypeMismatches) {
            changes.push({
              type: 'type_mismatch',
              table: tableName,
              name: colName,
              mismatch: {
                expected: colDef.type,
                actual: dbCol.type,
              },
            });
          }
        }

        // Nullability / default drift. Skipped while the type itself is
        // drifting: a type repair rewrites the default (PostgreSQL DROP/SET
        // DEFAULT around ALTER TYPE) and an incompatible mismatch needs a
        // manual migration anyway, so constraint drift on top would only be
        // noise until the type is settled.
        if (!typeDrifted) {
          changes.push(
            ...(await this.compareColumnConstraints(
              tableName,
              colName,
              colDef,
              validatedType,
              dbCol,
            )),
          );
        }
      }
    }

    // Orphan columns: always reported, dropped only on request (#2369).
    const manifestColumnNames = new Set(Object.keys(manifest.columns));
    for (const colName of dbColumnNames) {
      if (manifestColumnNames.has(colName)) continue;
      const dbCol = dbSchema.columns[colName];
      if (this.options.includeDroppedColumns) {
        changes.push({
          type: 'drop_column',
          table: tableName,
          name: colName,
          mismatch: {
            expected: '(not in manifest)',
            actual: this.describeDbColumn(dbCol),
          },
          sql: this.generateDropColumnSQL(tableName, colName),
        });
        continue;
      }
      changes.push(this.describeOrphanColumn(tableName, colName, dbCol));
    }

    return changes;
  }

  /**
   * Compare nullability and default between a manifest column and the live
   * column, emitting `alter_column` changes (#2369).
   *
   * Rules:
   * - Primary-key columns are owned by the PK constraint (SQLite reports a
   *   `TEXT PRIMARY KEY` as nullable while PostgreSQL/DuckDB imply NOT NULL),
   *   so they are skipped entirely.
   * - Strengthening (`SET NOT NULL`, `SET DEFAULT`) is emitted as executable
   *   SQL on engines with `ALTER COLUMN` (PostgreSQL/DuckDB). A `SET NOT NULL`
   *   is preceded by a backfill of the manifest default when there is one;
   *   without a default the live data is probed and, if NULLs exist, the
   *   change is reported as manual with the suggested backfill instead of
   *   emitting an ALTER the engine would reject mid-batch.
   * - Relaxing (`DROP NOT NULL`, `DROP DEFAULT`) is reported as an advisory
   *   unless `relaxColumns` is set, in which case it is executable.
   * - SQLite has no `ALTER COLUMN`; every alteration is reported as manual
   *   (advisory-comment SQL) until the table-rebuild path (#2370) lands.
   * - Defaults are compared through {@link canonicalizeDefault}; when either
   *   side cannot be canonicalized the comparison is skipped rather than
   *   risking a false positive that would churn every run.
   */
  private async compareColumnConstraints(
    tableName: string,
    colName: string,
    colDef: ColumnDefinition,
    validatedType: SQLDataType,
    dbCol: SqlTableSchemaInfo['columns'][string],
  ): Promise<SchemaChange[]> {
    if (colDef.primaryKey || dbCol.primaryKey) {
      return [];
    }

    const changes: SchemaChange[] = [];
    const manifestNotNull = colDef.notNull === true;
    const dbNotNull = dbCol.notNull === true;
    const manifestDefaultSql =
      colDef.defaultValue !== undefined
        ? this.ddlStrategy.formatDefaultValue(
            colDef.defaultValue,
            validatedType,
          )
        : undefined;
    const manifestDefaultCanon = canonicalizeDefault(
      manifestDefaultSql,
      validatedType,
    );
    const dbDefaultCanon = canonicalizeDefault(
      dbCol.defaultValue === null || dbCol.defaultValue === undefined
        ? undefined
        : String(dbCol.defaultValue),
      validatedType,
    );
    // A manifest `null` default renders as the SQL NULL keyword, i.e. "no
    // default" — same bucket as an absent default.
    const hasManifestDefault = manifestDefaultCanon.kind !== 'none';
    const defaultsComparable =
      manifestDefaultCanon.kind !== 'raw' && dbDefaultCanon.kind !== 'raw';
    const defaultDrifted =
      defaultsComparable &&
      `${manifestDefaultCanon.kind}:${manifestDefaultCanon.key}` !==
        `${dbDefaultCanon.kind}:${dbDefaultCanon.key}`;
    const dbHasDefault = dbDefaultCanon.kind !== 'none';

    // --- Default drift ---------------------------------------------------
    if (defaultDrifted) {
      if (hasManifestDefault && manifestDefaultSql !== undefined) {
        changes.push(
          this.buildAlterColumnChange({
            tableName,
            colName,
            colDef,
            alteration: 'set_default',
            expected: `DEFAULT ${manifestDefaultSql}`,
            actual: dbHasDefault
              ? `DEFAULT ${String(dbCol.defaultValue)}`
              : '(no default)',
            statements: this.supportsAlterColumn()
              ? [
                  this.generateSetDefaultSQL(
                    tableName,
                    colName,
                    manifestDefaultSql,
                    validatedType,
                  ),
                ]
              : null,
          }),
        );
      } else if (dbHasDefault) {
        // Live column carries a default the manifest no longer declares.
        changes.push(
          this.buildAlterColumnChange({
            tableName,
            colName,
            colDef,
            alteration: 'drop_default',
            expected: '(no default)',
            actual: `DEFAULT ${String(dbCol.defaultValue)}`,
            statements: this.supportsAlterColumn()
              ? [
                  `ALTER TABLE ${this.quoteIdentifier(tableName)} ALTER COLUMN ${this.quoteIdentifier(colName)} DROP DEFAULT`,
                ]
              : null,
            relaxation: {
              severity: 'info',
              message: `${tableName}.${colName} has a live default (${String(dbCol.defaultValue)}) the manifest no longer declares; inserts that omit the column keep receiving it. ${this.relaxHint('drop it')}`,
            },
          }),
        );
      }
    }

    // --- Nullability drift -----------------------------------------------
    if (manifestNotNull && !dbNotNull) {
      const quotedTable = this.quoteIdentifier(tableName);
      const quotedCol = this.quoteIdentifier(colName);
      const setNotNull = `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET NOT NULL`;
      if (!this.supportsAlterColumn()) {
        changes.push(
          this.buildAlterColumnChange({
            tableName,
            colName,
            colDef,
            alteration: 'set_not_null',
            expected: 'NOT NULL',
            actual: 'NULL',
            statements: null,
          }),
        );
      } else if (hasManifestDefault && manifestDefaultSql !== undefined) {
        // Backfill NULLs with the manifest default so the constraint can be
        // enforced on a populated table, then tighten.
        changes.push(
          this.buildAlterColumnChange({
            tableName,
            colName,
            colDef,
            alteration: 'set_not_null',
            expected: 'NOT NULL',
            actual: 'NULL',
            statements: [
              `UPDATE ${quotedTable} SET ${quotedCol} = ${manifestDefaultSql} WHERE ${quotedCol} IS NULL`,
              setNotNull,
            ],
          }),
        );
      } else if (await this.columnHasNulls(tableName, colName)) {
        // No default to backfill with and live NULLs exist: the engine would
        // reject SET NOT NULL and abort the whole atomic batch. Report it
        // with the exact remediation instead.
        changes.push({
          type: 'alter_column',
          table: tableName,
          name: colName,
          column: colDef,
          alteration: 'set_not_null',
          mismatch: { expected: 'NOT NULL', actual: 'NULL' },
          sql: `-- ${tableName}.${colName} is required by the manifest but live rows hold NULL and the column has no default to backfill; UPDATE those rows, then run: ${setNotNull}`,
          advisory: {
            severity: 'warning',
            message: `${tableName}.${colName} is required by the manifest but live rows hold NULL and there is no default to backfill. Backfill the NULLs, then rerun db:migrate (or declare a default on the field).`,
            suggestedSql: [
              `UPDATE ${quotedTable} SET ${quotedCol} = <value> WHERE ${quotedCol} IS NULL`,
              setNotNull,
            ],
          },
        });
      } else {
        changes.push(
          this.buildAlterColumnChange({
            tableName,
            colName,
            colDef,
            alteration: 'set_not_null',
            expected: 'NOT NULL',
            actual: 'NULL',
            statements: [setNotNull],
          }),
        );
      }
    } else if (!manifestNotNull && dbNotNull) {
      changes.push(
        this.buildAlterColumnChange({
          tableName,
          colName,
          colDef,
          alteration: 'drop_not_null',
          expected: 'NULL',
          actual: 'NOT NULL',
          statements: this.supportsAlterColumn()
            ? [
                `ALTER TABLE ${this.quoteIdentifier(tableName)} ALTER COLUMN ${this.quoteIdentifier(colName)} DROP NOT NULL`,
              ]
            : null,
          relaxation: {
            severity: 'warning',
            message: `${tableName}.${colName} is NOT NULL in the database but nullable in the manifest; writes that store NULL will fail. ${this.relaxHint('drop the constraint')}`,
          },
        }),
      );
    }

    return changes;
  }

  /**
   * Assemble an `alter_column` change.
   *
   * - `statements: null` means the engine cannot alter the column in place
   *   (SQLite): the change is reported as manual with advisory-comment SQL.
   * - `relaxation` marks a weakening change: without `relaxColumns` it is
   *   emitted as a report-only advisory (no SQL); with it, the statements are
   *   executable.
   */
  private buildAlterColumnChange(input: {
    tableName: string;
    colName: string;
    colDef: ColumnDefinition;
    alteration: ColumnAlteration;
    expected: string;
    actual: string;
    statements: string[] | null;
    relaxation?: { severity: 'warning' | 'info'; message: string };
  }): SchemaChange {
    const {
      tableName,
      colName,
      colDef,
      alteration,
      expected,
      actual,
      statements,
      relaxation,
    } = input;
    const base: SchemaChange = {
      type: 'alter_column',
      table: tableName,
      name: colName,
      column: colDef,
      alteration,
      mismatch: { expected, actual },
    };

    if (relaxation && !this.options.relaxColumns) {
      return {
        ...base,
        advisory: {
          severity: relaxation.severity,
          message: relaxation.message,
          suggestedSql: statements ?? [
            `-- SQLite cannot ALTER COLUMN; ${alteration === 'drop_not_null' ? 'dropping NOT NULL' : 'dropping the default'} requires a table rebuild (#2370)`,
          ],
        },
      };
    }

    if (statements === null) {
      const what =
        alteration === 'set_not_null'
          ? `enforcing NOT NULL on ${colName}`
          : alteration === 'drop_not_null'
            ? `dropping NOT NULL from ${colName}`
            : alteration === 'set_default'
              ? `setting the default on ${colName}`
              : `dropping the default from ${colName}`;
      return {
        ...base,
        sql: `-- SQLite: ${what} requires table recreation (expected ${expected}, found ${actual}; #2370)`,
      };
    }

    return {
      ...base,
      sql: statements[statements.length - 1],
      ...(statements.length > 1 ? { sqlStatements: statements } : {}),
    };
  }

  /**
   * Describe a DB column that has no manifest counterpart. Blocking when it
   * is NOT NULL without a default: ORM inserts never supply it, so every
   * insert fails with a not-null violation while `db:status` would otherwise
   * say the schema is in sync (#2369).
   */
  private describeOrphanColumn(
    tableName: string,
    colName: string,
    dbCol: SqlTableSchemaInfo['columns'][string],
  ): SchemaChange {
    const dbHasDefault =
      dbCol.defaultValue !== null && dbCol.defaultValue !== undefined;
    const blocking = dbCol.notNull === true && !dbHasDefault;
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedCol = this.quoteIdentifier(colName);
    const dropSql = `ALTER TABLE ${quotedTable} DROP COLUMN ${quotedCol}`;
    const relaxSql = `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} DROP NOT NULL`;
    const shape = this.describeDbColumn(dbCol);
    const base: SchemaChange = {
      type: 'orphan_column',
      table: tableName,
      name: colName,
      mismatch: { expected: '(not in manifest)', actual: shape },
    };

    if (!blocking) {
      return {
        ...base,
        advisory: {
          severity: 'info',
          message: `${tableName}.${colName} exists in the database but not in the manifest (${shape}). Harmless for inserts; pass includeDroppedColumns / --drop-columns to drop it.`,
          suggestedSql: [dropSql],
        },
      };
    }

    if (this.options.relaxColumns && this.supportsAlterColumn()) {
      // Opted-in, engine can relax in place: make it executable so inserts
      // keep working without destroying the column's data.
      return {
        type: 'alter_column',
        table: tableName,
        name: colName,
        alteration: 'drop_not_null',
        mismatch: { expected: '(not in manifest)', actual: shape },
        sql: relaxSql,
      };
    }

    const fix = this.supportsAlterColumn()
      ? `Pass relaxColumns / --relax-columns to drop the NOT NULL (keeps data), or includeDroppedColumns / --drop-columns to drop the column.`
      : `SQLite cannot drop NOT NULL in place; pass includeDroppedColumns / --drop-columns to drop the column (or rebuild the table, #2370).`;
    return {
      ...base,
      advisory: {
        severity: 'warning',
        message: `${tableName}.${colName} is NOT NULL without a default and is not in the manifest — every ORM insert into ${tableName} will fail (not-null violation). ${fix}`,
        suggestedSql: this.supportsAlterColumn()
          ? [relaxSql, dropSql]
          : [dropSql],
      },
    };
  }

  /**
   * Remediation hint for a relaxation advisory. On engines with `ALTER
   * COLUMN` the flag executes it; SQLite cannot relax in place, so the hint
   * says so instead of implying the flag will act (#2370).
   */
  private relaxHint(action: string): string {
    return this.supportsAlterColumn()
      ? `Pass relaxColumns / --relax-columns to ${action}.`
      : `SQLite cannot ${action} in place (no ALTER COLUMN); it requires a table rebuild (#2370) — relaxColumns / --relax-columns only reports it as manual here.`;
  }

  private describeDbColumn(
    dbCol: SqlTableSchemaInfo['columns'][string],
  ): string {
    const parts = [String(dbCol.type ?? '').toUpperCase() || 'UNKNOWN'];
    if (dbCol.notNull) parts.push('NOT NULL');
    if (dbCol.defaultValue !== null && dbCol.defaultValue !== undefined) {
      parts.push(`DEFAULT ${String(dbCol.defaultValue)}`);
    }
    return parts.join(' ');
  }

  /**
   * Whether the engine can alter nullability/defaults of an existing column
   * in place. SQLite cannot (`ALTER TABLE ... ALTER COLUMN` does not exist);
   * PostgreSQL, DuckDB and the DuckDB-backed JSON adapter can.
   */
  private supportsAlterColumn(): boolean {
    return this.engine !== 'sqlite';
  }

  private generateSetDefaultSQL(
    tableName: string,
    colName: string,
    formattedDefault: string,
    validatedType: SQLDataType,
  ): string {
    // Mirror the type-upgrade path: PostgreSQL JSON defaults are cast so the
    // stored default is the jsonb literal rather than an untyped string.
    const defaultSql =
      this.engine === 'postgres' && this.normalizeType(validatedType) === 'JSON'
        ? `${formattedDefault}::${this.ddlStrategy.mapType(validatedType).toLowerCase()}`
        : formattedDefault;
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ALTER COLUMN ${this.quoteIdentifier(colName)} SET DEFAULT ${defaultSql}`;
  }

  /**
   * Live-data probe: does the table hold any row? Used to decide whether an
   * added required column without a default can be enforced NOT NULL right
   * away. Errors (adapter without raw query, etc.) resolve to `true` so the
   * caller takes the conservative path.
   */
  private async tableHasRows(tableName: string): Promise<boolean> {
    try {
      const result = await this.db.query(
        `SELECT 1 AS present FROM ${this.quoteIdentifier(tableName)} LIMIT 1`,
      );
      return (result.rows?.length ?? 0) > 0;
    } catch (err) {
      logger.debug(
        `[SchemaComparer] Row probe unavailable for ${tableName}; assuming populated`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return true;
    }
  }

  /**
   * Live-data probe: does the column hold any NULL? Used before emitting a
   * `SET NOT NULL` that has no default to backfill with. Errors resolve to
   * `true` (conservative: report instead of emitting an ALTER that fails).
   */
  private async columnHasNulls(
    tableName: string,
    colName: string,
  ): Promise<boolean> {
    try {
      const result = await this.db.query(
        `SELECT 1 AS present FROM ${this.quoteIdentifier(tableName)} WHERE ${this.quoteIdentifier(colName)} IS NULL LIMIT 1`,
      );
      return (result.rows?.length ?? 0) > 0;
    } catch (err) {
      logger.debug(
        `[SchemaComparer] NULL probe unavailable for ${tableName}.${colName}; assuming NULLs exist`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return true;
    }
  }

  private isUuidTextEquivalentColumn(
    columnName: string,
    colDef: ColumnDefinition,
    normalizedExpected: string,
    normalizedActual: string,
  ): boolean {
    const expectedUuidActualText =
      normalizedExpected === 'UUID' && normalizedActual === 'TEXT';
    const expectedTextActualUuid =
      normalizedExpected === 'TEXT' && normalizedActual === 'UUID';

    if (!expectedUuidActualText && !expectedTextActualUuid) {
      return false;
    }

    return this.isStructuralUuidCompatibleColumn(columnName, colDef);
  }

  private isStructuralUuidCompatibleColumn(
    columnName: string,
    colDef: ColumnDefinition,
  ): boolean {
    return (
      colDef.primaryKey === true ||
      Boolean(colDef.foreignKey) ||
      colDef.referenceKind === 'id' ||
      colDef.referenceKind === 'foreignKey' ||
      colDef.referenceKind === 'crossPackageRef' ||
      colDef.referenceKind === 'tenantId' ||
      (columnName === 'id' && colDef.type === 'TEXT')
    );
  }

  /**
   * Compare indexes between manifest and database
   *
   * Four classes of drift the differ now detects:
   *
   * 1. **Missing index** — manifest has an index neither the DB has by name
   *    nor any equivalent-by-signature. Emit `add_index`. (Issue #741: the
   *    signature check protects against creating duplicates when STI child
   *    classes register indexes with different name prefixes.)
   *
   * 2. **Same-name shape drift** — DB has an index with the manifest's name,
   *    but its columns, uniqueness flag, or partial-index `WHERE` predicate
   *    differ. This covers the uniqueness flip in issue #1165
   *    (`tenants_slug_context_meta_type_idx` materialized non-unique while
   *    the manifest declares it unique) and the predicate drift in issue
   *    #1692 (a partial index whose `WHERE` clause was added, removed, or
   *    altered). Emit `drop_index` + `add_index` so the next migrate cycle
   *    recreates it with the correct shape.
   *
   * 3. **Orphan in DB** — DB has an index with no manifest counterpart by
   *    name and no signature equivalent. Emit `drop_index` *only* when the
   *    caller opts in via `includeDroppedIndexes`, and even then never for
   *    PostgreSQL implicit indexes (`*_pkey`, `*_key`) — those are owned by
   *    table-level constraints and need a separate `DROP CONSTRAINT` path
   *    that the differ does not emit yet. One exception is unconditional: a
   *    redundant single-column index over the live primary key (the legacy
   *    `<table>_id_idx`, #2359) is dropped even without the opt-in, because
   *    the primary-key constraint already serves it.
   *
   * 4. **Partial-index predicate drift / collision** — two indexes on the
   *    same column(s) and uniqueness that differ only by their `WHERE`
   *    predicate (e.g. distinct STI child partial indexes) are no longer
   *    collapsed to one signature, so the signature-equivalence path (b)
   *    won't claim one for the other.
   *
   * @param dbIndexPredicates - Normalized `WHERE` predicate per DB index
   *   name from {@link getDbIndexPredicates}. `null` means predicate
   *   introspection was unavailable for this engine/adapter, in which case
   *   the comparison falls back to predicate-unaware signatures (the prior
   *   behavior) so existing partial indexes are never flagged as false drift.
   */
  private compareIndexes(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: SqlTableSchemaInfo,
    dbIndexPredicates: Map<string, string> | null = null,
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];

    // Only fold predicates into signatures when we actually read them back
    // from the live DB. If introspection was unavailable both sides use the
    // empty predicate, which reproduces the prior column+unique-only behavior
    // and cannot manufacture false positives on existing partial indexes.
    const predicateAware = dbIndexPredicates !== null;
    const dbPredicateFor = (name: string): string =>
      predicateAware ? (dbIndexPredicates?.get(name) ?? '') : '';
    const manifestPredicateFor = (idx: IndexDefinition): string =>
      predicateAware ? normalizeIndexPredicate(idx.where) : '';

    // An STI subtype-scoped UNIQUE index (`unique: true` declared only on a
    // descendant, #2359) has no faithful shape on an engine without partial
    // indexes: degrading it to a full unique index would enforce one
    // subtype's constraint across every sibling's rows, so it is skipped
    // there — same as the DuckDB DDL strategy — rather than compared or
    // created. Other partial indexes keep degrading to full ones as before.
    const manifestIndexes = this.supportsPartialIndexes()
      ? manifest.indexes
      : manifest.indexes.filter((idx) => !isStiSubtypeUniqueIndex(idx));

    // The live table's primary-key columns, for the redundant-PK-index
    // sweep below.
    const primaryKeyColumns = Object.entries(dbSchema.columns)
      .filter(([, column]) => column.primaryKey === true)
      .map(([name]) => name);

    // Index DB indexes by name and by signature for fast lookup.
    // dbIndexSignatures groups *all* DB index names sharing a signature so
    // duplicates under different names all get claimed by a single matching
    // manifest entry — otherwise the orphan sweep would drop the un-claimed
    // siblings even though they are functionally equivalent to the manifest.
    const dbIndexesByName = new Map<
      string,
      { columns: string[]; unique: boolean }
    >();
    const dbIndexSignatures = new Map<string, Set<string>>();
    for (const idx of dbSchema.indexes) {
      const unique = idx.unique ?? false;
      dbIndexesByName.set(idx.name, { columns: idx.columns, unique });
      const signature = this.getIndexSignature(
        idx.columns,
        unique,
        dbPredicateFor(idx.name),
      );
      let bucket = dbIndexSignatures.get(signature);
      if (!bucket) {
        bucket = new Set();
        dbIndexSignatures.set(signature, bucket);
      }
      bucket.add(idx.name);
    }

    // Manifest signatures — used during the orphan sweep to skip DB indexes
    // that match a manifest entry's signature even if no specific manifest
    // entry "claimed" them by name.
    const manifestSignatureSet = new Set<string>();
    for (const idx of manifestIndexes) {
      manifestSignatureSet.add(
        this.getIndexSignature(idx, undefined, manifestPredicateFor(idx)),
      );
    }

    // Track which DB indexes a manifest entry has claimed, so the orphan
    // pass below doesn't re-flag indexes that match by signature alone.
    const claimedDbIndexes = new Set<string>();

    for (const idx of manifestIndexes) {
      const manifestSignature = this.getIndexSignature(
        idx,
        undefined,
        manifestPredicateFor(idx),
      );

      // (a) Same name in DB — verify shape matches.
      const dbByName = dbIndexesByName.get(idx.name);
      if (dbByName) {
        claimedDbIndexes.add(idx.name);

        // JSON-path indexes (`@meta({ indexed: true })`) cannot be reliably
        // compared by DB introspection — SQLite expression indexes surface
        // as `[null]` columns, so the signature would always mismatch and
        // every diff run would emit drop+recreate. Trust the name match
        // here; if the json path itself changes, the index name changes
        // too (we encode the field name into it), so a name match is a
        // stronger guarantee than the column list for this index family.
        if (isJsonPathIndex(idx)) {
          continue;
        }

        const dbSignature = this.getIndexSignature(
          dbByName.columns,
          dbByName.unique,
          dbPredicateFor(idx.name),
        );
        if (dbSignature === manifestSignature) {
          continue; // Same name, same shape — nothing to do.
        }

        // Same name, drifted shape. Most often this is a uniqueness flip
        // (issue #1165: 3-column index materialized non-unique). Recreate.
        //
        // Rollback caveat: the auto-generated DOWN script for the
        // `add_index` half drops the (newly correct) index, and the
        // `drop_index` half has no DOWN. Rolling back a recreate leaves
        // the table without the index entirely instead of restoring the
        // wrong-shape original. Capturing the original shape would
        // require richer DB introspection than the differ currently has,
        // so this asymmetry is accepted — the failure mode after an
        // un-rolled-back recreate is "missing index" rather than
        // "permanently broken UPSERT," which is recoverable.
        changes.push({
          type: 'drop_index',
          table: tableName,
          name: idx.name,
          sql: this.generateDropIndexSQL(idx.name),
        });
        changes.push({
          type: 'add_index',
          table: tableName,
          name: idx.name,
          index: idx,
          sql: this.generateAddIndexSQL(tableName, idx),
        });
        continue;
      }

      // (b) Different name in DB but functionally equivalent — keep as-is.
      // Claim *every* DB name sharing this signature so duplicate-shape
      // indexes (e.g., a stale `<name>_idx` plus the implicit `<name>_key`
      // from the same constraint) all survive the orphan sweep.
      const equivalentIndexNames = dbIndexSignatures.get(manifestSignature);
      if (equivalentIndexNames && equivalentIndexNames.size > 0) {
        for (const name of equivalentIndexNames) {
          claimedDbIndexes.add(name);
        }
        continue;
      }

      // (c) Genuinely missing — add it.
      changes.push({
        type: 'add_index',
        table: tableName,
        name: idx.name,
        index: idx,
        sql: this.generateAddIndexSQL(tableName, idx),
      });
    }

    // Orphan-index sweep. Three tiers:
    //
    // - A redundant primary-key index — a non-unique single-column index over
    //   the table's sole primary-key column that the manifest no longer
    //   declares — is dropped unconditionally. Every generator path used to
    //   emit `<table>_id_idx` beside the engine's own primary-key index
    //   (#2359, A5); the constraint keeps serving every lookup, so the drop
    //   is a pure write-cost saving and `db:migrate` cleans it up without
    //   `--drop-indexes`.
    // - Unclaimed constraint-owned unique indexes (`*_key`) are never dropped
    //   but always *reported* (#2369) — a stale inline UNIQUE keeps rejecting
    //   duplicates the model now allows.
    // - Everything else is dropped only when the caller opts in via
    //   includeDroppedIndexes.
    for (const idx of dbSchema.indexes) {
      if (claimedDbIndexes.has(idx.name)) continue;

      // Belt-and-suspenders: even if a DB index wasn't formally claimed
      // by a manifest entry (e.g., shape-drift recreate consumed the
      // claim slot), don't drop it if its signature still matches
      // something the manifest declares. That would contradict the
      // option doc ("not functionally equivalent to anything in the
      // manifest") and risk dropping a still-needed index.
      const idxSignature = this.getIndexSignature(
        idx.columns,
        idx.unique ?? false,
        dbPredicateFor(idx.name),
      );
      if (manifestSignatureSet.has(idxSignature)) continue;

      if (isProtectedDbIndexName(idx.name)) {
        if (!idx.unique || idx.name.endsWith('_pkey')) continue;
        // A unique constraint index whose column(s) the manifest no longer
        // declares unique (column `unique: true` flipped off, or the field
        // was renamed/removed). Column-level `unique` is not represented in
        // `manifest.indexes`, so check the column definitions too.
        const backedByUniqueColumn =
          idx.columns.length === 1 &&
          manifest.columns[idx.columns[0]]?.unique === true;
        if (backedByUniqueColumn) continue;
        const cols = idx.columns.map((c) => this.quoteIdentifier(c)).join(', ');
        changes.push({
          type: 'orphan_index',
          table: tableName,
          name: idx.name,
          mismatch: {
            expected: '(not in manifest)',
            actual: `UNIQUE (${idx.columns.join(', ')})`,
          },
          advisory: {
            severity: 'warning',
            message: `Unique constraint ${idx.name} on ${tableName}(${idx.columns.join(', ')}) is no longer declared by the manifest; duplicate values the model now allows will still be rejected. Drop it manually.`,
            suggestedSql:
              this.engine === 'postgres'
                ? [
                    `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP CONSTRAINT IF EXISTS ${this.quoteIdentifier(idx.name)}`,
                    `DROP INDEX IF EXISTS ${this.quoteIdentifier(idx.name)} -- if it is a plain unique index on ${cols} rather than a constraint`,
                  ]
                : [this.generateDropIndexSQL(idx.name)],
          },
        });
        continue;
      }

      // "Sole primary-key column": a single-column index on one column of
      // a COMPOSITE primary key is not redundant (the PK index only serves
      // prefixes), so require the table to have exactly one PK column.
      // Non-unique only: the legacy `<table>_id_idx` never was unique, and a
      // UNIQUE single-column index on the PK may be the index that backs a
      // custom-named PRIMARY KEY constraint on PostgreSQL (only `*_pkey` is
      // filtered by introspection) — `DROP INDEX` on it fails and, because
      // migrate is atomic, would roll back the whole batch (#2359).
      const redundantPrimaryKeyIndex =
        idx.unique !== true &&
        idx.columns.length === 1 &&
        dbPredicateFor(idx.name) === '' &&
        primaryKeyColumns.length === 1 &&
        primaryKeyColumns[0] === idx.columns[0];
      if (!redundantPrimaryKeyIndex && !this.options.includeDroppedIndexes) {
        continue;
      }

      changes.push({
        type: 'drop_index',
        table: tableName,
        name: idx.name,
        sql: this.generateDropIndexSQL(idx.name),
      });
    }

    return changes;
  }

  /**
   * Generate a signature for an index based on its columns, uniqueness, and
   * (normalized) partial-index predicate. Used for functional equivalence
   * checking (Issue #741) and predicate-drift detection (Issue #1692).
   *
   * Note: Column order is preserved because it is semantically significant for
   * composite indexes. An index on (a, b) is NOT equivalent to (b, a) - they
   * have different query performance characteristics.
   *
   * The trailing predicate component distinguishes partial indexes that share
   * columns and uniqueness but differ by their `WHERE` clause (e.g. distinct
   * STI child partial indexes). Callers pass the already-normalized predicate
   * so both the manifest (desired) and introspected (DB) sides compare equal
   * for semantically-identical clauses. An empty string means "no predicate"
   * (a non-partial index) and is also used on both sides when predicate
   * introspection is unavailable, preserving the prior behavior.
   *
   * For JSON-path indexes (`@meta({ indexed: true })`) the signature is
   * derived from the JSON path instead of an empty column list, so the
   * differ can distinguish two jsonPath indexes against different paths.
   *
   * @param idxOrColumns - Either an IndexDefinition or a column array (legacy)
   * @param uniqueArg - Unique flag (used when first arg is a column array)
   * @param predicateArg - Normalized partial-index predicate (default '')
   * @returns Signature string
   */
  private getIndexSignature(
    idxOrColumns: IndexDefinition | string[],
    uniqueArg?: boolean,
    predicateArg = '',
  ): string {
    if (Array.isArray(idxOrColumns)) {
      return `${idxOrColumns.join(',')}:${Boolean(uniqueArg)}:${predicateArg}`;
    }
    const idx = idxOrColumns;
    if (isJsonPathIndex(idx) && idx.jsonPath) {
      return `json:${idx.jsonPath.column}.${idx.jsonPath.path}:${Boolean(idx.unique)}:${predicateArg}`;
    }
    return `${(idx.columns ?? []).join(',')}:${Boolean(idx.unique)}:${predicateArg}`;
  }

  /**
   * Whether the active engine supports partial indexes (`CREATE INDEX … WHERE`).
   *
   * SQLite and PostgreSQL do. DuckDB rejects them outright, and the JSON
   * adapter is DuckDB-backed, so on those engines a "partial" index can only
   * ever exist as a full index. Treating the predicate as significant there
   * would (a) flag existing full indexes as false drift and (b) emit
   * `CREATE INDEX … WHERE` DDL the engine rejects, breaking the migration.
   * Gating on this keeps both the comparison and the generated DDL aligned
   * with what the engine actually accepts (a partial index degrades to a
   * full index), matching the pre-#1692 behavior on those engines.
   */
  private supportsPartialIndexes(): boolean {
    return this.engine === 'sqlite' || this.engine === 'postgres';
  }

  /**
   * Introspect partial-index predicates for a table, keyed by index name.
   *
   * `getTableSchema()` (the @happyvertical/sql introspection) returns only
   * name/columns/unique, so the `WHERE` predicate is read directly here:
   *
   * - PostgreSQL: `pg_indexes.indexdef` carries the full CREATE INDEX text.
   * - SQLite: the `sqlite_master.sql` column carries the original CREATE INDEX
   *   text.
   *
   * Engines that don't support partial indexes (DuckDB / the DuckDB-backed
   * JSON adapter) short-circuit to `null` so the comparison stays
   * predicate-unaware there — see {@link supportsPartialIndexes}.
   *
   * Non-partial indexes are omitted from the map (callers treat a missing
   * entry as the empty predicate). Returns `null` when the catalog query
   * fails — e.g. an adapter exposing neither catalog — so the index
   * comparison can fall back to predicate-unaware behavior rather than
   * flagging every existing partial index as false drift.
   */
  private async getDbIndexPredicates(
    tableName: string,
  ): Promise<Map<string, string> | null> {
    if (!this.supportsPartialIndexes()) {
      return null;
    }
    const predicates = new Map<string, string>();
    try {
      if (this.engine === 'postgres') {
        const result = await this.db.query(
          `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ${this.quoteLiteral(
            tableName,
          )}`,
        );
        for (const row of result.rows as {
          indexname?: string;
          indexdef?: string;
        }[]) {
          if (!row.indexname || !row.indexdef) continue;
          const predicate = extractIndexPredicate(row.indexdef);
          if (predicate) predicates.set(row.indexname, predicate);
        }
        return predicates;
      }

      // SQLite exposes the `sqlite_master` catalog whose `sql` column preserves
      // the original CREATE INDEX text. Implicit indexes carry a NULL `sql` and
      // are skipped. (DuckDB / JSON already short-circuited above.)
      const result = await this.db.query(
        `SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ${this.quoteLiteral(
          tableName,
        )} AND name NOT LIKE 'sqlite_%'`,
      );
      for (const row of result.rows as {
        name?: string;
        sql?: string | null;
      }[]) {
        if (!row.name || !row.sql) continue;
        const predicate = extractIndexPredicate(row.sql);
        if (predicate) predicates.set(row.name, predicate);
      }
      return predicates;
    } catch (err) {
      logger.debug(
        `[SchemaComparer] Partial-index predicate introspection unavailable for ${tableName}; falling back to predicate-unaware index comparison`,
        { error: err instanceof Error ? err.message : String(err) },
      );
      return null;
    }
  }

  /**
   * Get list of existing tables from database
   */
  private async getExistingTables(): Promise<Set<string>> {
    let query: string;
    if (this.engine === 'postgres') {
      query = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    } else {
      // SQLite and DuckDB both expose the SQLite-compatible `sqlite_master`
      // catalog — DuckDB ships it as a built-in compatibility view, so a single
      // introspection query covers both engines. Verified against a live DuckDB
      // v1.4.3 (json mode): `SELECT name FROM sqlite_master WHERE type='table'`
      // returns user tables with the expected `name` column (#1579).
      query = `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`;
    }

    const result = await this.db.query(query);
    const rows = result.rows as { name?: string; table_name?: string }[];
    return new Set(
      rows.map((r) => r.name || r.table_name || '').filter(Boolean),
    );
  }

  /**
   * Normalize SQL types for comparison
   */
  private normalizeType(type: string): string {
    const upper = type
      .toUpperCase()
      .trim()
      .replace(/\(\s*\d+\s*\)/g, '');

    // Integer types
    if (/^(INTEGER|INT|BIGINT|SMALLINT|TINYINT)$/i.test(upper)) {
      return 'INTEGER';
    }

    // Text types
    if (/^(TEXT|CLOB|STRING|VARCHAR|CHAR)/i.test(upper)) {
      return 'TEXT';
    }

    // UUID normalizes to its own bucket — deliberately NOT folded into TEXT.
    // The text<->uuid drift tolerance (R11) is applied at the equality gate
    // in `compare()` only, so that `isCompatibleTypeUpgrade` (which also
    // calls normalizeType) still treats `uuid` as distinct from text and
    // won't mis-classify e.g. `uuid`->`timestamp` as a compatible
    // "TEXT->TIMESTAMP" upgrade.
    if (/^UUID$/i.test(upper)) {
      return 'UUID';
    }

    // Decimal types
    if (/^(REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|NUMBER)/i.test(upper)) {
      return 'REAL';
    }

    // Boolean types
    if (/^(BOOLEAN|BOOL)/i.test(upper)) {
      return 'BOOLEAN';
    }

    // PostgreSQL distinguishes instants from timezone-naive wall times. Keep
    // those in separate comparison buckets so legacy TIMESTAMP columns are
    // migrated to the TIMESTAMPTZ representation used for JavaScript Date.
    if (/^(TIMESTAMPTZ|TIMESTAMP\s+WITH\s+TIME\s+ZONE)$/i.test(upper)) {
      return 'TIMESTAMPTZ';
    }

    // Date/time types without timezone semantics
    if (
      /^(DATETIME|TIMESTAMP(?:\s+WITHOUT\s+TIME\s+ZONE)?|DATE|TIME)$/i.test(
        upper,
      )
    ) {
      return 'TIMESTAMP';
    }

    // Blob types
    if (/^(BLOB|BINARY|BYTEA)/i.test(upper)) {
      return 'BLOB';
    }

    // JSON types
    if (/^(JSON|JSONB)/i.test(upper)) {
      return 'JSON';
    }

    return upper;
  }

  /**
   * Check if a type change is a safe upgrade that can be auto-migrated.
   *
   * SMRT controls the data lifecycle for these columns, so we know:
   * - TEXT→JSON: The column stores JSON data serialized as text (arrays, objects)
   * - TEXT/JSON→TIMESTAMP: Legacy system columns stored timestamp strings
   *   before newer manifests normalized the column type.
   * - PostgreSQL TIMESTAMP→TIMESTAMPTZ: Legacy SMRT Date values were written
   *   as UTC ISO wall times, so interpreting the naive value as UTC preserves
   *   the originally supplied instant.
   * - INTEGER→REAL: Safe widening of integer to floating point
   * - TEXT/REAL→INTEGER on PostgreSQL: explicit data-checked repairs for
   *   legacy integer columns that were previously stored as text/real.
   *
   * @param manifestType - The abstract type from the manifest (e.g., 'JSON')
   * @param dbType - The actual type in the database (e.g., 'TEXT')
   * @returns true if the change from dbType to manifestType is a safe upgrade
   */
  private isCompatibleTypeUpgrade(
    manifestType: string,
    dbType: string,
  ): boolean {
    const manifest = this.normalizeType(manifestType);
    const db = this.normalizeType(dbType);

    if (
      this.engine === 'postgres' &&
      manifest === 'TIMESTAMP' &&
      ['TIMESTAMP', 'TEXT', 'JSON'].includes(db) &&
      this.ddlStrategy.mapType('TIMESTAMP') === 'TIMESTAMPTZ'
    ) {
      return this.options.postgresTimestampMigration?.legacyTimezone === 'UTC';
    }

    // TEXT → JSON is safe: SMRT serializes arrays/objects as JSON text
    // When the manifest says JSON, the data is already valid JSON in TEXT column
    if (manifest === 'JSON' && db === 'TEXT') {
      return true;
    }

    // JSON → TEXT is also safe (downgrade, but data is preserved as-is)
    if (manifest === 'TEXT' && db === 'JSON') {
      return true;
    }

    // UUID → TEXT is safe for plain text/provenance fields that were
    // mistakenly materialized as native uuid: the stored UUID value can be
    // rendered losslessly as text.
    if (manifest === 'TEXT' && db === 'UUID') {
      return true;
    }

    // INTEGER → REAL is safe (widening)
    if (manifest === 'REAL' && db === 'INTEGER') {
      return true;
    }

    // PostgreSQL can safely repair legacy integer columns when the generated
    // migration validates that every existing value is already an integer.
    if (
      this.engine === 'postgres' &&
      manifest === 'INTEGER' &&
      (db === 'TEXT' || db === 'REAL')
    ) {
      return true;
    }

    // TEXT/JSON → TIMESTAMP is a legacy-drift repair. Invalid values fail
    // explicitly during migration rather than being silently coerced.
    if (
      manifest === 'TIMESTAMP' &&
      (db === 'TEXT' || db === 'JSON') &&
      this.engine !== 'postgres'
    ) {
      return true;
    }

    return false;
  }

  /**
   * Generate SQL for a type upgrade migration.
   *
   * Engine-specific SQL:
   * - SQLite: TEXT and JSON are equivalent, no-op or comment
   * - DuckDB: ALTER COLUMN TYPE (native type conversion)
   * - PostgreSQL: ALTER COLUMN TYPE with USING clause
   */
  private generateTypeUpgradeSQL(
    tableName: string,
    colName: string,
    colDef: ColumnDefinition,
    dbType: string,
  ): GeneratedTypeUpgradeSQL {
    const quotedTable = this.quoteIdentifier(tableName);
    const quotedCol = this.quoteIdentifier(colName);
    const manifestType = colDef.type;

    // Validate manifestType before mapping
    const validatedType: SQLDataType = isValidSQLDataType(manifestType)
      ? manifestType
      : 'TEXT';
    const targetType = this.ddlStrategy.mapType(validatedType);

    switch (this.engine) {
      case 'sqlite':
        // SQLite has dynamic typing - TEXT and JSON are functionally equivalent
        // For SQLite, we just return a comment since no actual change is needed
        if (
          this.normalizeType(manifestType) === 'JSON' &&
          this.normalizeType(dbType) === 'TEXT'
        ) {
          return {
            sql: `-- SQLite: ${quotedCol} already stores JSON as TEXT (no change needed)`,
          };
        }
        // Every other upgrade needs the whole table rebuilt. `compareTable`
        // replaces this placeholder with the executable plan (#2370); it
        // survives only when the rebuild is unsafe or unavailable, and then
        // means the same thing it always did — manual intervention.
        return { sql: sqliteRebuildPlaceholderSql(colName) };

      case 'postgres': {
        // PostgreSQL defaults must be dropped/reset around some type changes
        // so drift repairs can succeed even when an existing default cannot
        // be cast automatically to the target type.
        const manifestNormalized = this.normalizeType(manifestType);
        const dbNormalized = this.normalizeType(dbType);
        const preflightSQL =
          manifestNormalized === 'INTEGER' &&
          (dbNormalized === 'TEXT' || dbNormalized === 'REAL')
            ? this.generatePostgresIntegerPreflightSQL(
                quotedTable,
                quotedCol,
                tableName,
                colName,
                dbNormalized,
              )
            : manifestNormalized === 'TIMESTAMP' &&
                ['TIMESTAMP', 'TEXT', 'JSON'].includes(dbNormalized) &&
                this.normalizeType(targetType) === 'TIMESTAMPTZ'
              ? this.generatePostgresTimestampPreflightSQL(tableName, colName)
              : null;
        const clauses: string[] = [];

        if (colDef.defaultValue !== undefined) {
          clauses.push(`ALTER COLUMN ${quotedCol} DROP DEFAULT`);
        }

        let typeClause = `ALTER COLUMN ${quotedCol} TYPE ${targetType}`;
        if (manifestNormalized === 'JSON' && dbNormalized === 'TEXT') {
          // #1335: a bare `${col}::jsonb` cast raises "invalid input syntax for
          // type json" on any row whose text is not already valid JSON (e.g. a
          // legacy enum column holding 'active'). `to_jsonb(col)` instead wraps
          // ANY text value as a JSON string and never errors, so a genuine
          // TEXT->JSON widening survives non-JSON legacy data. (Note: with the
          // json<->text equality tolerance added in this fix, the normal
          // compare path no longer reaches here; this keeps the SQL safe for
          // callers that construct a type_upgrade directly.)
          typeClause += ` USING to_jsonb(${quotedCol})`;
        } else if (manifestNormalized === 'TEXT' && dbNormalized === 'JSON') {
          // #1335: a native-json column cast back to text is value-preserving
          // (`::text` renders the stored JSON as its text form), so this arm is
          // safe. (Note: like the TEXT->JSON arm above, the json<->text equality
          // tolerance means the normal compare path no longer reaches here; this
          // keeps the SQL safe for callers that construct a type_upgrade
          // directly.)
          typeClause += ` USING ${quotedCol}::text`;
        } else if (manifestNormalized === 'TEXT' && dbNormalized === 'UUID') {
          typeClause += ` USING ${quotedCol}::text`;
        } else if (
          manifestNormalized === 'INTEGER' &&
          dbNormalized === 'TEXT'
        ) {
          typeClause += ` USING trim(${quotedCol}::text)::bigint`;
        } else if (
          manifestNormalized === 'INTEGER' &&
          dbNormalized === 'REAL'
        ) {
          typeClause += ` USING ${quotedCol}::bigint`;
        } else if (
          manifestNormalized === 'TIMESTAMP' &&
          (dbNormalized === 'TEXT' || dbNormalized === 'JSON')
        ) {
          typeClause += ` USING NULLIF(NULLIF(trim(both '"' from ${quotedCol}::text), ''), 'null')::timestamptz`;
        } else if (
          manifestNormalized === 'TIMESTAMP' &&
          dbNormalized === 'TIMESTAMP' &&
          this.normalizeType(targetType) === 'TIMESTAMPTZ'
        ) {
          // SMRT's PostgreSQL adapter serialized Date values to UTC ISO strings.
          // A legacy TIMESTAMP column discarded the trailing offset but kept
          // that UTC wall time. Reattach UTC explicitly so migration is
          // deterministic regardless of the database/session timezone.
          typeClause += ` USING ${quotedCol} AT TIME ZONE 'UTC'`;
        }

        clauses.push(typeClause);

        if (colDef.defaultValue !== undefined) {
          const formattedDefault = this.ddlStrategy.formatDefaultValue(
            colDef.defaultValue,
            validatedType,
          );
          const defaultSql =
            manifestNormalized === 'JSON'
              ? `${formattedDefault}::${targetType.toLowerCase()}`
              : formattedDefault;
          clauses.push(`ALTER COLUMN ${quotedCol} SET DEFAULT ${defaultSql}`);
        }

        const alterSql = `ALTER TABLE ${quotedTable} ${clauses.join(', ')}`;

        return preflightSQL
          ? { sql: alterSql, statements: [preflightSQL, alterSql] }
          : { sql: alterSql };
      }

      case 'duckdb':
        // DuckDB supports ALTER COLUMN TYPE for type conversions
        return {
          sql: `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} TYPE ${targetType}`,
        };

      default: {
        // Escape special characters in type names for safe comment generation
        const safeDbType = dbType.replace(/[^\w]/g, '_');
        const safeManifestType = manifestType.replace(/[^\w]/g, '_');
        return {
          sql: `-- Type upgrade for ${quotedCol}: ${safeDbType} → ${safeManifestType}`,
        };
      }
    }
  }

  /**
   * Quote a SQL identifier
   */
  private quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Generate a PostgreSQL preflight guard for narrowing legacy columns to
   * INTEGER. PostgreSQL's REAL→INTEGER cast rounds fractional values, so the
   * generated migration must fail before the ALTER can silently change data.
   */
  private generatePostgresIntegerPreflightSQL(
    quotedTable: string,
    quotedCol: string,
    tableName: string,
    colName: string,
    dbNormalized: string,
  ): string {
    const invalidCondition =
      dbNormalized === 'REAL'
        ? `${quotedCol} IS NOT NULL AND ${quotedCol} <> trunc(${quotedCol})`
        : `${quotedCol} IS NOT NULL AND trim(${quotedCol}::text) !~ '^[+-]?[0-9]+$'`;
    const message = `Cannot convert ${tableName}.${colName} to INTEGER: found non-integer values`;

    return `DO $$ BEGIN IF EXISTS (SELECT 1 FROM ${quotedTable} WHERE ${invalidCondition}) THEN RAISE EXCEPTION ${this.quoteLiteral(message)}; END IF; END $$`;
  }

  /**
   * Require a UTC migration session before reattaching the offset discarded by
   * legacy PostgreSQL TIMESTAMP columns. This is a guardrail, not provenance:
   * operators must also confirm historical default/raw writers used UTC.
   */
  private generatePostgresTimestampPreflightSQL(
    tableName: string,
    colName: string,
  ): string {
    const message =
      `Cannot convert ${tableName}.${colName} to TIMESTAMPTZ outside a UTC ` +
      'PostgreSQL session; confirm historical writers used UTC and SET TIME ZONE UTC';
    return `DO $$ BEGIN IF upper(current_setting('TimeZone')) NOT IN ('UTC', 'ETC/UTC', 'GMT') THEN RAISE EXCEPTION ${this.quoteLiteral(message)}; END IF; END $$`;
  }

  private quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  /**
   * Plan the changes that add a missing column so the emitted DDL is
   * executable on the active engine (#2369).
   *
   * Engines disagree on what `ALTER TABLE ... ADD COLUMN` may carry inline
   * (probed on SQLite 3.4x/3.5x, DuckDB 1.4.x, PostgreSQL 16/17):
   *
   * | clause          | SQLite                         | DuckDB   | PostgreSQL          |
   * |-----------------|--------------------------------|----------|---------------------|
   * | NOT NULL + DEF  | ok                             | rejected | ok                  |
   * | NOT NULL, no DEF| ok on empty, rejected populated| rejected | ok empty, rej. pop. |
   * | UNIQUE          | rejected                       | rejected | ok                  |
   * | DEFAULT         | ok                             | ok       | ok                  |
   * | CHECK           | ok                             | rejected | ok                  |
   *
   * so the plan is:
   * - `NOT NULL` with a default: inline on SQLite/PostgreSQL (existing rows
   *   receive the default); DuckDB adds with `DEFAULT` then a separate
   *   `ALTER COLUMN ... SET NOT NULL`.
   * - `NOT NULL` without a default: enforced only when the table is empty
   *   (inline on SQLite/PostgreSQL, `SET NOT NULL` step on DuckDB). On a
   *   populated table there is nothing to backfill with, so the column is
   *   added nullable and a manual `alter_column` (`set_not_null`) is reported
   *   with the exact remediation instead of emitting DDL every engine rejects.
   * - `UNIQUE`: inline on PostgreSQL (a real constraint); SQLite/DuckDB get a
   *   separate `CREATE UNIQUE INDEX <table>_<col>_key` (the PostgreSQL
   *   constraint-index name, so the orphan sweep leaves it alone).
   * - `CHECK`: inline where accepted; DuckDB rejects it in ADD COLUMN, so it
   *   is dropped there with a warning (SMRT's generators never emit `check`).
   *
   * The primary `add_column` change carries the whole plan in
   * `sqlStatements` (and the last statement in `sql`) so both the CLI and the
   * orchestrator execute it as one unit.
   */
  private async generateAddColumnChanges(
    tableName: string,
    colName: string,
    colDef: ColumnDefinition,
  ): Promise<SchemaChange[]> {
    // mapType maps abstract types per dialect (UUID→native uuid / TEXT — R11);
    // invalid types fall back to TEXT, matching the compareColumns guard.
    const validatedType: SQLDataType = isValidSQLDataType(colDef.type)
      ? colDef.type
      : 'TEXT';
    if (!isValidSQLDataType(colDef.type)) {
      logger.warn(
        `[SchemaComparer] Invalid manifest type "${colDef.type}" for ${tableName}.${colName}, treating as TEXT`,
      );
    }

    const quotedTable = this.quoteIdentifier(tableName);
    const quotedCol = this.quoteIdentifier(colName);
    const parts: string[] = [
      quotedCol,
      this.ddlStrategy.mapType(validatedType),
    ];
    const followUps: string[] = [];
    const extraChanges: SchemaChange[] = [];

    const hasDefault =
      colDef.defaultValue !== undefined && colDef.defaultValue !== null;
    const formattedDefault = hasDefault
      ? this.ddlStrategy.formatDefaultValue(colDef.defaultValue, validatedType)
      : undefined;
    const inlineConstraintsAllowed =
      this.engine !== 'duckdb' && this.engine !== 'json';
    const setNotNull = `ALTER TABLE ${quotedTable} ALTER COLUMN ${quotedCol} SET NOT NULL`;

    let enforceNotNull = false;
    if (colDef.notNull) {
      if (hasDefault) {
        enforceNotNull = true;
      } else if (!(await this.tableHasRows(tableName))) {
        enforceNotNull = true;
      } else {
        // Populated table, no default: nothing to backfill with. Add the
        // column nullable and report the constraint as a manual follow-up.
        extraChanges.push({
          type: 'alter_column',
          table: tableName,
          name: colName,
          column: colDef,
          alteration: 'set_not_null',
          mismatch: { expected: 'NOT NULL', actual: 'NULL' },
          sql: `-- ${tableName}.${colName} is required by the manifest but has no default to backfill existing rows; the column is added nullable. Backfill it, then run: ${setNotNull}`,
          advisory: {
            severity: 'warning',
            message: `${tableName}.${colName} is required by the manifest but has no default, and ${tableName} already holds rows — no engine can add it NOT NULL. It is added nullable; backfill it, then rerun db:migrate (or declare a default on the field).`,
            suggestedSql: [
              `UPDATE ${quotedTable} SET ${quotedCol} = <value> WHERE ${quotedCol} IS NULL`,
              this.supportsAlterColumn()
                ? setNotNull
                : `-- SQLite: enforcing NOT NULL afterwards requires a table rebuild (#2370)`,
            ],
          },
        });
      }
    }

    if (enforceNotNull && inlineConstraintsAllowed) {
      parts.push('NOT NULL');
    }
    if (colDef.unique && this.engine === 'postgres') {
      parts.push('UNIQUE');
    }
    if (formattedDefault !== undefined) {
      parts.push(`DEFAULT ${formattedDefault}`);
    }
    if (colDef.check) {
      if (inlineConstraintsAllowed) {
        parts.push(`CHECK (${colDef.check})`);
      } else {
        logger.warn(
          `[SchemaComparer] ${this.engine} rejects CHECK constraints in ADD COLUMN; ${tableName}.${colName} is added without CHECK (${colDef.check})`,
        );
      }
    }

    const addColumn = `ALTER TABLE ${quotedTable} ADD COLUMN ${parts.join(' ')}`;

    if (enforceNotNull && !inlineConstraintsAllowed) {
      followUps.push(setNotNull);
    }
    if (colDef.unique && this.engine !== 'postgres') {
      followUps.push(
        `CREATE UNIQUE INDEX ${this.quoteIdentifier(uniqueColumnIndexName(tableName, colName))} ON ${quotedTable} (${quotedCol})`,
      );
      // DuckDB has no `ADD CONSTRAINT`, so this is the only way to add
      // uniqueness to an existing table there. The DuckDB strategy's
      // `requiresInlineUnique()` note (DuckDB #12684: ON CONFLICT ignored
      // separate unique indexes) no longer holds on the bundled DuckDB 1.4.x —
      // `INSERT … ON CONFLICT (col) DO UPDATE` resolves through this index;
      // the #2369 DuckDB test pins that. Older DuckDB builds may still need
      // the inline form for upserts on such a column.
    }

    const statements = [addColumn, ...followUps];
    const primary: SchemaChange = {
      type: 'add_column',
      table: tableName,
      name: colName,
      column: colDef,
      // `sql` stays the ADD COLUMN itself for single-statement consumers;
      // `sqlStatements` carries the full ordered plan when there is more.
      sql: addColumn,
      ...(statements.length > 1 ? { sqlStatements: statements } : {}),
    };

    return [primary, ...extraChanges];
  }

  /**
   * Generate SQL for dropping a column
   */
  private generateDropColumnSQL(tableName: string, colName: string): string {
    return `ALTER TABLE ${this.quoteIdentifier(tableName)} DROP COLUMN ${this.quoteIdentifier(colName)}`;
  }

  /**
   * Generate SQL for adding an index.
   *
   * On engines that support partial indexes (SQLite/PostgreSQL) this mirrors
   * the canonical CREATE INDEX path in the DDL strategies: a partial index
   * appends its `WHERE` predicate so a detected predicate add/alter (issue
   * #1692) recreates the index with the correct partial condition rather than
   * silently widening it to a full index. On DuckDB / the JSON adapter — which
   * reject partial indexes — the predicate is dropped so the emitted DDL stays
   * executable (a partial index degrades to a full index there). The predicate
   * is trimmed and a redundant leading `WHERE` stripped for robustness.
   *
   * `IF NOT EXISTS` matches the canonical `generateIndexes()` DDL path and
   * makes a retry after a partially applied batch repair the schema instead of
   * erroring on the indexes that did land (issue #2362). All three engines
   * (SQLite, PostgreSQL, DuckDB) accept the clause.
   */
  private generateAddIndexSQL(tableName: string, idx: IndexDefinition): string {
    const uniqueStr = idx.unique ? 'UNIQUE ' : '';
    const target = renderIndexTarget(idx, this.engine);
    let sql = `CREATE ${uniqueStr}INDEX IF NOT EXISTS ${this.quoteIdentifier(idx.name)} ON ${this.quoteIdentifier(tableName)} (${target})`;
    const where = idx.where?.trim().replace(/^WHERE\s+/i, '');
    if (this.supportsPartialIndexes() && where) {
      sql += ` WHERE ${where}`;
    }
    return sql;
  }

  /**
   * Generate SQL for dropping an index.
   *
   * This SQL is consumed by the manifest-driven execution path:
   *
   * - `db:migrate` runs the SQL we put in `change.sql` directly, with the
   *   tracker's `executePostgresStatements` adding CONCURRENTLY when
   *   `--postgres-safe` is on.
   *
   * PostgreSQL ends up with `CONCURRENTLY` when it should.
   * Keeping this method engine-agnostic also means the diff preview text
   * stays readable (no engine-specific noise) for engines like SQLite
   * where CONCURRENTLY isn't a thing.
   */
  private generateDropIndexSQL(indexName: string): string {
    return `DROP INDEX IF EXISTS ${this.quoteIdentifier(indexName)}`;
  }
}

/**
 * Generate a SchemaDiff from manifest and database
 */
export async function generateSchemaDiff(
  db: DatabaseInterface,
  manifestSchemas: Record<string, SchemaDefinition>,
  options: DiffOptions = {},
): Promise<SchemaDiff> {
  const comparer = new SchemaComparer(db, options);
  return comparer.compare(manifestSchemas);
}

/**
 * Check if a diff has any actionable changes — a table to create or drop, or
 * a change with executable DDL. Incompatible type mismatches, report-only
 * advisories (orphan columns/indexes, relaxations the caller has not opted
 * into) and comment-only changes (SQLite in-place limitations, live data
 * blocking a repair) are not actionable; they surface through
 * `unactionableChanges` / the CLI's manual bucket instead.
 */
export function hasActionableChanges(diff: SchemaDiff): boolean {
  if (diff.added_tables.length > 0) return true;
  if (diff.dropped_tables.length > 0) return true;
  return diff.changes.some((c) => !isManualOrAdvisoryChange(c));
}

/**
 * Get SQL statements from a diff for execution. Advisory-only changes carry
 * no statements and are skipped; comment-only statements (SQLite in-place
 * limitations) pass through unchanged so callers can filter them the way
 * they already do for `type_upgrade`.
 */
export function getSQLFromDiff(diff: SchemaDiff): string[] {
  const statements: string[] = [];

  // Add table creation (requires full DDL generation - not included here)
  // This is typically handled by ensureSchema()

  // Add column and index changes
  for (const change of diff.changes) {
    if (change.type !== 'type_mismatch' && !isAdvisoryOnlyChange(change)) {
      statements.push(
        ...(change.sqlStatements ?? (change.sql ? [change.sql] : [])),
      );
    }
  }

  return statements;
}
