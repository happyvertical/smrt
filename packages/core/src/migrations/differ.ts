/**
 * Schema Differ
 *
 * Compares manifest schemas to database schemas and generates
 * a SchemaDiff with the differences.
 */

import { createLogger } from '@happyvertical/logger';
import { detectEngine, getDDLStrategy } from '../schema/ddl/index.js';
import type { DatabaseEngine } from '../schema/ddl/types.js';
import type {
  ColumnDefinition,
  IndexDefinition,
  SchemaChange,
  SchemaDefinition,
  SchemaDiff,
  SQLDataType,
} from '../schema/types.js';
import { isJsonPathIndex, renderIndexTarget } from '../schema/utils.js';
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
  /** Include dropped tables in diff (default: false for safety) */
  includeDroppedTables?: boolean;
  /** Include dropped columns in diff (default: false for safety) */
  includeDroppedColumns?: boolean;
  /**
   * Drop indexes that exist in the database but are absent from the manifest
   * AND are not functionally equivalent to anything in the manifest. Default:
   * false. The differ always skips primary-key indexes (`*_pkey`) and the
   * implicit indexes that PostgreSQL creates from inline UNIQUE constraints
   * (`*_key`) — those are owned by table-level constraints, not by the
   * index list, and dropping them here would break the constraint.
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
}

/**
 * Suffix patterns for indexes that the differ refuses to drop.
 * - `_pkey`: PostgreSQL primary key implicit index.
 * - `_key`: PostgreSQL implicit index for inline `UNIQUE (...)` table
 *   constraints. Dropping these by name does not drop the underlying
 *   constraint, and dropping the constraint requires a separate DDL path
 *   (`ALTER TABLE ... DROP CONSTRAINT`) the differ does not emit today.
 */
const PROTECTED_INDEX_SUFFIXES = ['_pkey', '_key'];

