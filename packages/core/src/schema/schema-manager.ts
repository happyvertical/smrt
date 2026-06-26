/**
 * Schema Manager - Direct DDL Execution for SMRT
 *
 * SMRT handles ALL database maintenance directly.
 * SDK SQL remains a pure query/CRUD layer.
 *
 * This module replaces the use of SDK's syncSchema() with direct DDL execution
 * using engine-specific DDL strategies.
 */

import { createLogger } from '@happyvertical/logger';
import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type DatabaseEngine,
  detectEngine,
  type EngineSpecificDDL,
  getDDLStrategy,
} from './ddl/index.js';
import type { SchemaDefinition } from './types.js';

/**
 * Normalize a `db.query` result into an array of rows.
 *
 * Adapters return either a bare row array or a `{ rows }` envelope. This
 * mirrors the prior inline `Array.isArray(result) ? result : result?.rows ?? []`
 * narrowing while keeping the row shape typed for callers.
 */
function extractRows<Row>(result: unknown): Row[] {
  if (Array.isArray(result)) {
    return result as Row[];
  }
  const rows = (result as { rows?: unknown } | null | undefined)?.rows;
  return Array.isArray(rows) ? (rows as Row[]) : [];
}

/**
 * Schema Manager Options
 */
export interface SchemaManagerOptions {
  /** Force engine type (overrides auto-detection) */
  engine?: DatabaseEngine;
  /** Whether to skip triggers (useful for DuckDB-backed JSON) */
  skipTriggers?: boolean;
  /** Log DDL statements before execution */
  debug?: boolean;
}

/**
 * Schema Manager
 *
 * Handles direct DDL execution for database schema management.
 * Replaces SDK's syncSchema() with SMRT-controlled schema creation.
 */
export class SchemaManager {
  private db: DatabaseInterface;
  private engine: DatabaseEngine;
  private options: SchemaManagerOptions;
  // Per-instance logger: the `debug` option must actually emit debug traces, so
  // the level follows it (a fixed level: 'info' would filter every debug call).
  private logger: ReturnType<typeof createLogger>;

  constructor(db: DatabaseInterface, options: SchemaManagerOptions = {}) {
    this.db = db;
    this.options = options;
    this.logger = createLogger({ level: options.debug ? 'debug' : 'info' });

    // Detect or use provided engine
    if (options.engine) {
      this.engine = options.engine;
    } else if ((db as { exportTable?: unknown }).exportTable) {
      // JSON adapter detected (has unique exportTable method)
      // JSON adapter uses DuckDB internally, but native UUID values do not
      // round-trip through the SDK row objects as canonical UUID strings.
      this.engine = 'json';
    } else {
      this.engine = detectEngine(db.url);
    }
  }

