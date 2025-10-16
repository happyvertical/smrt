/**
 * Configure @smrt() decorator options for a class
 */

import type { ConfigureDecoratorsInput, ToolResponse } from '../types.js';

/**
 * Generate decorator configuration
 */
export async function configureDecorators(
  input: ConfigureDecoratorsInput,
): Promise<ToolResponse> {
  try {
    const { className, api, mcp, cli, hooks } = input;

    // Build decorator configuration
    const configParts: string[] = [];

    // API configuration
    if (api) {
      const apiParts: string[] = [];

      if (api.include && api.include.length > 0) {
        apiParts.push(
          `include: [${api.include.map((item) => `'${item}'`).join(', ')}]`,
        );
      }

      if (api.exclude && api.exclude.length > 0) {
        apiParts.push(
          `exclude: [${api.exclude.map((item) => `'${item}'`).join(', ')}]`,
        );
      }

      if (apiParts.length > 0) {
        configParts.push(`  api: {\n    ${apiParts.join(',\n    ')}\n  }`);
      }
    }

    // MCP configuration
    if (mcp) {
      const mcpParts: string[] = [];

      if (mcp.include && mcp.include.length > 0) {
        mcpParts.push(
          `include: [${mcp.include.map((item) => `'${item}'`).join(', ')}]`,
        );
      }

      if (mcp.exclude && mcp.exclude.length > 0) {
        mcpParts.push(
          `exclude: [${mcp.exclude.map((item) => `'${item}'`).join(', ')}]`,
        );
      }

      if (mcpParts.length > 0) {
        configParts.push(`  mcp: {\n    ${mcpParts.join(',\n    ')}\n  }`);
      }
    }

    // CLI configuration
    if (cli !== undefined) {
      configParts.push(`  cli: ${cli}`);
    }

    // Hooks configuration
    if (hooks && Object.keys(hooks).length > 0) {
      const hooksParts = Object.entries(hooks)
        .map(([key, value]) => `    ${key}: '${value}'`)
        .join(',\n');
      configParts.push(`  hooks: {\n${hooksParts}\n  }`);
    }

    // Generate final decorator
    const decorator =
      configParts.length > 0
        ? `@smrt({\n${configParts.join(',\n')}\n})`
        : '@smrt()';

    const code = `${decorator}
export class ${className} extends SmrtObject {
  // Class implementation...
}`;

    return {
      success: true,
      data: code,
      warnings: [],
    };
  } catch (error) {
    return {
      success: false,
      error:
        error instanceof Error
          ? error.message
          : 'Unknown error configuring decorators',
    };
  }
}
