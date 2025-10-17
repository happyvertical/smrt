/**
 * Runtime schema management and dependency resolution
 * Coordinates schema initialization across multiple SMRT objects
 */

import type { DatabaseInterface } from '@have/sql';
import { createHash } from 'crypto';
import type { SchemaDefinition } from './types';

export interface SchemaInitializationOptions {
  db: DatabaseInterface;
  schemas: Record<string, SchemaDefinition>;
  override?: Record<string, SchemaDefinition>; // Schema overrides
  force?: boolean; // Force recreation of tables
  debug?: boolean; // Enable debug logging
}

export interface SchemaInitializationResult {
  initialized: string[];
  skipped: string[];
  errors: Array<{ schema: string; error: string }>;
  executionTime: number;
}

export class RuntimeSchemaManager {
  private static instance: RuntimeSchemaManager | null = null;
  private static initializationLock = new Map<string, Promise<void>>();
  private initializedSchemas = new Set<string>();
  private schemaVersions = new Map<string, string>();

  /**
   * Get singleton instance
   */
  static getInstance(): RuntimeSchemaManager {
    if (!RuntimeSchemaManager.instance) {
      RuntimeSchemaManager.instance = new RuntimeSchemaManager();
    }
    return RuntimeSchemaManager.instance;
  }

  /**
   * Initialize schemas with dependency resolution
   */
  async initializeSchemas(
    options: SchemaInitializationOptions,
  ): Promise<SchemaInitializationResult> {
    const {
      db,
      schemas,
      override = {},
      force = false,
      debug = false,
    } = options;
    const startTime = Date.now();
    const result: SchemaInitializationResult = {
      initialized: [],
      skipped: [],
      errors: [],
      executionTime: 0,
    };

    try {
      // Merge base schemas with overrides
      const finalSchemas = { ...schemas, ...override };

      // Build dependency graph
      const dependencyGraph = this.buildDependencyGraph(finalSchemas);

      // Get initialization order
      const initializationOrder = this.resolveDependencies(dependencyGraph);

      if (debug) {
        console.log('[schema] Initialization order:', initializationOrder);
      }

      // Initialize schemas in dependency order
      for (const schemaName of initializationOrder) {
        const schema = finalSchemas[schemaName];
        if (!schema) continue;

        try {
          await this.initializeSchema(db, schemaName, schema, { force, debug });
          result.initialized.push(schemaName);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result.errors.push({ schema: schemaName, error: errorMessage });

          if (debug) {
            console.error(
              `[schema] Failed to initialize ${schemaName}:`,
              error,
            );
          }
        }
      }

      result.executionTime = Date.now() - startTime;

      if (debug) {
        console.log('[schema] Initialization complete:', result);
      }

      return result;
    } catch (error) {
      result.executionTime = Date.now() - startTime;
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      result.errors.push({
        schema: 'dependency-resolution',
        error: errorMessage,
      });
      return result;
    }
  }

  /**
   * Initialize a single schema
   */
  private async initializeSchema(
    db: DatabaseInterface,
    schemaName: string,
    schema: SchemaDefinition,
    options: { force?: boolean; debug?: boolean },
  ): Promise<void> {
    const { tableName, version } = schema;
    const lockKey = `${schemaName}:${tableName}`;

    // Check if already being initialized
    if (RuntimeSchemaManager.initializationLock.has(lockKey)) {
      await RuntimeSchemaManager.initializationLock.get(lockKey);
      return;
    }

    // Check if already initialized and up to date
    if (!options.force && this.isSchemaUpToDate(schemaName, version)) {
      if (options.debug) {
        console.log(`[schema] Skipping ${schemaName} - already up to date`);
      }
      return;
    }

    // Create initialization promise
    const initPromise = this.performSchemaInitialization(
      db,
      schemaName,
      schema,
      options,
    );
    RuntimeSchemaManager.initializationLock.set(lockKey, initPromise);

    try {
      await initPromise;
      this.markSchemaInitialized(schemaName, version);
    } finally {
      RuntimeSchemaManager.initializationLock.delete(lockKey);
    }
  }

