/**
 * Schema Differ
 *
 * Compares manifest schemas to database schemas and generates
 * a SchemaDiff with the differences.
 */

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
import type { DatabaseInterface, SqlTableSchemaInfo } from './types.js';

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
    // Handles :memory:, .json, and other edge cases. `engineHint` lets
    // callers override URL-based detection when `db.url` is empty or
    // points at an adapter whose engine isn't obvious from the URL alone
    // (JSON, some in-memory wrappers).
    this.engine = detectEngine(this.db.url || '', this.options.engineHint);
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

    // Compare indexes
    const indexChanges = this.compareIndexes(tableName, manifest, dbSchema);
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
          console.warn(
            `[SchemaComparer] Invalid manifest type "${manifestType}" for ${tableName}.${colName}, treating as TEXT`,
          );
        }
        const validatedType: SQLDataType = isValidSQLDataType(manifestType)
          ? manifestType
          : 'TEXT';
        const expectedEngineType = this.ddlStrategy.mapType(validatedType);
        const normalizedExpected = this.normalizeType(expectedEngineType);
        const normalizedActual = this.normalizeType(dbCol.type);

        if (normalizedExpected !== normalizedActual) {
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

  /**
   * Compare indexes between manifest and database
   *
   * Three classes of drift the differ now detects:
   *
   * 1. **Missing index** — manifest has an index neither the DB has by name
   *    nor any equivalent-by-signature. Emit `add_index`. (Issue #741: the
   *    signature check protects against creating duplicates when STI child
   *    classes register indexes with different name prefixes.)
   *
   * 2. **Same-name shape drift** — DB has an index with the manifest's name,
   *    but its columns or uniqueness flag differ. This is the failure mode
   *    in issue #1165: `tenants_slug_context_meta_type_idx` exists but is
   *    non-unique, while the manifest declares it unique. Emit
   *    `drop_index` + `add_index` so the next migrate cycle recreates it
   *    with the correct shape.
   *
   * 3. **Orphan in DB** — DB has an index with no manifest counterpart by
   *    name and no signature equivalent. Emit `drop_index` *only* when the
   *    caller opts in via `includeDroppedIndexes`, and even then never for
   *    PostgreSQL implicit indexes (`*_pkey`, `*_key`) — those are owned by
   *    table-level constraints and need a separate `DROP CONSTRAINT` path
   *    that the differ does not emit yet.
   */
  private compareIndexes(
    tableName: string,
    manifest: SchemaDefinition,
    dbSchema: SqlTableSchemaInfo,
  ): SchemaChange[] {
    const changes: SchemaChange[] = [];

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
      const signature = this.getIndexSignature(idx.columns, unique);
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
        this.getIndexSignature(idx.columns, idx.unique ?? false),
      );
    }

    // Track which DB indexes a manifest entry has claimed, so the orphan
    // pass below doesn't re-flag indexes that match by signature alone.
    const claimedDbIndexes = new Set<string>();

    for (const idx of manifest.indexes) {
      const manifestUnique = idx.unique ?? false;
      const manifestSignature = this.getIndexSignature(
        idx.columns,
        manifestUnique,
      );

      // (a) Same name in DB — verify shape matches.
      const dbByName = dbIndexesByName.get(idx.name);
      if (dbByName) {
        claimedDbIndexes.add(idx.name);
        const dbSignature = this.getIndexSignature(
          dbByName.columns,
          dbByName.unique,
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
   * Generate a signature for an index based on its columns and uniqueness.
   * Used for functional equivalence checking (Issue #741).
   *
   * Note: Column order is preserved because it is semantically significant for
   * composite indexes. An index on (a, b) is NOT equivalent to (b, a) - they
   * have different query performance characteristics.
   *
   * Limitation: Partial indexes (with WHERE clauses) are not fully supported.
   * The database introspection layer doesn't provide WHERE clause information,
   * so two partial indexes with the same columns but different WHERE clauses
   * cannot be distinguished and may be incorrectly treated as equivalent.
   *
   * @param columns - Array of column names (order is preserved)
   * @param unique - Whether the index is unique
   * @returns Signature string like "col1,col2:false"
   */
  private getIndexSignature(columns: string[], unique: boolean): string {
    // Preserve column order because it is semantically significant for composite indexes
    const columnList = columns.join(',');
    return `${columnList}:${unique}`;
  }

  /**
   * Get list of existing tables from database
   */
  private async getExistingTables(): Promise<Set<string>> {
    // Query differs by database type
    const dbUrl = this.db.url || '';

    let query: string;
    if (dbUrl.startsWith('postgres://') || dbUrl.startsWith('postgresql://')) {
      query = `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
    } else {
      // SQLite and DuckDB
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
          typeClause += ` USING ${quotedCol}::${targetType.toLowerCase()}`;
        } else if (manifestNormalized === 'TEXT' && dbNormalized === 'JSON') {
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
    const validatedType: SQLDataType = isValidSQLDataType(colDef.type)
      ? colDef.type
      : 'TEXT';
    if (!isValidSQLDataType(colDef.type)) {
      console.warn(
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
   * Generate SQL for adding an index
   */
  private generateAddIndexSQL(tableName: string, idx: IndexDefinition): string {
    const uniqueStr = idx.unique ? 'UNIQUE ' : '';
    const quotedColumns = idx.columns
      .map((c) => this.quoteIdentifier(c))
      .join(', ');
    return `CREATE ${uniqueStr}INDEX ${this.quoteIdentifier(idx.name)} ON ${this.quoteIdentifier(tableName)} (${quotedColumns})`;
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
