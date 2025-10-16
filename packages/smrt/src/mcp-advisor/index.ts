#!/usr/bin/env node
/**
 * SMRT Framework Advisor MCP Server
 *
 * Development-time MCP server that acts as a SMRT framework expert.
 * Provides AI-callable tools for code generation, validation, preview, and discovery.
 *
 * This server integrates with Claude Code to help developers write correct SMRT code.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolRequest,
  type ListToolsRequest,
} from '@modelcontextprotocol/sdk/types.js';

// Import tool implementations
import { generateSmrtClass } from './tools/generate-smrt-class.js';
import { addAiMethods } from './tools/add-ai-methods.js';
import { generateFieldDefinitions } from './tools/generate-field-definitions.js';
import { generateCollection } from './tools/generate-collection.js';
import { configureDecorators } from './tools/configure-decorators.js';
import { validateSmrtObject } from './tools/validate-smrt-object.js';
import { previewApiEndpoints } from './tools/preview-api-endpoints.js';
import { previewMcpTools } from './tools/preview-mcp-tools.js';
import { listRegisteredObjects } from './tools/list-registered-objects.js';
import { getObjectSchema } from './tools/get-object-schema.js';
import { getObjectConfig } from './tools/get-object-config.js';

// Server configuration
const SERVER_NAME = 'smrt-advisor';
const SERVER_VERSION = '1.0.0';
const DEBUG = process.env.DEBUG === 'true';

/**
 * MCP tool definitions with JSON schemas
 */
const TOOLS = [
  {
    name: 'generate-smrt-class',
    description:
      'Generate a complete SMRT class with @smrt() decorator, properties, and constructor',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the class to generate (PascalCase)',
        },
        properties: {
          type: 'array',
          description: 'Array of property definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Property name' },
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
                description: 'Property type',
              },
              required: {
                type: 'boolean',
                description: 'Whether property is required',
              },
              description: {
                type: 'string',
                description: 'Property description',
              },
            },
            required: ['name', 'type'],
          },
        },
        baseClass: {
          type: 'string',
          enum: ['SmrtObject', 'SmrtCollection'],
          description: 'Base class to extend',
          default: 'SmrtObject',
        },
        includeApiConfig: {
          type: 'boolean',
          description: 'Include API configuration in decorator',
          default: true,
        },
        includeMcpConfig: {
          type: 'boolean',
          description: 'Include MCP configuration in decorator',
          default: true,
        },
        includeCliConfig: {
          type: 'boolean',
          description: 'Include CLI configuration in decorator',
          default: true,
        },
      },
      required: ['className', 'properties'],
    },
  },
  {
    name: 'add-ai-methods',
    description:
      'Add AI-powered methods (is, do, tool) to an existing SMRT class',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the class',
        },
        methods: {
          type: 'array',
          description: 'Methods to add',
          items: {
            type: 'string',
            enum: ['is', 'do', 'tool'],
          },
        },
        filePath: {
          type: 'string',
          description: 'Path to the class file (optional)',
        },
      },
      required: ['className', 'methods'],
    },
  },
  {
    name: 'generate-field-definitions',
    description:
      'Generate field definitions with proper imports from @have/smrt/fields',
    inputSchema: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description: 'Array of field definitions',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'Field name' },
              type: {
                type: 'string',
                enum: [
                  'text',
                  'integer',
                  'decimal',
                  'boolean',
                  'datetime',
                  'json',
                  'foreignKey',
                ],
                description: 'Field type',
              },
              options: {
                type: 'object',
                description: 'Field options (required, default, etc.)',
                additionalProperties: true,
              },
            },
            required: ['name', 'type'],
          },
        },
      },
      required: ['fields'],
    },
  },
  {
    name: 'generate-collection',
    description: 'Generate a SmrtCollection subclass for a SMRT object',
    inputSchema: {
      type: 'object',
      properties: {
        collectionName: {
          type: 'string',
          description: 'Name of the collection class',
        },
        itemClassName: {
          type: 'string',
          description: 'Name of the item class',
        },
        itemClassPath: {
          type: 'string',
          description: 'Import path for the item class',
        },
        includeCustomMethods: {
          type: 'boolean',
          description: 'Include placeholder custom methods',
          default: false,
        },
      },
      required: ['collectionName', 'itemClassName', 'itemClassPath'],
    },
  },
  {
    name: 'configure-decorators',
    description: 'Configure @smrt() decorator options for a class',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the class',
        },
        api: {
          type: 'object',
          description: 'API configuration',
          properties: {
            include: {
              type: 'array',
              items: { type: 'string' },
              description: 'Operations to include',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Operations to exclude',
            },
          },
        },
        mcp: {
          type: 'object',
          description: 'MCP configuration',
          properties: {
            include: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tools to include',
            },
            exclude: {
              type: 'array',
              items: { type: 'string' },
              description: 'Tools to exclude',
            },
          },
        },
        cli: {
          type: 'boolean',
          description: 'Enable CLI commands',
        },
        hooks: {
          type: 'object',
          description: 'Lifecycle hooks',
          additionalProperties: { type: 'string' },
        },
      },
      required: ['className'],
    },
  },
  {
    name: 'validate-smrt-object',
    description: 'Validate SMRT object class structure and configuration',
    inputSchema: {
      type: 'object',
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the class file',
        },
        strictMode: {
          type: 'boolean',
          description: 'Enable strict validation rules',
          default: false,
        },
      },
      required: ['filePath'],
    },
  },
  {
    name: 'preview-api-endpoints',
    description: 'Preview auto-generated REST API endpoints for a SMRT class',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the SMRT class',
        },
        basePath: {
          type: 'string',
          description: 'API base path',
          default: '/api/v1',
        },
      },
      required: ['className'],
    },
  },
  {
    name: 'preview-mcp-tools',
    description: 'Preview auto-generated MCP tools for a SMRT class',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the SMRT class',
        },
      },
      required: ['className'],
    },
  },
  {
    name: 'list-registered-objects',
    description: 'List all registered SMRT objects in the ObjectRegistry',
    inputSchema: {
      type: 'object',
      properties: {
        filter: {
          type: 'string',
          enum: ['all', 'objects', 'collections'],
          description: 'Filter by type',
          default: 'all',
        },
      },
    },
  },
  {
    name: 'get-object-schema',
    description:
      'Get the schema (fields, types, constraints) for a SMRT object',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the SMRT class',
        },
        format: {
          type: 'string',
          enum: ['json', 'typescript', 'table'],
          description: 'Output format',
          default: 'json',
        },
      },
      required: ['className'],
    },
  },
  {
    name: 'get-object-config',
    description:
      'Get the @smrt() decorator configuration for a SMRT object',
    inputSchema: {
      type: 'object',
      properties: {
        className: {
          type: 'string',
          description: 'Name of the SMRT class',
        },
        format: {
          type: 'string',
          enum: ['json', 'yaml'],
          description: 'Output format',
          default: 'json',
        },
      },
      required: ['className'],
    },
  },
];

