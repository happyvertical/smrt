#!/usr/bin/env node
/**
 * SMRT Development MCP Server
 * Provides code generation and project introspection tools
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { generateSmrtClass, introspectProject } from './tools/index.js';

const SERVER_NAME = 'smrt-dev-mcp';
const SERVER_VERSION = '0.1.0';
const DEBUG = process.env.DEBUG === 'true';

// Tool definitions
const TOOLS = [
  // Code Generation Tools
  {
    name: 'generate-smrt-class',
    description: 'Generate a complete SMRT class with @smrt() decorator',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the class (PascalCase)',
        },
        properties: {
          type: 'array',
          description: 'Array of property definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: {
                type: 'string',
                enum: [
                  'text',
                  'integer',
                  'decimal',
                  'boolean',
                  'datetime',
                  'json',
                ],
              },
              required: { type: 'boolean' },
              description: { type: 'string' },
            },
            required: ['name', 'type'],
          },
        },
        baseClass: {
          type: 'string',
          enum: ['SmrtObject', 'SmrtCollection'],
          default: 'SmrtObject',
        },
        includeApiConfig: { type: 'boolean', default: true },
        includeMcpConfig: { type: 'boolean', default: true },
        includeCliConfig: { type: 'boolean', default: true },
      },
      required: ['className', 'properties'],
    },
  },
  // Project Introspection Tools
  {
    name: 'introspect-project',
    description: 'Scan current directory for SMRT objects',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Project directory (default: cwd)',
        },
        includeFields: {
          type: 'boolean',
          description: 'Include field details',
        },
        includeRelationships: {
          type: 'boolean',
          description: 'Analyze relationships',
        },
      },
    },
  },
  // Add more tool definitions here as we implement them
];

async function main() {
  if (DEBUG) {
    console.error(`[${SERVER_NAME}] Starting server v${SERVER_VERSION}`);
  }

  const server = new Server(
    {
      name: SERVER_NAME,
      version: SERVER_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (DEBUG) {
      console.error(`[${SERVER_NAME}] ListTools request`);
    }
    return { tools: TOOLS };
  });

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (DEBUG) {
      console.error(`[${SERVER_NAME}] CallTool: ${name}`);
      console.error(
        `[${SERVER_NAME}] Arguments:`,
        JSON.stringify(args, null, 2),
      );
    }

    try {
      let result: string;

      switch (name) {
        case 'generate-smrt-class':
          result = await generateSmrtClass(args || {});
          break;

        case 'introspect-project':
          result = await introspectProject(args || {});
          break;

        default:
          throw new Error(`Unknown tool: ${name}`);
      }

      return {
        content: [
          {
            type: 'text',
            text: result,
          },
        ],
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Unknown error';
      console.error(`[${SERVER_NAME}] Error:`, error);

      return {
        content: [
          {
            type: 'text',
            text: `Error executing tool ${name}: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });

  // Setup stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);

  if (DEBUG) {
    console.error(`[${SERVER_NAME}] Server connected via stdio`);
  }

  // Graceful shutdown
  process.on('SIGINT', async () => {
    if (DEBUG) {
      console.error(`[${SERVER_NAME}] Shutting down...`);
    }
    await server.close();
    process.exit(0);
  });

  process.on('SIGTERM', async () => {
    if (DEBUG) {
      console.error(`[${SERVER_NAME}] Shutting down...`);
    }
    await server.close();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error(`[${SERVER_NAME}] Fatal error:`, error);
  process.exit(1);
});
