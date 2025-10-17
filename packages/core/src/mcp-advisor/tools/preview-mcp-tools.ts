/**
 * Preview auto-generated MCP tools for a SMRT class
 */

import { MCPGenerator } from '../../generators/mcp.js';
import { ObjectRegistry } from '../../registry.js';
import type { McpToolDefinition, PreviewMcpToolsInput } from '../types.js';

/**
 * Preview MCP tools that would be generated for a class
 */
export async function previewMcpTools(
  input: PreviewMcpToolsInput,
): Promise<{ tools: McpToolDefinition[]; className: string }> {
  try {
    const { className } = input;

    // Check if class is registered
    const classInfo = ObjectRegistry.getClass(className);
    if (!classInfo) {
      throw new Error(`Class '${className}' not found in ObjectRegistry`);
    }

    // Create MCPGenerator instance
    const generator = new MCPGenerator();

    // Get config for this specific class
    const config = ObjectRegistry.getConfig(className);
    const _mcpConfig = config.mcp || {};

    // Generate tools for all registered objects
    const allTools = generator.generateTools();

    // Filter to only this class's tools
    const lowerName = className.toLowerCase();
    const classTools = allTools.filter((tool) =>
      tool.name.startsWith(`${lowerName}_`),
    );

    // Format tools as markdown
    const _markdown = formatToolsAsMarkdown(classTools, className);

    return {
      tools: classTools as McpToolDefinition[],
      className,
    };
  } catch (error) {
    throw new Error(
      `Failed to preview MCP tools: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}

/**
 * Format tools as markdown table
 */
function formatToolsAsMarkdown(tools: any[], className: string): string {
  let markdown = `# MCP Tools for ${className}\n\n`;
  markdown += `| Tool Name | Description | Parameters |\n`;
  markdown += `|-----------|-------------|------------|\n`;

  for (const tool of tools) {
    const params = Object.keys(tool.inputSchema.properties || {}).join(', ');
    markdown += `| ${tool.name} | ${tool.description} | ${params} |\n`;
  }

  markdown += `\n## Tool Details\n\n`;

  for (const tool of tools) {
    markdown += `### ${tool.name}\n\n`;
    markdown += `**Description**: ${tool.description}\n\n`;
    markdown += `**Input Schema**:\n`;
    markdown += `\`\`\`json\n${JSON.stringify(tool.inputSchema, null, 2)}\n\`\`\`\n\n`;
  }

  return markdown;
}
