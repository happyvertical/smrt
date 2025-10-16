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
}
//# sourceMappingURL=generator.d.ts.map