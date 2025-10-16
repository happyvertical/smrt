/**
 * Type definitions for AST scanning and manifest generation
 */
export interface FieldDefinition {
    type: 'text' | 'decimal' | 'boolean' | 'integer' | 'datetime' | 'json' | 'foreignKey';
    required?: boolean;
    default?: any;
    min?: number;
    max?: number;
    maxLength?: number;
    minLength?: number;
    related?: string;
    description?: string;
    options?: Record<string, any>;
}
export interface MethodDefinition {
    name: string;
    async: boolean;
    parameters: Array<{
        name: string;
        type: string;
        optional: boolean;
        default?: any;
    }>;
    returnType: string;
    description?: string;
    isStatic: boolean;
    isPublic: boolean;
}
export interface SmartObjectDefinition {
    name: string;
    className: string;
    collection: string;
    filePath: string;
    fields: Record<string, FieldDefinition>;
    methods: Record<string, MethodDefinition>;
    decoratorConfig: {
        api?: {
            include?: string[];
            exclude?: string[];
        } | boolean;
        mcp?: {
            include?: string[];
            exclude?: string[];
        } | boolean;
        cli?: boolean | {
            include?: string[];
            exclude?: string[];
        };
        ai?: {
            callable?: string[] | 'public-async' | 'all';
            exclude?: string[];
            descriptions?: Record<string, string>;
        };
    };
    extends?: string;
    tools?: Array<{
        type: 'function';
        function: {
            name: string;
            description?: string;
            parameters?: Record<string, any>;
        };
    }>;
}
export interface SmartObjectManifest {
    version: string;
    timestamp: number;
    packageName?: string;
    objects: Record<string, SmartObjectDefinition>;
}
export interface ScanResult {
    filePath: string;
    objects: SmartObjectDefinition[];
    errors: Array<{
        message: string;
        line?: number;
        column?: number;
    }>;
}
export interface ScanOptions {
    includePrivateMethods?: boolean;
    includeStaticMethods?: boolean;
    followImports?: boolean;
    baseClasses?: string[];
}
//# sourceMappingURL=types.d.ts.map