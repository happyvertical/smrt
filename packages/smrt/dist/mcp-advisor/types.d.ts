/**
 * Type definitions for SMRT Framework Advisor MCP server
 *
 * These types define the inputs and outputs for all advisor tools
 */
/**
 * Base response type for all tools
 */
export interface ToolResponse {
    success: boolean;
    data?: any;
    error?: string;
    warnings?: string[];
}
/**
 * Input for generate-smrt-class tool
 */
export interface GenerateSmrtClassInput {
    className: string;
    properties: Array<{
        name: string;
        type: 'text' | 'integer' | 'decimal' | 'boolean' | 'datetime' | 'json';
        required?: boolean;
        description?: string;
    }>;
    baseClass?: 'SmrtObject' | 'SmrtCollection';
    includeApiConfig?: boolean;
    includeMcpConfig?: boolean;
    includeCliConfig?: boolean;
}
/**
 * Input for add-ai-methods tool
 */
export interface AddAiMethodsInput {
    className: string;
    methods: Array<'is' | 'do' | 'tool'>;
    filePath?: string;
}
/**
 * Input for generate-field-definitions tool
 */
export interface GenerateFieldDefinitionsInput {
    fields: Array<{
        name: string;
        type: 'text' | 'integer' | 'decimal' | 'boolean' | 'datetime' | 'json' | 'foreignKey';
        options?: Record<string, any>;
    }>;
}
/**
 * Input for generate-collection tool
 */
export interface GenerateCollectionInput {
    collectionName: string;
    itemClassName: string;
    itemClassPath: string;
    includeCustomMethods?: boolean;
}
/**
 * Input for configure-decorators tool
 */
export interface ConfigureDecoratorsInput {
    className: string;
    api?: {
        include?: string[];
        exclude?: string[];
    };
    mcp?: {
        include?: string[];
        exclude?: string[];
    };
    cli?: boolean;
    hooks?: {
        beforeSave?: string;
        afterSave?: string;
        beforeDelete?: string;
        afterDelete?: string;
    };
}
/**
 * Input for validate-smrt-object tool
 */
export interface ValidateSmrtObjectInput {
    filePath: string;
    strictMode?: boolean;
}
/**
 * Validation result
 */
export interface ValidationResult {
    valid: boolean;
    errors: Array<{
        type: 'error' | 'warning';
        message: string;
        line?: number;
        suggestion?: string;
    }>;
    className?: string;
    hasDecorator?: boolean;
    hasRequiredMethods?: boolean;
    fieldCount?: number;
}
/**
 * Input for preview-api-endpoints tool
 */
export interface PreviewApiEndpointsInput {
    className: string;
    basePath?: string;
}
/**
 * API endpoint definition
 */
export interface ApiEndpoint {
    method: 'GET' | 'POST' | 'PUT' | 'DELETE';
    path: string;
    description: string;
    parameters?: Array<{
        name: string;
        type: string;
        required: boolean;
        location: 'path' | 'query' | 'body';
    }>;
}
/**
 * Input for preview-mcp-tools tool
 */
export interface PreviewMcpToolsInput {
    className: string;
}
/**
 * MCP tool definition
 */
export interface McpToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Record<string, any>;
        required?: string[];
    };
}
/**
 * Input for list-registered-objects tool
 */
export interface ListRegisteredObjectsInput {
    filter?: 'all' | 'objects' | 'collections';
}
/**
 * Registered object info
 */
export interface RegisteredObjectInfo {
    name: string;
    type: 'object' | 'collection';
    hasDecorator: boolean;
    fieldCount: number;
    apiEnabled: boolean;
    mcpEnabled: boolean;
    cliEnabled: boolean;
}
/**
 * Input for get-object-schema tool
 */
export interface GetObjectSchemaInput {
    className: string;
    format?: 'json' | 'typescript' | 'table';
}
/**
 * Field definition
 */
export interface FieldDefinition {
    name: string;
    type: string;
    required: boolean;
    default?: any;
    description?: string;
    constraints?: Record<string, any>;
}
/**
 * Input for get-object-config tool
 */
export interface GetObjectConfigInput {
    className: string;
    format?: 'json' | 'yaml';
}
/**
 * Object configuration
 */
export interface ObjectConfig {
    className: string;
    decorator: {
        api?: {
            include?: string[];
            exclude?: string[];
        };
        mcp?: {
            include?: string[];
            exclude?: string[];
        };
        cli?: boolean;
        hooks?: Record<string, string>;
    };
    fields: FieldDefinition[];
    customMethods: string[];
}
//# sourceMappingURL=types.d.ts.map