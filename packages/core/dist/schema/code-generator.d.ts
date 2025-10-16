import { SchemaDefinition } from './types';
import { SmartObjectDefinition } from '../scanner/types';
export declare class SchemaCodeGenerator {
    /**
     * Generate getSchema() method source code
     */
    generateSchemaMethod(objectDef: SmartObjectDefinition, schema: SchemaDefinition): string;
    /**
     * Generate complete schema file with all methods
     */
    generateSchemaFile(schemas: Record<string, SchemaDefinition>): string;
    /**
     * Generate import statements
     */
    private generateImports;
    /**
     * Generate getSchema method for a specific class
     */
    private generateClassMethod;
    /**
     * Generate standalone getSchema method
     */
    private generateMethod;
    /**
     * Generate schema object definition
     */
    private generateSchemaObject;
    /**
     * Generate columns object
     */
    private generateColumns;
    /**
     * Generate indexes array
     */
    private generateIndexes;
    /**
     * Generate triggers array
     */
    private generateTriggers;
    /**
     * Generate foreign keys array
     */
    private generateForeignKeys;
    /**
     * Generate TypeScript type definition file
     */
    generateTypeDefinitions(schemas: Record<string, SchemaDefinition>): string;
    /**
     * Generate schema manifest file
     */
    generateManifest(packageName: string, schemas: Record<string, SchemaDefinition>): string;
}
//# sourceMappingURL=code-generator.d.ts.map