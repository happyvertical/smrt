/**
 * Runtime bootstrap template for generated MCP servers
 *
 * This template provides stdio transport integration for SMRT-generated MCP servers.
 * It handles:
 * - Server initialization with @modelcontextprotocol/sdk
 * - Tool registration from MCPGenerator
 * - Stdio transport connection
 * - Error handling and logging
 * - Graceful shutdown
 */

import type { MCPConfig, MCPContext } from './mcp.js';

/**
 * Helper function to capitalize first letter
 */
function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

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

  /** Static tool definitions (generated at build time) */
  tools?: Array<{
    name: string;
    description: string;
    inputSchema: any;
  }>;

  /**
   * Lowercased simple names of objects that are `@TenantScoped` (#1554). When
   * non-empty, the generated server imports the tenancy fail-closed gate and
   * wraps tenant-scoped tool calls so a stdio invocation cannot read across all
   * tenants. The tenant is sourced from `SMRT_MCP_TENANT_ID` /
   * `SMRT_MCP_ALLOW_CROSS_TENANT` env vars (this server has no auth principal).
   */
  tenantScopedObjects?: string[];
}

/**
 * Generate runtime bootstrap code for MCP server
 *
 * @param options - Runtime configuration options
 * @returns TypeScript code for server entry point
 */
