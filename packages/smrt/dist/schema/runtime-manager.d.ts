import { SchemaDefinition } from './types';
import { DatabaseInterface } from '../../../sql/src';
export interface SchemaInitializationOptions {
    db: DatabaseInterface;
    schemas: Record<string, SchemaDefinition>;
    override?: Record<string, SchemaDefinition>;
    force?: boolean;
    debug?: boolean;
}
export interface SchemaInitializationResult {
    initialized: string[];
    skipped: string[];
    errors: Array<{
        schema: string;
        error: string;
    }>;
    executionTime: number;
}
export declare class RuntimeSchemaManager {
    private static instance;
    private static initializationLock;
    private initializedSchemas;
    private schemaVersions;
    /**
     * Get singleton instance
     */
    static getInstance(): RuntimeSchemaManager;
    /**
     * Initialize schemas with dependency resolution
     */
    initializeSchemas(options: SchemaInitializationOptions): Promise<SchemaInitializationResult>;
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
//# sourceMappingURL=runtime-manager.d.ts.map