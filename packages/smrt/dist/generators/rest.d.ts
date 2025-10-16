import { SmrtCollection } from '../collection';
import { SmrtObject } from '../object';
export interface APIConfig {
    basePath?: string;
    enableCors?: boolean;
    customRoutes?: Record<string, (req: Request) => Promise<Response>>;
    authMiddleware?: (objectName: string, action: string) => (req: Request) => Promise<Request | Response>;
    port?: number;
    hostname?: string;
}
export interface APIContext {
    db?: any;
    ai?: any;
    user?: {
        id: string;
        username?: string;
        roles?: string[];
    };
}
/**
 * High-performance API generator using native Bun
 */
export declare class APIGenerator {
    private config;
    private collections;
    private context;
    constructor(config?: APIConfig, context?: APIContext);
    /**
     * Register a pre-configured collection instance for API exposure
     *
     * @param name - URL path segment for the collection (e.g., 'products' for /api/products)
     * @param collection - Pre-initialized SmrtCollection instance
     */
    registerCollection(name: string, collection: SmrtCollection<any>): void;
    /**
     * Create Node.js HTTP server with all routes
     */
    createServer(): {
        server: any;
        url: string;
    };
    /**
     * Convert stream to string
     */
    private streamToString;
    /**
     * Convert Node.js IncomingMessage to Web Request
     */
    private nodeRequestToWebRequest;
    /**
     * Convert Web Response to Node.js ServerResponse
     */
    private webResponseToNodeResponse;
    /**
     * Generate fetch handler function (for serverless environments)
     */
    generateHandler(): (req: Request) => Promise<Response>;
    /**
     * Main request handler using native Bun APIs
     */
    private handleRequest;
    /**
     * Handle CRUD routes for SMRT objects
     */
    private handleObjectRoute;
    /**
     * Execute CRUD operation on a collection
     */
    private executeCrudOperation;
    /**
     * Handle GET /objects/:id
     */
    private handleGet;
    /**
     * Handle GET /objects (list with query params)
     */
    private handleList;
    /**
     * Handle GET /objects/count
     */
    private handleCount;
    /**
     * Handle POST /objects
     */
    private handleCreate;
    /**
     * Handle PUT/PATCH /objects/:id
     */
    private handleUpdate;
    /**
     * Handle DELETE /objects/:id
     */
    private handleDelete;
    /**
     * Get or create collection instance
     */
    private getCollection;
    /**
     * Create JSON response with proper headers
     */
    private createJsonResponse;
    /**
     * Create error response
     */
    private createErrorResponse;
    /**
     * Create CORS preflight response
     */
    private createCorsResponse;
    /**
     * Add CORS headers to response
     */
    private addCorsHeaders;
    /**
     * Simple pluralization (basic implementation)
     */
    private pluralize;
}
export interface RestServerConfig extends APIConfig {
    healthCheck?: {
        enabled?: boolean;
        path?: string;
        customChecks?: (() => Promise<boolean>)[];
    };
}
/**
 * Create REST server with health checks using Bun
 */
export declare function createRestServer(objects: (typeof SmrtObject)[], context?: APIContext, config?: RestServerConfig): {
    server: any;
    url: string;
};
/**
 * Start server with graceful shutdown
 */
export declare function startRestServer(objects: (typeof SmrtObject)[], context?: APIContext, config?: RestServerConfig): Promise<() => Promise<void>>;
//# sourceMappingURL=rest.d.ts.map