export function generateRuntimeBootstrap(options: RuntimeOptions = {}): string {
  const {
    name = 'smrt-mcp-server',
    version = '1.0.0',
    description = 'Auto-generated MCP server from SMRT objects',
    debug = false,
    tools = [],
    tenantScopedObjects = [],
  } = options;

  // Generate static tool array as TypeScript code
  const toolsCode = tools.length > 0 ? JSON.stringify(tools, null, 2) : '[]';

  // Fail-closed tenant context (#1554): only wire the tenancy gate when at
  // least one exposed object is tenant-scoped, so apps without tenancy never
  // get a dangling import.
  const tenantScopedSet = Array.from(
    new Set(tenantScopedObjects.map((n) => n.toLowerCase())),
  );
  const hasTenantScoped = tenantScopedSet.length > 0;

  // Generate static switch cases using shared helper
  const generateSwitchCases = (indent: string) => {
    return tools
      .map((tool) => {
        const [objectName, action] = tool.name.split('_');

        switch (action) {
          case 'list':
            return `${indent}case '${tool.name}': {
${indent}  const limit = args.limit ?? 50;
${indent}  const offset = args.offset ?? 0;
${indent}  const where = args.where ?? {};

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const items = await collection.list({ where, limit, offset });
${indent}  const itemsPublic = items.map((item) => item.toPublicJSON());
${indent}  return { content: [{ type: 'text', text: JSON.stringify(itemsPublic) }] };
${indent}}`;

          case 'get':
            return `${indent}case '${tool.name}': {
${indent}  if (!args.id && !args.slug) {
${indent}    throw new Error('Either id or slug is required');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const filter = args.id || args.slug;
${indent}  const item = await collection.get(filter);

${indent}  if (!item) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  return { content: [{ type: 'text', text: JSON.stringify(item.toPublicJSON()) }] };
${indent}}`;

          case 'create':
            return `${indent}case '${tool.name}': {
${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const newItem = await collection.create(applyWritablePolicy('${capitalize(objectName)}', args));
${indent}  await newItem.save();

${indent}  return { content: [{ type: 'text', text: JSON.stringify(newItem.toPublicJSON()) }] };
${indent}}`;

          case 'update':
            return `${indent}case '${tool.name}': {
${indent}  const { id, ...updateData } = args;
${indent}  if (!id) {
${indent}    throw new Error('ID is required for update');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const existing = await collection.get(id);
${indent}  if (!existing) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  Object.assign(existing, applyWritablePolicy('${capitalize(objectName)}', updateData));
${indent}  await existing.save();

${indent}  return { content: [{ type: 'text', text: JSON.stringify(existing.toPublicJSON()) }] };
${indent}}`;

          case 'delete':
            return `${indent}case '${tool.name}': {
${indent}  if (!args.id) {
${indent}    throw new Error('ID is required for delete');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const toDelete = await collection.get(args.id);
${indent}  if (!toDelete) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  await toDelete.delete();

${indent}  return { content: [{ type: 'text', text: JSON.stringify({ success: true, message: 'Object deleted successfully' }) }] };
${indent}}`;

          default:
            // Custom action
            return `${indent}case '${tool.name}': {
${indent}  const { id, options = {}, ...directArgs } = args;

${indent}  if (!id) {
${indent}    throw new Error('ID is required for custom action ${action}');
${indent}  }

${indent}  const collection = await ObjectRegistry.getCollection('${capitalize(objectName)}', {
${indent}    persistence: { type: 'sql', url: process.env.DATABASE_URL || ':memory:' },
${indent}    ai: aiConfig
${indent}  });

${indent}  const object = await collection.get(id);
${indent}  if (!object) {
${indent}    throw new Error('Object not found');
${indent}  }

${indent}  if (typeof object['${action}'] !== 'function') {
${indent}    throw new Error('Method ${action} not found on object');
${indent}  }

${indent}  const methodArgs = Object.keys(options).length > 0 ? options : directArgs;
${indent}  const result = await object['${action}'](methodArgs);

${indent}  return { content: [{ type: 'text', text: JSON.stringify(toPublicResult(result)) }] };
${indent}}`;
        }
      })
      .join('\n\n');
  };

  const switchCases = generateSwitchCases('          ');

  return `#!/usr/bin/env node
/**
 * Auto-generated MCP Server
 * Generated by @smrt/core MCPGenerator
 *
 * This server exposes SMRT objects as MCP tools for AI integration.
 *
 * SECURITY (#1540): tool responses exclude @field({ sensitive }) fields and
 * create/update bodies are mass-assignment guarded. This stdio server has NO
 * per-call authentication principal — its trust boundary is the host process /
 * MCP client that launches it. Run it only in a trusted context, or front it
 * with an authenticated gateway. Do not expose it directly to untrusted callers.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
} from '@modelcontextprotocol/sdk/types.js';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { config } from '@happyvertical/smrt-config';
${hasTenantScoped ? "import { runTenantScopedEntryPoint } from '@happyvertical/smrt-tenancy';\n" : ''}
// Server configuration
const SERVER_NAME = ${JSON.stringify(name)};
const SERVER_VERSION = ${JSON.stringify(version)};
const SERVER_DESCRIPTION = ${JSON.stringify(description)};
const DEBUG = ${debug};

// Static tool definitions (generated at build time)
const TOOLS = ${toolsCode};
${
  hasTenantScoped
    ? `
// Fail-closed tenant context (#1554): tenant-scoped objects must run inside a
// tenant. This stdio server has no auth principal, so the tenant is taken from
// the environment; without it (and with tenancy enabled) tenant-scoped tools
// throw rather than reading across all tenants.
const TENANT_SCOPED = new Set(${JSON.stringify(tenantScopedSet)});
const MCP_TENANT_ID = process.env.SMRT_MCP_TENANT_ID || undefined;
const MCP_ALLOW_CROSS_TENANT = process.env.SMRT_MCP_ALLOW_CROSS_TENANT === 'true';
`
    : ''
}

/**
 * Mass-assignment guard (#1540): strip framework/server-managed and
 * \`@field({ readonly: true })\` fields from create/update bodies, intersecting
 * with the optional \`@smrt({ api: { writable: [...] } })\` allowlist.
 */
function applyWritablePolicy(objectName: string, data: any): Record<string, any> {
  if (!data || typeof data !== 'object') return {};
  const serverManaged = new Set([
    'id', 'tenantId', 'tenant_id',
    'createdAt', 'created_at', 'updatedAt', 'updated_at',
  ]);
  const readonly = new Set<string>();
  let writable: string[] | null = null;
  const apiConfig = ObjectRegistry.getConfig(objectName)?.api as any;
  if (apiConfig && typeof apiConfig === 'object' && Array.isArray(apiConfig.writable)) {
    writable = apiConfig.writable;
  }
  for (const [name, def] of ObjectRegistry.getFields(objectName)) {
    if (def && ((def as any).readonly === true || (def as any)._meta?.readonly === true)) {
      readonly.add(name);
    }
  }
  const result: Record<string, any> = {};
  for (const [key, value] of Object.entries(data)) {
    if (key.startsWith('_')) continue;
    if (serverManaged.has(key)) continue;
    if (readonly.has(key)) continue;
    if (writable && !writable.includes(key)) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Sensitive-field-safe serialization for custom-action results (#1540).
 * Recurses through arrays and plain objects so nested SmrtObjects are stripped
 * too; non-plain instances (Date, etc.) and primitives pass through. Cycle-safe.
 */
function toPublicResult(value: any, seen: WeakSet<object> = new WeakSet()): any {
  if (value === null || typeof value !== 'object') return value;
  if (typeof value.toPublicJSON === 'function') return value.toPublicJSON();
  if (Array.isArray(value)) {
    if (seen.has(value)) return value;
    seen.add(value);
    return value.map((entry: any) => toPublicResult(entry, seen));
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  if (seen.has(value)) return value;
  seen.add(value);
  const out: Record<string, any> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = toPublicResult(entry, seen);
  }
  return out;
}

/**
 * Main server startup function
 */
async function main() {
  try {
    if (DEBUG) {
      console.error(\`[MCP] Starting server: \${SERVER_NAME} v\${SERVER_VERSION}\`);
    }

    // Load configuration from environment and .smrt.config files
    const appConfig = await config.load();
    const aiConfig = appConfig?.ai || {};

    if (DEBUG) {
      console.error(\`[MCP] Loaded \${TOOLS.length} static tools\`);
      console.error(\`[MCP] Available tools:\`, TOOLS.map(t => t.name).join(', '));
    }

    // Create MCP server
    const server = new Server(
      {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register ListTools handler
    server.setRequestHandler(ListToolsRequestSchema, async (_request: ListToolsRequest) => {
      if (DEBUG) {
        console.error(\`[MCP] ListTools request received\`);
      }

      return {
        tools: TOOLS,
      };
    });

    // Register CallTool handler
    server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
      const { name: toolName, arguments: args = {} } = request.params;

      if (DEBUG) {
        console.error(\`[MCP] CallTool request: \${toolName}\`);
        console.error(\`[MCP] Arguments:\`, JSON.stringify(args, null, 2));
      }

      try {
        // Static switch statement for tool execution
        const runToolBody = async () => {
          switch (toolName) {
${switchCases}

            default:
              throw new Error(\`Unknown tool: \${toolName}\`);
          }
        };
${
  hasTenantScoped
    ? `
        // Fail-closed tenant context for tenant-scoped tools (#1554).
        const [toolObject] = toolName.split('_');
        const result =
          toolObject && TENANT_SCOPED.has(toolObject.toLowerCase())
            ? await runTenantScopedEntryPoint(
                { tenantScoped: true, tenantId: MCP_TENANT_ID, allowCrossTenant: MCP_ALLOW_CROSS_TENANT, surface: 'MCP' },
                runToolBody,
              )
            : await runToolBody();`
    : `
        const result = await runToolBody();`
}

        if (DEBUG) {
          console.error(\`[MCP] Tool executed successfully: \${toolName}\`);
        }

        return result;
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.error(\`[MCP] Tool execution failed: \${toolName}\`, error);

        return {
          content: [
            {
              type: 'text',
              text: \`Error executing tool \${toolName}: \${errorMessage}\`,
            },
          ],
          isError: true,
        };
      }
    });

    // Setup stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    if (DEBUG) {
      console.error(\`[MCP] Server connected via stdio transport\`);
      console.error(\`[MCP] Ready to receive requests\`);
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      if (DEBUG) {
        console.error(\`[MCP] Received SIGINT, shutting down gracefully\`);
      }
      await server.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      if (DEBUG) {
        console.error(\`[MCP] Received SIGTERM, shutting down gracefully\`);
      }
      await server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('[MCP] Fatal error during server startup:', error);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error('[MCP] Unhandled error:', error);
  process.exit(1);
});
`;
}