/**
 * Route tool calls to appropriate handler functions
 */
async function handleToolCall(name: string, args: any): Promise<any> {
  switch (name) {
    case 'generate-smrt-class':
      return generateSmrtClass(args);
    case 'add-ai-methods':
      return addAiMethods(args);
    case 'generate-field-definitions':
      return generateFieldDefinitions(args);
    case 'generate-collection':
      return generateCollection(args);
    case 'configure-decorators':
      return configureDecorators(args);
    case 'validate-smrt-object':
      return validateSmrtObject(args);
    case 'preview-api-endpoints':
      return previewApiEndpoints(args);
    case 'preview-mcp-tools':
      return previewMcpTools(args);
    case 'list-registered-objects':
      return listRegisteredObjects(args);
    case 'get-object-schema':
      return getObjectSchema(args);
    case 'get-object-config':
      return getObjectConfig(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/**
 * Main server startup function
 */
async function main() {
  try {
    if (DEBUG) {
      console.error(`[SMRT Advisor] Starting server v${SERVER_VERSION}`);
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
      },
    );

    // Register ListTools handler
    server.setRequestHandler(
      ListToolsRequestSchema,
      async (_request: ListToolsRequest) => {
        if (DEBUG) {
          console.error(
            `[SMRT Advisor] ListTools request - returning ${TOOLS.length} tools`,
          );
        }

        return {
          tools: TOOLS,
        };
      },
    );

    // Register CallTool handler
    server.setRequestHandler(
      CallToolRequestSchema,
      async (request: CallToolRequest) => {
        const { name: toolName, arguments: args } = request.params;

        if (DEBUG) {
          console.error(`[SMRT Advisor] CallTool: ${toolName}`);
          console.error(
            `[SMRT Advisor] Arguments:`,
            JSON.stringify(args, null, 2),
          );
        }

        try {
          // Execute tool
          const result = await handleToolCall(toolName, args || {});

          if (DEBUG) {
            console.error(`[SMRT Advisor] Tool ${toolName} completed successfully`);
          }

          // Format response
          return {
            content: [
              {
                type: 'text',
                text:
                  typeof result === 'string'
                    ? result
                    : JSON.stringify(result, null, 2),
              },
            ],
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          console.error(`[SMRT Advisor] Tool ${toolName} failed:`, error);

          return {
            content: [
              {
                type: 'text',
                text: `Error executing ${toolName}: ${errorMessage}`,
              },
            ],
            isError: true,
          };
        }
      },
    );

    // Setup stdio transport
    const transport = new StdioServerTransport();

    // Connect server to transport
    await server.connect(transport);

    if (DEBUG) {
      console.error(`[SMRT Advisor] Server connected via stdio transport`);
      console.error(`[SMRT Advisor] Available tools: ${TOOLS.map((t) => t.name).join(', ')}`);
      console.error(`[SMRT Advisor] Ready to receive requests`);
    }

    // Handle graceful shutdown
    process.on('SIGINT', async () => {
      if (DEBUG) {
        console.error(`[SMRT Advisor] Received SIGINT, shutting down`);
      }
      await server.close();
      process.exit(0);
    });

    process.on('SIGTERM', async () => {
      if (DEBUG) {
        console.error(`[SMRT Advisor] Received SIGTERM, shutting down`);
      }
      await server.close();
      process.exit(0);
    });
  } catch (error) {
    console.error('[SMRT Advisor] Fatal error during startup:', error);
    process.exit(1);
  }
}

// Start the server
main().catch((error) => {
  console.error('[SMRT Advisor] Unhandled error:', error);
  process.exit(1);
});
