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

export class SmrtMCPServer {
  private options: Required<MCPServerOptions>;

  constructor(options: MCPServerOptions = {}) {
    this.options = {
      name: 'smrt-auto-generated',
      version: '1.0.0',
      tools: [],
      handlers: {},
      ...options,
    };
  }

  /**
   * Add a tool to the server
   */
  addTool(tool: MCPTool, handler: (params: any) => Promise<any>): void {
    this.options.tools.push(tool);
    this.options.handlers[tool.name] = handler;
  }

  /**
   * Get all available tools
   */
  getTools(): MCPTool[] {
    return this.options.tools;
  }

  /**
   * Execute a tool
   */
  async executeTool(name: string, params: any): Promise<any> {
    const handler = this.options.handlers[name];
    if (!handler) {
      throw new Error(`Tool '${name}' not found`);
    }

    try {
      return await handler(params);
    } catch (error) {
      throw new Error(
        `Tool execution failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      );
    }
  }

  /**
   * Get server info
   */
  getServerInfo() {
    return {
      name: this.options.name,
      version: this.options.version,
      toolCount: this.options.tools.length,
    };
  }

  /**
   * Start the MCP server (basic implementation)
   */
  async start(): Promise<void> {
    console.log(
      `[smrt-mcp] Server '${this.options.name}' started with ${this.options.tools.length} tools`,
    );
    console.log(
      `[smrt-mcp] Available tools: ${this.options.tools.map((t) => t.name).join(', ')}`,
    );
  }
}

/**
 * Create a new SMRT MCP server instance
 */
export function createMCPServer(options?: MCPServerOptions): SmrtMCPServer {
  return new SmrtMCPServer(options);
}
