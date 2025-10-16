import { DatabaseInterface, SchemaInitializationOptions } from './shared/types.js';
export interface SchemaInitializationResult {
    initialized: string[];
    skipped: string[];
    errors: Array<{
        schema: string;
        error: string;
    }>;
    executionTime: number;
}
export declare class DatabaseSchemaManager {
    private static initializationLock;
    private initializedSchemas;
    private schemaVersions;
    /**
     * Initialize schemas with dependency resolution
     */
    initializeSchemas(db: DatabaseInterface, options: SchemaInitializationOptions): Promise<SchemaInitializationResult>;
    /**
     * Initialize a single schema
     */
    private initializeSchema;
    /**
     * Perform the actual schema initialization
     */
    private performSchemaInitialization;
    /**
     * Create table from schema definition
     */
    private createTable;
    /**
     * Create index from definition
     */
    private createIndex;
    /**
     * Create trigger from definition
     */
    private createTrigger;
    /**
     * Update schema if changes are detected
     */
    private updateSchemaIfNeeded;
    /**
     * Build dependency graph from schemas
     */
    private buildDependencyGraph;
    /**
     * Resolve dependencies using topological sort
     */
    private resolveDependencies;
    /**
     * Check if schema is up to date
     */
    private isSchemaUpToDate;
    /**
     * Mark schema as initialized
     */
    private markSchemaInitialized;
    /**
     * Reset initialization state (for testing)
     */
    reset(): void;
}
//# sourceMappingURL=schema-manager.d.ts.map