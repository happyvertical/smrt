import { SmrtRequest, SmrtServerOptions } from './types';
export declare class SmrtServer {
    private options;
    private routes;
    constructor(options?: SmrtServerOptions);
    /**
     * Add a route handler
     */
    addRoute(method: string, path: string, handler: (req: SmrtRequest) => Promise<Response>): void;
    /**
     * Add GET route handler (RouteApp compatibility)
     */
    get(path: string, handler: (req: any, res: any) => void): void;
    /**
     * Add POST route handler (RouteApp compatibility)
     */
    post(path: string, handler: (req: any, res: any) => void): void;
    /**
     * Add PUT route handler (RouteApp compatibility)
     */
    put(path: string, handler: (req: any, res: any) => void): void;
    /**
     * Add DELETE route handler (RouteApp compatibility)
     */
    delete(path: string, handler: (req: any, res: any) => void): void;
    /**
     * Convert Express-style handler to SMRT handler
     */
    private addExpressStyleRoute;
    /**
     * Start the server
     */
    start(): Promise<{
        server: any;
        url: string;
    }>;
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
     * Handle incoming requests
     */
    private handleRequest;
    /**
     * Parse incoming request into SmrtRequest format
     */
    private parseRequest;
    /**
     * Find route handler with parameter extraction
     */
    private findRouteHandler;
    /**
     * Match route path with parameters (e.g., /users/:id)
     */
    private matchRoute;
    /**
     * Handle authentication
     */
    private authenticate;
    /**
     * Create CORS preflight response
     */
    private createCorsResponse;
    /**
     * Add CORS headers to response
     */
    private addCorsHeaders;
    /**
     * Get CORS headers
     */
    private getCorsHeaders;
}
/**
 * Create a new SMRT server instance
 */
export declare function createSmrtServer(options?: SmrtServerOptions): SmrtServer;
//# sourceMappingURL=server.d.ts.map