  /**
   * Perform the actual schema initialization
   */
  private async performSchemaInitialization(
    db: DatabaseInterface,
    schemaName: string,
    schema: SchemaDefinition,
    options: { force?: boolean; debug?: boolean },
  ): Promise<void> {
    const { tableName, columns, indexes } = schema;

    if (options.debug) {
      console.log(`[schema] Initializing ${schemaName} (${tableName})`);
    }

    // Check if table exists
    const tableExists = await db.tableExists(tableName);

    if (!tableExists) {
      // Create table
      await this.createTable(db, schema);

      // Create indexes
      for (const index of indexes) {
        await this.createIndex(db, tableName, index);
      }
    } else if (options.force) {
      // Recreate table if forced
      await db.query(`DROP TABLE IF EXISTS ${tableName}`);
      await this.createTable(db, schema);

      for (const index of indexes) {
        await this.createIndex(db, tableName, index);
      }
    } else {
      // Table exists, check for schema changes
      await this.updateSchemaIfNeeded(db, schema);
    }
  }

  /**
   * Create table from schema definition
   */
  private async createTable(
    db: DatabaseInterface,
    schema: SchemaDefinition,
  ): Promise<void> {
    const { tableName, columns, foreignKeys } = schema;

    const columnDefinitions: string[] = [];

    // Add column definitions
    for (const [columnName, columnDef] of Object.entries(columns)) {
      let def = `${columnName} ${columnDef.type}`;

      if (columnDef.primaryKey) def += ' PRIMARY KEY';
      if (columnDef.unique && !columnDef.primaryKey) def += ' UNIQUE';
      if (columnDef.notNull) def += ' NOT NULL';
      if (columnDef.defaultValue !== undefined) {
        // Add explicit CAST for TEXT columns with empty string or NULL defaults
        // DuckDB infers ANY type without explicit casting, causing UPSERT failures
        const isTextColumn = columnDef.type === 'TEXT';
        const isEmptyOrNull =
          columnDef.defaultValue === "''" || columnDef.defaultValue === 'NULL';

        if (isTextColumn && isEmptyOrNull) {
          def += ` DEFAULT CAST(${columnDef.defaultValue} AS TEXT)`;
        } else {
          def += ` DEFAULT ${columnDef.defaultValue}`;
        }
      }
      if (columnDef.check) def += ` CHECK (${columnDef.check})`;

      columnDefinitions.push(def);
    }

    // Add foreign key constraints
    for (const fk of foreignKeys) {
      let fkDef = `FOREIGN KEY (${fk.column}) REFERENCES ${fk.referencesTable}(${fk.referencesColumn})`;
      if (fk.onDelete) fkDef += ` ON DELETE ${fk.onDelete}`;
      if (fk.onUpdate) fkDef += ` ON UPDATE ${fk.onUpdate}`;
      columnDefinitions.push(fkDef);
    }

    const createTableSQL = `CREATE TABLE ${tableName} (\n  ${columnDefinitions.join(',\n  ')}\n)`;
    await db.query(createTableSQL);
  }

  /**
   * Create index from definition
   */
  private async createIndex(
    db: DatabaseInterface,
    tableName: string,
    index: any,
  ): Promise<void> {
    const uniqueClause = index.unique ? 'UNIQUE ' : '';
    const whereClause = index.where ? ` WHERE ${index.where}` : '';
    const createIndexSQL = `CREATE ${uniqueClause}INDEX ${index.name} ON ${tableName} (${index.columns.join(', ')})${whereClause}`;

    await db.query(createIndexSQL);
  }

