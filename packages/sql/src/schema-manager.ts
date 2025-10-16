/**
 * Schema management and dependency resolution for JSON manifests
 * Moved from SMRT package to SQL package for proper separation of concerns
 */

import type {
  DatabaseInterface,
  SchemaDefinition,
  SchemaManifest,
  SchemaInitializationOptions,
  ColumnDefinition,
  IndexDefinition,
  TriggerDefinition,
  ForeignKeyDefinition,
} from './shared/types.js';

export interface SchemaInitializationResult {
  initialized: string[];
  skipped: string[];
  errors: Array<{ schema: string; error: string }>;
  executionTime: number;
}

export class DatabaseSchemaManager {
  private static initializationLock = new Map<string, Promise<void>>();
  private initializedSchemas = new Set<string>();
  private schemaVersions = new Map<string, string>();

  /**
   * Initialize schemas with dependency resolution
   */
  async initializeSchemas(
    db: DatabaseInterface,
    options: SchemaInitializationOptions,
  ): Promise<SchemaInitializationResult> {
    const startTime = Date.now();
    const result: SchemaInitializationResult = {
      initialized: [],
      skipped: [],
      errors: [],
      executionTime: 0,
    };

    try {
      let schemas: Record<string, SchemaDefinition> = {};

      // Handle legacy SQL schema format
      if (options.schema) {
        console.log(
          '[schema] Legacy SQL schema provided, converting to manifest format',
        );
        // For legacy support, we'll still use the original syncSchema method
        if (db.syncSchema) {
          await db.syncSchema(options.schema);
          result.initialized.push('legacy-sql');
        }
        result.executionTime = Date.now() - startTime;
        return result;
      }

      // Handle JSON manifest format
      if (options.manifest) {
        schemas = { ...options.manifest.schemas };
      }

      // Apply schema overrides
      if (options.overrides) {
        schemas = { ...schemas, ...options.overrides };
      }

      if (Object.keys(schemas).length === 0) {
        console.warn('[schema] No schemas provided for initialization');
        result.executionTime = Date.now() - startTime;
        return result;
      }

      // Build dependency graph
      const dependencyGraph = this.buildDependencyGraph(schemas);

      // Get initialization order
      const initializationOrder = this.resolveDependencies(dependencyGraph);

      if (options.debug) {
        console.log('[schema] Initialization order:', initializationOrder);
      }

      // Initialize schemas in dependency order
      for (const schemaName of initializationOrder) {
        const schema = schemas[schemaName];
        if (!schema) continue;

        try {
          await this.initializeSchema(db, schemaName, schema, {
            force: options.force,
            debug: options.debug,
          });
          result.initialized.push(schemaName);
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : String(error);
          result.errors.push({ schema: schemaName, error: errorMessage });

          if (options.debug) {
            console.error(
              `[schema] Failed to initialize ${schemaName}:`,
              error,
            );
          }
        }
      }

      result.executionTime = Date.now() - startTime;

      if (options.debug) {
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
    if (DatabaseSchemaManager.initializationLock.has(lockKey)) {
      await DatabaseSchemaManager.initializationLock.get(lockKey);
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
    DatabaseSchemaManager.initializationLock.set(lockKey, initPromise);

    try {
      await initPromise;
      this.markSchemaInitialized(schemaName, version);
    } finally {
      DatabaseSchemaManager.initializationLock.delete(lockKey);
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
    const { tableName, columns, indexes, triggers } = schema;

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

      // Create triggers
      for (const trigger of triggers) {
        await this.createTrigger(db, trigger);
      }
    } else if (options.force) {
      // Recreate table if forced
      await db.query(`DROP TABLE IF EXISTS ${tableName}`);
      await this.createTable(db, schema);

      for (const index of indexes) {
        await this.createIndex(db, tableName, index);
      }

      for (const trigger of triggers) {
        await this.createTrigger(db, trigger);
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
        def += ` DEFAULT ${columnDef.defaultValue}`;
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
    index: IndexDefinition,
  ): Promise<void> {
    const uniqueClause = index.unique ? 'UNIQUE ' : '';
    const whereClause = index.where ? ` WHERE ${index.where}` : '';
    const createIndexSQL = `CREATE ${uniqueClause}INDEX ${index.name} ON ${tableName} (${index.columns.join(', ')})${whereClause}`;

    await db.query(createIndexSQL);
  }

  /**
   * Create trigger from definition
   */
  private async createTrigger(
    db: DatabaseInterface,
    trigger: TriggerDefinition,
  ): Promise<void> {
    const conditionClause = trigger.condition
      ? ` WHEN ${trigger.condition}`
      : '';
    const createTriggerSQL = `CREATE TRIGGER ${trigger.name} ${trigger.when} ${trigger.event} ON ${trigger.table}${conditionClause} BEGIN ${trigger.body} END`;

    await db.query(createTriggerSQL);
  }

  /**
   * Update schema if changes are detected
   */
  private async updateSchemaIfNeeded(
    db: DatabaseInterface,
    schema: SchemaDefinition,
  ): Promise<void> {
    // For now, just log that update is needed
    // In future, implement ALTER TABLE logic
    console.log(
      `[schema] Schema update logic not yet implemented for ${schema.tableName}`,
    );
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
    DatabaseSchemaManager.initializationLock.clear();
  }
}
