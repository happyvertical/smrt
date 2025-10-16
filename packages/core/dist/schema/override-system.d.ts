import { SchemaDefinition, SchemaOverride, ColumnDefinition } from './types';
export declare class SchemaOverrideSystem {
    /**
     * Apply schema override to base schema
     */
    static applyOverride(baseSchema: SchemaDefinition, override: SchemaOverride): SchemaDefinition;
    /**
     * Create a schema override for extending a base schema
     */
    static createOverride(tableName: string, packageName: string, extensions: {
        addColumns?: Record<string, ColumnDefinition>;
        removeColumns?: string[];
        addIndexes?: Array<any>;
        removeIndexes?: string[];
        addTriggers?: Array<any>;
        removeTriggers?: string[];
    }): SchemaOverride;
    /**
     * Merge multiple schema overrides
     */
    static mergeOverrides(baseSchema: SchemaDefinition, overrides: SchemaOverride[]): SchemaDefinition;
    /**
     * Create praeco-specific content schema override
     */
    static createPraecoContentOverride(): SchemaOverride;
    /**
     * Create praeco-specific meeting schema override
     */
    static createPraecoMeetingOverride(): SchemaOverride;
    /**
     * Generate version for overridden schema
     */
    private static generateOverrideVersion;
    /**
     * Extract foreign keys from columns
     */
    private static extractForeignKeys;
    /**
     * Extract dependencies from schema
     */
    private static extractDependencies;
}
//# sourceMappingURL=override-system.d.ts.map