  /**
   * Update schema if changes are detected (Phase 4: Automatic Schema Evolution)
   *
   * Automatically adds new columns and indexes using the ALTER TABLE API.
   * Safe operations only - no column drops, renames, or type changes.
   */
  private async updateSchemaIfNeeded(
    db: DatabaseInterface,
    schema: SchemaDefinition,
  ): Promise<void> {
    const { tableName, columns, indexes } = schema;

    // Graceful fallback for adapters without alterTable support
    if (!db.alterTable || !db.getTableSchema) {
      console.log(
        `[schema] ALTER TABLE not supported for ${tableName}, skipping schema evolution`,
      );
      return;
    }

    try {
      // Get current table schema
      const currentSchema = await db.getTableSchema(tableName);
      if (!currentSchema) {
        console.warn(`[schema] Could not retrieve schema for ${tableName}`);
        return;
      }

      // Track changes for logging
      const addedColumns: string[] = [];
      const addedIndexes: string[] = [];

      // Auto-add new columns (safe operation with default values)
      for (const [columnName, columnDef] of Object.entries(columns)) {
        if (!currentSchema.columns[columnName]) {
          await db.alterTable.addColumn(tableName, {
            name: columnName,
            ...columnDef,
          });
          addedColumns.push(columnName);
        }
      }

      // Auto-add new indexes (safe operation)
      for (const index of indexes) {
        const indexExists = currentSchema.indexes.find(
          (i) => i.name === index.name,
        );
        if (!indexExists) {
          await db.alterTable.addIndex(tableName, index);
          addedIndexes.push(index.name);
        }
      }

      // Log changes if any were made
      if (addedColumns.length > 0 || addedIndexes.length > 0) {
        console.log(
          `[schema] Evolved ${tableName}:`,
          addedColumns.length > 0
            ? `added columns [${addedColumns.join(', ')}]`
            : '',
          addedIndexes.length > 0
            ? `added indexes [${addedIndexes.join(', ')}]`
            : '',
        );
      }
    } catch (error) {
      console.error(
        `[schema] Failed to evolve schema for ${tableName}:`,
        error instanceof Error ? error.message : String(error),
      );
      // Don't throw - schema evolution is non-critical
    }
  }

  /**
   * Build dependency graph from schemas
   */
  private buildDependencyGraph(
    schemas: Record<string, SchemaDefinition>,
  ): Map<string, string[]> {
    const graph = new Map<string, string[]>();

    for (const [schemaName, schema] of Object.entries(schemas)) {
      const dependencies = schema.dependencies.filter((dep) =>
        Object.values(schemas).some((s) => s.tableName === dep),
      );
      graph.set(
        schemaName,
        dependencies.map(
          (dep) =>
            Object.entries(schemas).find(
              ([_, s]) => s.tableName === dep,
            )?.[0] || dep,
        ),
      );
    }

    return graph;
  }

  /**
   * Resolve dependencies using topological sort
   */
  private resolveDependencies(graph: Map<string, string[]>): string[] {
    const resolved: string[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (node: string) => {
      if (visiting.has(node)) {
        throw new Error(`Circular dependency detected involving ${node}`);
      }
      if (visited.has(node)) return;

      visiting.add(node);
      const dependencies = graph.get(node) || [];

      for (const dep of dependencies) {
        if (graph.has(dep)) {
          visit(dep);
        }
      }

      visiting.delete(node);
      visited.add(node);
      resolved.push(node);
    };

    for (const node of graph.keys()) {
      if (!visited.has(node)) {
        visit(node);
      }
    }

    return resolved;
  }

  /**
   * Check if schema is up to date
   */
  private isSchemaUpToDate(schemaName: string, version: string): boolean {
    return (
      this.initializedSchemas.has(schemaName) &&
      this.schemaVersions.get(schemaName) === version
    );
  }

  /**
   * Mark schema as initialized
   */
  private markSchemaInitialized(schemaName: string, version: string): void {
    this.initializedSchemas.add(schemaName);
    this.schemaVersions.set(schemaName, version);
  }

  /**
   * Reset initialization state (for testing)
   */
  reset(): void {
    this.initializedSchemas.clear();
    this.schemaVersions.clear();
    RuntimeSchemaManager.initializationLock.clear();
  }
}
