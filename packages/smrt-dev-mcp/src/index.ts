#!/usr/bin/env node

/**
 * SMRT Development MCP Server
 * Provides code generation and project introspection tools
 */

import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import {
  buildArchitectureContext,
  buildKnowledgeIndex,
  buildReviewContext,
  checkKnowledgeFreshness,
  smrtArchitecture,
  smrtReview,
} from './knowledge/index.js';
import { generateSmrtClass, introspectProject } from './tools/index.js';

const SERVER_NAME = 'smrt-dev-mcp';
const SERVER_VERSION = '0.1.0';
const DEBUG = process.env.DEBUG === 'true';

// Tool definitions
export const TOOLS = [
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
  {
    name: 'reflect-knowledge',
    description:
      'Report deterministic SMRT + HappyVertical SDK knowledge coverage and freshness',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: {
          type: 'string',
          description: 'Project root directory (default: cwd)',
        },
      },
    },
  },
  {
    name: 'check-knowledge-freshness',
    description: 'Run deterministic freshness checks for SMRT agent knowledge',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        changed: {
          type: 'boolean',
          description: 'Limit stale-pattern checks to changed files',
        },
        strict: {
          type: 'boolean',
          description: 'Treat stale-pattern findings as errors',
        },
      },
    },
  },
  {
    name: 'build-review-context',
    description:
      'Build model-ready SMRT review context from changed files and optional focus text',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        focus: { type: 'string' },
        documentation: { type: 'string' },
      },
    },
  },
  {
    name: 'smrt-review',
    description:
      'Return deterministic review findings and/or a reusable model prompt bundle',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        focus: { type: 'string' },
        documentation: { type: 'string' },
        mode: {
          type: 'string',
          enum: ['findings', 'prompt-bundle', 'both'],
          default: 'both',
        },
      },
    },
  },
  {
    name: 'build-architecture-context',
    description:
      'Build model-ready SMRT architecture context from an idea or documentation',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        idea: { type: 'string' },
        documentation: { type: 'string' },
        focus: { type: 'string' },
      },
    },
  },
  {
    name: 'smrt-architecture',
    description:
      'Suggest SMRT and HappyVertical SDK packages and return an architecture prompt bundle',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        idea: { type: 'string' },
        documentation: { type: 'string' },
        focus: { type: 'string' },
      },
    },
  },
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
          result = await generateSmrtClass(args as any);
          break;

        case 'introspect-project':
          result = await introspectProject(args as any);
          break;

        case 'reflect-knowledge': {
          const index = await buildKnowledgeIndex(args as any);
          const freshness = await checkKnowledgeFreshness(args as any);
          result = JSON.stringify(
            {
              rootDir: index.rootDir,
              packageCount: index.packages.length,
              smrtPackageCount: index.smrtPackages.length,
              sdkPackageCount: index.sdkPackages.length,
              relationshipsV2: index.relationshipsV2,
              freshness,
            },
            null,
            2,
          );
          break;
        }

        case 'check-knowledge-freshness':
          result = JSON.stringify(
            await checkKnowledgeFreshness(args as any),
            null,
            2,
          );
          break;

        case 'build-review-context':
          result = JSON.stringify(
            await buildReviewContext(args as any),
            null,
            2,
          );
          break;

        case 'smrt-review':
          result = JSON.stringify(await smrtReview(args as any), null, 2);
          break;

        case 'build-architecture-context':
          result = JSON.stringify(
            await buildArchitectureContext(args as any),
            null,
            2,
          );
          break;

        case 'smrt-architecture':
          result = JSON.stringify(await smrtArchitecture(args as any), null, 2);
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

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  return Boolean(entry && import.meta.url === pathToFileURL(entry).href);
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
  });
}
