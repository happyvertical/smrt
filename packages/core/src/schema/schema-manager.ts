/**
 * Schema Manager - Direct DDL Execution for SMRT
 *
 * SMRT handles ALL database maintenance directly.
 * SDK SQL remains a pure query/CRUD layer.
 *
 * This module replaces the use of SDK's syncSchema() with direct DDL execution
 * using engine-specific DDL strategies.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import {
  type DatabaseEngine,
  detectEngine,
  type EngineSpecificDDL,
  getDDLStrategy,
} from './ddl';
import type { SchemaDefinition } from './types';

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

  constructor(db: DatabaseInterface, options: SchemaManagerOptions = {}) {
    this.db = db;
    this.options = options;

    // Detect or use provided engine
    this.engine = options.engine || detectEngine(db.url);
  }

  /**
   * Ensure a table exists with the correct schema
   *
   * If table doesn't exist, creates it with DDL from the engine-specific strategy.
   * If table exists, no action is taken (future: schema migration).
   *
   * @param schema - The schema definition
   */
  async ensureTable(schema: SchemaDefinition): Promise<void> {
    const { tableName } = schema;

    // Check if table already exists
    const exists = await this.db.tableExists(tableName);
    if (exists) {
      // TODO: Future - schema migration/evolution
      if (this.options.debug) {
        console.log(
          `[SchemaManager] Table "${tableName}" already exists, skipping`,
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
    if ((this.db as any).syncSchema) {
      // Combine DDL into single schema string for adapter's syncSchema
      const fullSchema = [
        ddl.createTable,
        ...ddl.indexes,
        ...(this.options.skipTriggers ? [] : ddl.triggers),
      ].join(';\n');

      if (this.options.debug) {
        console.log(
          `[SchemaManager] Using adapter syncSchema for "${tableName}":`,
        );
        console.log(fullSchema);
      }

      await (this.db as any).syncSchema(fullSchema);

      if (this.options.debug) {
        console.log(
          `[SchemaManager] Table "${tableName}" created via adapter syncSchema`,
        );
      }
      return;
    }

    // Fallback: Execute DDL directly (for adapters without syncSchema)
    if (this.options.debug) {
      console.log(
        `[SchemaManager] Creating table "${tableName}" for ${this.engine} (direct DDL):`,
      );
      console.log(ddl.createTable);
    }

    await this.db.query(ddl.createTable);

    // Execute indexes
    for (const indexSQL of ddl.indexes) {
      if (this.options.debug) {
        console.log(`[SchemaManager] Creating index:`, indexSQL);
      }
      await this.db.query(indexSQL);
    }

    // Execute triggers (unless skipped)
    if (!this.options.skipTriggers) {
      for (const triggerSQL of ddl.triggers) {
        if (this.options.debug) {
          console.log(`[SchemaManager] Creating trigger:`, triggerSQL);
        }
        await this.db.query(triggerSQL);
      }
    }

    if (this.options.debug) {
      console.log(`[SchemaManager] Table "${tableName}" created successfully`);
    }
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
        console.warn(
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
