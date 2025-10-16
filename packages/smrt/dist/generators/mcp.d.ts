/**
 * MCP (Model Context Protocol) server generator for smrt objects
 *
 * Exposes smrt objects as AI tools for Claude, GPT, and other AI models
 */
export interface MCPConfig {
    name?: string;
    version?: string;
    description?: string;
    server?: {
        name: string;
        version: string;
    };
}
export interface MCPContext {
    db?: any;
    ai?: any;
    user?: {
        id: string;
        roles?: string[];
    };
}
export interface MCPTool {
    name: string;
    description: string;
    inputSchema: {
        type: string;
        properties: Record<string, any>;
        required?: string[];
    };
}
export interface MCPRequest {
    method: string;
    params: {
        name: string;
        arguments: Record<string, any>;
    };
}
export interface MCPResponse {
    content: Array<{
        type: 'text';
        text: string;
    }>;
}
/**
 * Generate MCP server from smrt objects
 */
export declare class MCPGenerator {
    private config;
    private context;
    private collections;
    constructor(config?: MCPConfig, context?: MCPContext);
    /**
     * Generate all available tools from registered objects
     */
    generateTools(): MCPTool[];
    /**
     * Generate tools for a specific object
     */
    private generateObjectTools;
    /**
     * Convert field definition to MCP schema
     */
    private fieldToMCPSchema;
    /**
     * Validate that a custom method exists on a class
     */
    private validateCustomMethod;
    /**
     * Handle MCP tool calls
     */
    handleToolCall(request: MCPRequest): Promise<MCPResponse>;
    /**
     * Get or create collection for an object
     */
    private getCollection;
    /**
     * Execute action on collection
     */
    private executeAction;
    /**
     * Execute a custom action on a collection/object
     */
    private executeCustomAction;
    /**
     * Generate MCP server info
     */
    getServerInfo(): {
        name: string | undefined;
        version: string | undefined;
        description: string | undefined;
    };
    /**
     * Generate complete MCP server with stdio transport
     *
     * Creates a runnable Node.js script that exposes SMRT objects as MCP tools.
     * The generated server includes:
     * - Stdio transport integration
     * - Tool registration from ObjectRegistry
     * - Error handling and logging
     * - Graceful shutdown
     *
     * @param options - Server generation options
     * @returns Promise that resolves when all files are written
     *
     * @example
     * ```typescript
     * const generator = new MCPGenerator({
     *   name: 'my-app',
     *   version: '1.0.0'
     * });
     *
     * await generator.generateServer({
     *   outputPath: 'dist/mcp-server.js',
     *   serverName: 'my-app-mcp',
     *   debug: true
     * });
     * ```
     */
    generateServer(options?: {
        /** Path to output server file (relative or absolute) */
        outputPath?: string;
        /** Server name for configuration */
        serverName?: string;
        /** Server version */
        serverVersion?: string;
        /** Enable debug logging */
        debug?: boolean;
        /** Generate Claude Desktop configuration example */
        generateClaudeConfigFile?: boolean;
        /** Generate README documentation */
        generateReadme?: boolean;
    }): Promise<void>;
}
//# sourceMappingURL=mcp.d.ts.map