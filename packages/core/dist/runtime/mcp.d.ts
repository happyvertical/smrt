/**
 * Runtime MCP server implementation for SMRT auto-generated services
 */
export interface MCPTool {
    name: string;
    description: string;
    inputSchema: any;
}
export interface MCPServerOptions {
    name?: string;
    version?: string;
    tools?: MCPTool[];
    handlers?: Record<string, (params: any) => Promise<any>>;
}
export declare class SmrtMCPServer {
    private options;
    constructor(options?: MCPServerOptions);
    /**
     * Add a tool to the server
     */
    addTool(tool: MCPTool, handler: (params: any) => Promise<any>): void;
    /**
     * Get all available tools
     */
    getTools(): MCPTool[];
    /**
     * Execute a tool
     */
    executeTool(name: string, params: any): Promise<any>;
    /**
     * Get server info
     */
    getServerInfo(): {
        name: string;
        version: string;
        toolCount: number;
    };
    /**
     * Start the MCP server (basic implementation)
     */
    start(): Promise<void>;
}
/**
 * Create a new SMRT MCP server instance
 */
export declare function createMCPServer(options?: MCPServerOptions): SmrtMCPServer;
//# sourceMappingURL=mcp.d.ts.map