/**
 * OpenAPI documentation generation for smrt APIs
 *
 * Lightweight implementation with optional Swagger UI
 */
export interface OpenAPIConfig {
    title?: string;
    version?: string;
    description?: string;
    basePath?: string;
    serverUrl?: string;
}
/**
 * Generate OpenAPI specification (tree-shakeable)
 */
export declare function generateOpenAPISpec(config?: OpenAPIConfig): any;
/**
 * Setup Swagger UI (optional peer dependency)
 */
export declare function setupSwaggerUI(app: any, spec: any, path?: string): void;
//# sourceMappingURL=swagger.d.ts.map