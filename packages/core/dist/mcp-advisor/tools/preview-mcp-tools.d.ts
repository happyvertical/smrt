import { PreviewMcpToolsInput, McpToolDefinition } from '../types.js';
/**
 * Preview MCP tools that would be generated for a class
 */
export declare function previewMcpTools(input: PreviewMcpToolsInput): Promise<{
    tools: McpToolDefinition[];
    className: string;
}>;
//# sourceMappingURL=preview-mcp-tools.d.ts.map