function isProtectedDbIndexName(name: string): boolean {
  return PROTECTED_INDEX_SUFFIXES.some((suffix) => name.endsWith(suffix));
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
          diff.has_changes = true;
        }
      }
    }

    // Check for dropped tables (if enabled)
    if (this.options.includeDroppedTables) {
      for (const tableName of existingTables) {
        // Skip system tables
        if (tableName.startsWith('_smrt_') || tableName.startsWith('sqlite_')) {
          continue;
        }
        if (!manifestSchemas[tableName]) {
          diff.dropped_tables.push(tableName);
          diff.has_changes = true;
        }
      }
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
    const columnChanges = this.compareColumns(tableName, manifest, dbSchema);
    changes.push(...columnChanges);

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

    return changes;
  }

  /**
   * Compare columns between manifest and database
   */
  private compareColumns(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: SqlTableSchemaInfo,
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];
    const dbColumnNames = new Set(Object.keys(dbSchema.columns));

    // Check for new and modified columns
    for (const [colName, colDef] of Object.entries(manifest.columns)) {
      if (!dbColumnNames.has(colName)) {
        // Column doesn't exist - add it
        changes.push({
          type: 'add_column',
          table: tableName,
          name: colName,
          column: colDef,
          sql: this.generateAddColumnSQL(tableName, colName, colDef),
        });
      } else {
        // Column exists - check for type mismatch
        const dbCol = dbSchema.columns[colName];

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
      }
    }

    // Check for dropped columns (if enabled)
    if (this.options.includeDroppedColumns) {
      const manifestColumnNames = new Set(Object.keys(manifest.columns));
      for (const colName of dbColumnNames) {
        if (!manifestColumnNames.has(colName)) {
          changes.push({
            type: 'drop_column',
            table: tableName,
            name: colName,
            sql: this.generateDropColumnSQL(tableName, colName),
          });
        }
      }
    }

    return changes;
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
   *    that the differ does not emit yet.
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
    for (const idx of manifest.indexes) {
      manifestSignatureSet.add(
        this.getIndexSignature(idx, undefined, manifestPredicateFor(idx)),
      );
    }

    // Track which DB indexes a manifest entry has claimed, so the orphan
    // pass below doesn't re-flag indexes that match by signature alone.
    const claimedDbIndexes = new Set<string>();

    for (const idx of manifest.indexes) {
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

    // Orphan-index sweep (opt-in via includeDroppedIndexes).
    if (this.options.includeDroppedIndexes) {
      for (const idx of dbSchema.indexes) {
        if (claimedDbIndexes.has(idx.name)) continue;
        if (isProtectedDbIndexName(idx.name)) continue;

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

        changes.push({
          type: 'drop_index',
          table: tableName,
          name: idx.name,
          sql: this.generateDropIndexSQL(idx.name),
        });
      }
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
   * Introspect partial-index predicates for a table, keyed by index name.
   *
   * `getTableSchema()` (the @happyvertical/sql introspection) returns only
   * name/columns/unique, so the `WHERE` predicate is read directly here:
   *
   * - PostgreSQL: `pg_indexes.indexdef` carries the full CREATE INDEX text.
   * - SQLite / DuckDB / JSON adapter: the `sqlite_master.sql` column carries
   *   the original CREATE INDEX text. DuckDB ships a `sqlite_master`
   *   compatibility view and the JSON adapter is DuckDB-backed, so the same
   *   query covers all three. (DuckDB rejects partial indexes outright, so
   *   in practice only non-partial — empty-predicate — rows come back there.)
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

      // SQLite, DuckDB, and the JSON adapter all expose the SQLite-compatible
      // `sqlite_master` catalog whose `sql` column preserves the original
      // CREATE INDEX text. Implicit indexes carry a NULL `sql` and are skipped.
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
    const upper = type.toUpperCase().trim();

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

    // Date/time types
    if (/^(DATETIME|TIMESTAMP|DATE|TIME)/i.test(upper)) {
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
    if (manifest === 'TIMESTAMP' && (db === 'TEXT' || db === 'JSON')) {
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
        // For other type upgrades, SQLite requires recreating the table
        return {
          sql: `-- SQLite: Type upgrade for ${quotedCol} requires table recreation`,
        };

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
          typeClause += ` USING trim(${quotedCol}::text)::integer`;
        } else if (
          manifestNormalized === 'INTEGER' &&
          dbNormalized === 'REAL'
        ) {
          typeClause += ` USING ${quotedCol}::integer`;
        } else if (
          manifestNormalized === 'TIMESTAMP' &&
          (dbNormalized === 'TEXT' || dbNormalized === 'JSON')
        ) {
          typeClause += ` USING NULLIF(NULLIF(trim(both '"' from ${quotedCol}::text), ''), 'null')::timestamp`;
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

  private quoteLiteral(value: string): string {
    return `'${value.replace(/'/g, "''")}'`;
  }

  /**
   * Generate SQL for adding a column
   */
  private generateAddColumnSQL(
    tableName: string,
    colName: string,
    colDef: ColumnDefinition,
  ): string {
    // Build the ADD COLUMN definition inline (main) rather than delegating to
    // the DDL strategy's generateColumnDefinition: that builder is for CREATE
    // TABLE and would emit `PRIMARY KEY` (invalid in ALTER ... ADD COLUMN) and
    // suppress single-column UNIQUE on engines that require inline unique at
    // table-create time (DuckDB) — but an ADD COLUMN has no inline-constraint
    // pass, so the UNIQUE must be emitted here. mapType still maps abstract
    // types per dialect (UUID→native uuid / TEXT — R11); invalid types fall
    // back to TEXT, matching the compareColumns guard.
    const validatedType: SQLDataType = isValidSQLDataType(colDef.type)
      ? colDef.type
      : 'TEXT';
    if (!isValidSQLDataType(colDef.type)) {
      logger.warn(
        `[SchemaComparer] Invalid manifest type "${colDef.type}" for ${tableName}.${colName}, treating as TEXT`,
      );
    }

    const parts: string[] = [
      this.quoteIdentifier(colName),
      this.ddlStrategy.mapType(validatedType),
    ];

    if (colDef.notNull) {
      parts.push('NOT NULL');
    }
    if (colDef.unique) {
      parts.push('UNIQUE');
    }
    if (colDef.defaultValue !== undefined) {
      const defaultVal = this.ddlStrategy.formatDefaultValue(
        colDef.defaultValue,
        validatedType,
      );
      parts.push(`DEFAULT ${defaultVal}`);
    }
    if (colDef.check) {
      parts.push(`CHECK (${colDef.check})`);
    }

    const columnDefinition = parts.join(' ');

    return `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${columnDefinition}`;
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
   * Mirrors the canonical CREATE INDEX path in the DDL strategies: a partial
   * index appends its `WHERE` predicate so a detected predicate add/alter
   * (issue #1692) recreates the index with the correct partial condition
   * rather than silently widening it to a full index.
   */
  private generateAddIndexSQL(tableName: string, idx: IndexDefinition): string {
    const uniqueStr = idx.unique ? 'UNIQUE ' : '';
    const target = renderIndexTarget(idx, this.engine);
    let sql = `CREATE ${uniqueStr}INDEX ${this.quoteIdentifier(idx.name)} ON ${this.quoteIdentifier(tableName)} (${target})`;
    if (idx.where) {
      sql += ` WHERE ${idx.where}`;
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
 * Check if a diff has any actionable changes (excluding type mismatches)
 */
export function hasActionableChanges(diff: SchemaDiff): boolean {
  if (diff.added_tables.length > 0) return true;
  if (diff.dropped_tables.length > 0) return true;
  return diff.changes.some((c) => c.type !== 'type_mismatch');
}

/**
 * Get SQL statements from a diff for execution
 */
export function getSQLFromDiff(diff: SchemaDiff): string[] {
  const statements: string[] = [];

  // Add table creation (requires full DDL generation - not included here)
  // This is typically handled by ensureSchema()

  // Add column and index changes
  for (const change of diff.changes) {
    if (change.type !== 'type_mismatch') {
      statements.push(
        ...(change.sqlStatements ?? (change.sql ? [change.sql] : [])),
      );
    }
  }

  return statements;
}