  /**
   * Ensure a table exists with the correct schema
   *
   * If table doesn't exist, creates it with DDL from the engine-specific strategy.
   * If table exists but is missing columns, adds them via ALTER TABLE ADD COLUMN.
   *
   * @param schema - The schema definition
   */
  async ensureTable(schema: SchemaDefinition): Promise<void> {
    const { tableName } = schema;

    // Check if table already exists
    const exists = await this.db.tableExists(tableName);
    if (exists) {
      // Table exists — check for missing columns and add them
      // This handles the case where a table was created with a partial schema
      // (e.g., base SmrtObject fields only) and needs additional columns
      await this.addMissingColumns(tableName, schema);

      if (this.options.debug) {
        this.logger.debug(
          `[SchemaManager] Table "${tableName}" already exists, checked for missing columns`,
        );
      }
      return;
    }

    // Generate DDL using engine-specific strategy
    const strategy = getDDLStrategy(this.engine);
    const ddl: EngineSpecificDDL = {
      createTable: strategy.generateCreateTable(schema),
      indexes: strategy.generateIndexes(schema),
      triggers: strategy.generateTriggers(schema),
    };

    // Prefer adapter's syncSchema if available (handles adapter-specific transformations)
    // This is critical for JSON adapter which needs to convert UNIQUE indexes to
    // inline constraints for DuckDB compatibility
    // Adapters that support direct DDL sync expose an optional `syncSchema`
    // method beyond the base `DatabaseInterface`; narrow to it here so both the
    // capability check and the call preserve `this.db` as the receiver.
    const dbWithSync = this.db as DatabaseInterface & {
      syncSchema?: (schema: string) => Promise<void>;
    };
    if (dbWithSync.syncSchema) {
      // Combine DDL into single schema string for adapter's syncSchema
      const fullSchema = [
        ddl.createTable,
        ...ddl.indexes,
        ...(this.options.skipTriggers ? [] : ddl.triggers),
      ].join(';\n');

      if (this.options.debug) {
        this.logger.debug(
          `[SchemaManager] Using adapter syncSchema for "${tableName}"`,
          { fullSchema },
        );
      }

      try {
        await dbWithSync.syncSchema(fullSchema);

        // FIX #735: Verify table was actually created
        // Some adapters (notably PostgreSQL) may silently fail to create tables
        // when syncSchema returns without error but doesn't execute the DDL
        const createdSuccessfully = await this.db.tableExists(tableName);
        if (createdSuccessfully) {
          if (this.options.debug) {
            this.logger.debug(
              `[SchemaManager] Table "${tableName}" created via adapter syncSchema`,
            );
          }
          return;
        }

        // Table wasn't created - fall through to direct DDL execution
        this.logger.warn(
          `[SchemaManager] syncSchema returned but table "${tableName}" doesn't exist, falling back to direct DDL`,
        );
      } catch (syncError) {
        // syncSchema failed - fall through to direct DDL execution
        this.logger.warn(
          `[SchemaManager] syncSchema failed for "${tableName}", falling back to direct DDL`,
          { error: syncError },
        );
      }
    }

    // Fallback: Execute DDL directly (for adapters without syncSchema)
    if (this.options.debug) {
      this.logger.debug(
        `[SchemaManager] Creating table "${tableName}" for ${this.engine} (direct DDL)`,
        { createTable: ddl.createTable },
      );
    }

    await this.db.query(ddl.createTable);

    // Execute indexes
    for (const indexSQL of ddl.indexes) {
      if (this.options.debug) {
        this.logger.debug(`[SchemaManager] Creating index`, { indexSQL });
      }
      await this.db.query(indexSQL);
    }

    // Execute triggers (unless skipped)
    if (!this.options.skipTriggers) {
      for (const triggerSQL of ddl.triggers) {
        if (this.options.debug) {
          this.logger.debug(`[SchemaManager] Creating trigger`, { triggerSQL });
        }
        await this.db.query(triggerSQL);
      }
    }

    if (this.options.debug) {
      this.logger.debug(
        `[SchemaManager] Table "${tableName}" created successfully`,
      );
    }
  }

  /**
   * Get existing column names from a database table
   *
   * Uses engine-appropriate introspection:
   * - SQLite/DuckDB: PRAGMA table_info
   * - PostgreSQL: information_schema.columns
   *
   * @param tableName - Name of the table to inspect
   * @returns Set of existing column names (lowercase)
   */
  private async getExistingColumns(tableName: string): Promise<Set<string>> {
    const columns = new Set<string>();

    try {
      if (this.engine === 'postgres') {
        const result = await this.db.query(
          'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
          tableName,
        );
        const rows = extractRows<{ column_name: string }>(result);
        for (const row of rows) {
          columns.add(row.column_name);
        }
      } else {
        // SQLite and DuckDB use PRAGMA
        const result = await this.db.query(
          `PRAGMA table_info(${this.quoteIdentifier(tableName)})`,
        );
        const rows = extractRows<{ name: string }>(result);
        for (const row of rows) {
          columns.add(row.name);
        }
      }
    } catch (error) {
      // If introspection fails, return empty set (no columns will be added)
      if (this.options.debug) {
        this.logger.warn(
          `[SchemaManager] Failed to introspect columns for "${tableName}"`,
          { error },
        );
      }
    }

    return columns;
  }