/**
 * Generate package.json script for running MCP server
 *
 * @param serverPath - Path to generated server file (relative to package root)
 * @returns Script command for package.json
 */
export function generateMCPScript(
  serverPath: string = 'dist/mcp-server.js',
): string {
  return `node ${serverPath}`;
}

/**
 * Generate Claude Desktop configuration example
 *
 * @param serverName - Name for the MCP server
 * @param serverPath - Absolute path to server file
 * @returns Configuration object for claude_desktop_config.json
 */
export function generateClaudeConfig(
  serverName: string,
  serverPath: string,
): object {
  return {
    mcpServers: {
      [serverName]: {
        command: 'node',
        args: [serverPath],
      },
    },
  };
}

/**
 * Generate README documentation for MCP server setup
 *
 * @param serverName - Name of the MCP server
 * @param serverPath - Path to the server file
 * @returns Markdown documentation
 */
export function generateMCPDocumentation(
  serverName: string,
  serverPath: string,
): string {
  return `# MCP Server Setup

This project includes an auto-generated MCP (Model Context Protocol) server that exposes SMRT objects as tools for AI integration.

## Quick Start

### 1. Build the MCP Server

\`\`\`bash
npm run build
\`\`\`

This generates the MCP server at: \`${serverPath}\`

### 2. Configure Claude Desktop

Add the following to your Claude Desktop configuration file:

**macOS**: \`~/.config/Claude/claude_desktop_config.json\`
**Windows**: \`%APPDATA%\\Claude\\claude_desktop_config.json\`

\`\`\`json
{
  "mcpServers": {
    "${serverName}": {
      "command": "node",
      "args": ["/absolute/path/to/${serverPath}"]
    }
  }
}
\`\`\`

Replace \`/absolute/path/to/\` with the actual absolute path to your project directory.

### 3. Restart Claude Desktop

Close and reopen Claude Desktop to load the new MCP server.

### 4. Test the Integration

In Claude Code, you can now use the auto-generated tools. For example:

- \`list_products\` - List all products
- \`get_product\` - Get a specific product by ID
- \`create_product\` - Create a new product
- And more...

## Environment Variables

The MCP server supports optional environment variables:

- \`DATABASE_URL\` - Database connection string

**AI Provider Configuration (in priority order):**
1. **Generic configuration** (supports any provider):
   - \`SMRT_AI_PROVIDER\` - Provider name (e.g., 'openai', 'anthropic', 'claude-cli', 'gemini')
   - \`SMRT_AI_API_KEY\` - API key for the provider
   - \`SMRT_AI_MODEL\` - Model to use (optional)

2. **Provider-specific fallbacks**:
   - \`OPENAI_API_KEY\` - OpenAI API key (auto-detects provider as 'openai')
   - \`ANTHROPIC_API_KEY\` - Anthropic API key (auto-detects provider as 'anthropic')
   - \`CLAUDE_API_KEY\` + \`CLAUDE_MODEL\` - Claude CLI provider (defaults to 'sonnet')

**Examples:**
\`\`\`bash
# Using generic configuration (recommended)
export SMRT_AI_PROVIDER=claude-cli
export SMRT_AI_MODEL=sonnet

# Using provider-specific configuration
export CLAUDE_API_KEY=your-key
export CLAUDE_MODEL=sonnet

# Using OpenAI
export OPENAI_API_KEY=your-openai-key
\`\`\`

## Troubleshooting

### Server Not Appearing in Claude

1. Check that the path in \`claude_desktop_config.json\` is absolute
2. Verify the server file exists at the specified path
3. Check Claude Desktop logs for errors

### Tools Not Working

1. Ensure your database is accessible (if using one)
2. Check that SMRT objects are properly decorated with \`@smrt()\`
3. Look for errors in the MCP server output

### Debug Mode

To enable debug logging, set the \`DEBUG\` constant to \`true\` in the generated server file.

## Generated Tools

The following tools are automatically generated from your SMRT objects:

- **CRUD Operations**: \`list_\`, \`get_\`, \`create_\`, \`update_\`, \`delete_\` for each object type
- **Custom Actions**: Any custom methods included in the \`@smrt()\` decorator configuration

See the SMRT object definitions for the complete list of available tools and their parameters.
`;
}
