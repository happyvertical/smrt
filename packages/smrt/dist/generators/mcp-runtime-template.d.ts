import { MCPConfig, MCPContext } from './mcp.js';
export interface RuntimeOptions {
    /** Server name (defaults to package name) */
    name?: string;
    /** Server version (defaults to package version) */
    version?: string;
    /** Server description */
    description?: string;
    /** MCP generator configuration */
    config?: MCPConfig;
    /** MCP context (database, AI client, etc.) */
    context?: MCPContext;
    /** Enable debug logging */
    debug?: boolean;
}
/**
 * Generate runtime bootstrap code for MCP server
 *
 * @param options - Runtime configuration options
 * @returns TypeScript code for server entry point
 */
export declare function generateRuntimeBootstrap(options?: RuntimeOptions): string;
/**
 * Generate package.json script for running MCP server
 *
 * @param serverPath - Path to generated server file (relative to package root)
 * @returns Script command for package.json
 */
export declare function generateMCPScript(serverPath?: string): string;
/**
 * Generate Claude Desktop configuration example
 *
 * @param serverName - Name for the MCP server
 * @param serverPath - Absolute path to server file
 * @returns Configuration object for claude_desktop_config.json
 */
export declare function generateClaudeConfig(serverName: string, serverPath: string): object;
/**
 * Generate README documentation for MCP server setup
 *
 * @param serverName - Name of the MCP server
 * @param serverPath - Path to the server file
 * @returns Markdown documentation
 */
export declare function generateMCPDocumentation(serverName: string, serverPath: string): string;
//# sourceMappingURL=mcp-runtime-template.d.ts.map