  /**
   * Add missing columns to an existing table via ALTER TABLE ADD COLUMN
   *
   * Compares the schema's expected columns against the table's actual columns
   * and adds any that are missing. This handles the race condition where a table
   * is created with base fields by one code path, then a later code path needs
   * additional columns from a more complete schema.
   *
   * SQLite limitation: ALTER TABLE ADD COLUMN cannot add NOT NULL columns
   * without a DEFAULT value. We relax NOT NULL for such columns.
   *
   * @param tableName - Name of the existing table
   * @param schema - The full schema definition with expected columns
   */
  private async addMissingColumns(
    tableName: string,
    schema: SchemaDefinition,
  ): Promise<void> {
    if (!schema.columns || Object.keys(schema.columns).length === 0) {
      return;
    }

    const existingColumns = await this.getExistingColumns(tableName);
    if (existingColumns.size === 0) {
      // Introspection failed or returned no columns — skip to avoid errors
      return;
    }

    const strategy = getDDLStrategy(this.engine);
    let addedCount = 0;

    for (const [colName, colDef] of Object.entries(schema.columns)) {
      if (existingColumns.has(colName)) {
        continue; // Column already exists
      }

      // SQLite limitation: ALTER TABLE ADD COLUMN cannot have NOT NULL
      // without a DEFAULT value. Relax NOT NULL for such columns.
      const safeDef = { ...colDef };
      if (
        safeDef.notNull &&
        safeDef.defaultValue === undefined &&
        !safeDef.primaryKey
      ) {
        safeDef.notNull = false;
      }

      // Cannot add PRIMARY KEY columns via ALTER TABLE
      if (safeDef.primaryKey) {
        continue;
      }

      const colSQL = strategy.generateColumnDefinition(colName, safeDef);
      const alterSQL = `ALTER TABLE ${this.quoteIdentifier(tableName)} ADD COLUMN ${colSQL}`;

      try {
        await this.db.query(alterSQL);
        addedCount++;

        if (this.options.debug) {
          this.logger.debug(
            `[SchemaManager] Added column "${colName}" to "${tableName}"`,
          );
        }
      } catch (error) {
        // Column might already exist (race condition) or other issue
        // Log and continue — don't fail the entire operation
        if (this.options.debug) {
          this.logger.warn(
            `[SchemaManager] Failed to add column "${colName}" to "${tableName}"`,
            { error },
          );
        }
      }
    }

    if (addedCount > 0 && this.options.debug) {
      this.logger.debug(
        `[SchemaManager] Added ${addedCount} missing column(s) to "${tableName}"`,
      );
    }
  }

  private quoteIdentifier(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /**
   * Create multiple tables with dependency ordering
   *
   * @param schemas - Array of schema definitions
   */
  async ensureTables(schemas: SchemaDefinition[]): Promise<void> {
    // Sort by dependencies (topological sort)
    const sorted = this.sortByDependencies(schemas);

    for (const schema of sorted) {
      await this.ensureTable(schema);
    }
  }

  /**
   * Generate DDL without executing (useful for debugging/preview)
   *
   * @param schema - The schema definition
   * @returns Engine-specific DDL
   */
  generateDDL(schema: SchemaDefinition): EngineSpecificDDL {
    const strategy = getDDLStrategy(this.engine);
    return {
      createTable: strategy.generateCreateTable(schema),
      indexes: strategy.generateIndexes(schema),
      triggers: strategy.generateTriggers(schema),
    };
  }

  /**
   * Get the detected/configured database engine
   */
  getEngine(): DatabaseEngine {
    return this.engine;
  }

  /**
   * Sort schemas by dependencies (topological sort)
   *
   * Ensures tables are created in the correct order based on foreign key dependencies.
   */
  private sortByDependencies(schemas: SchemaDefinition[]): SchemaDefinition[] {
    const byName = new Map<string, SchemaDefinition>();
    const sorted: SchemaDefinition[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    // Index by table name
    for (const schema of schemas) {
      byName.set(schema.tableName, schema);
    }

    // DFS topological sort
    const visit = (tableName: string) => {
      if (visited.has(tableName)) return;
      if (visiting.has(tableName)) {
        // Circular dependency - continue anyway (FK might be nullable)
        this.logger.warn(
          `[SchemaManager] Circular dependency detected involving ${tableName}`,
        );
        return;
      }

      const schema = byName.get(tableName);
      if (!schema) return; // External dependency, skip

      visiting.add(tableName);

      // Visit dependencies first
      for (const dep of schema.dependencies || []) {
        visit(dep);
      }

      visiting.delete(tableName);
      visited.add(tableName);
      sorted.push(schema);
    };

    // Visit all schemas
    for (const schema of schemas) {
      visit(schema.tableName);
    }

    return sorted;
  }
}

/**
 * Create a SchemaManager instance
 *
 * @param db - Database interface
 * @param options - Optional configuration
 * @returns SchemaManager instance
 */
export function createSchemaManager(
  db: DatabaseInterface,
  options?: SchemaManagerOptions,
): SchemaManager {
  return new SchemaManager(db, options);
}
