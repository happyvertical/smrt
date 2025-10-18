import { Field } from '../fields/index';
import { SmartObjectDefinition } from '../scanner/types';
import { SchemaDefinition } from './types';
export declare class SchemaGenerator {
    /**
     * Generate schema definition from SMRT object definition
     */
    generateSchema(objectDef: SmartObjectDefinition): SchemaDefinition;
    /**
     * Convert field type to SQL data type
     */
    private mapFieldTypeToSQL;
    /**
     * Generate column definitions
     */
    private generateColumns;
    /**
     * Generate index definitions
     */
    private generateIndexes;
    /**
     * Generate trigger definitions for automatic timestamp updates
     */
    private generateTriggers;
    /**
     * Extract foreign key definitions
     */
    private extractForeignKeys;
    /**
     * Extract schema dependencies from foreign keys and inheritance
     */
    private extractDependencies;
    /**
     * Generate version hash for schema
     */
    private generateVersion;
    /**
     * Get table name from object definition
     */
    private getTableName;
    /**
     * Convert class name to table name (camelCase to snake_case, pluralized)
     */
    private classNameToTableName;
    /**
     * Extract package name from file path
     */
    private extractPackageName;
    /**
     * Generate schema definition from ObjectRegistry fields (runtime)
     *
     * This method builds a SchemaDefinition from ObjectRegistry cached fields,
     * enabling schema generation from decorated classes at runtime.
     *
     * @param className - Class name to look up in ObjectRegistry
     * @param tableName - Table name (from SMRT_TABLE_NAME or derived)
     * @param fields - Map of Field definitions from ObjectRegistry
     * @returns Schema definition object
     */
    generateSchemaFromRegistry(_className: string, tableName: string, fields: Map<string, Field>): SchemaDefinition;
    /**
     * Convert camelCase to snake_case
     */
    private toSnakeCase;
    /**
     * Generate SQL CREATE TABLE statement from schema definition
     *
     * This is the single source of truth for SQL generation, consolidating
     * logic that was previously duplicated across multiple code paths.
     *
     * @param schema - Schema definition object
     * @returns SQL CREATE TABLE statement with indexes
     */
    generateSQL(schema: SchemaDefinition): string;
    /**
     * Format default value for SQL with proper CAST for DuckDB compatibility
     *
     * DuckDB requires explicit CAST for default values to prevent type inference issues.
     *
     * @param value - Default value
     * @param type - Column SQL type
     * @returns Formatted SQL default value expression
     */
    private formatDefaultValue;
}
//# sourceMappingURL=generator.d.ts.map