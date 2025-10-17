import { FieldDefinition, GetObjectSchemaInput } from '../types.js';
/**
 * Get object schema with field definitions
 */
export declare function getObjectSchema(input: GetObjectSchemaInput): Promise<{
    className: string;
    fields: FieldDefinition[];
    format: string;
}>;
//# sourceMappingURL=get-object-schema.d.ts.map