#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { type AskInput, ask } from './tools/ask.js';
import { getDocs } from './tools/get-docs.js';
import { listPackages } from './tools/list-packages.js';

/**
 * SMRT MCP Server
 * Routes developer queries to appropriate package experts using CLAUDE.md files
 */
class SMRTMCPServer {
  private server: Server;

  constructor() {
    this.server = new Server(
      {
        name: 'smrt-mcp',
        version: '0.1.0',
      },
      {
        capabilities: {
          tools: {},
        },
      },
    );

    this.setupToolHandlers();
    this.setupErrorHandling();
  }

  private setupToolHandlers() {
    // List available tools
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'ask',
          description:
            'Ask a question about the SMRT framework. Automatically routes your query to relevant package experts (CLAUDE.md files) and synthesizes a response using AI.',
          inputSchema: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Your question about SMRT framework usage or capabilities',
              },
              packages: {
                type: 'array',
                items: { type: 'string' },
                description:
                  'Optional: Specific packages to consult (e.g., ["core", "agents"])',
              },
            },
            required: ['query'],
          },
        },
        {
          name: 'list-packages',
          description:
            'List all available SMRT framework packages with their descriptions and keywords',
          inputSchema: {
            type: 'object',
            properties: {},
          },
        },
        {
          name: 'get-docs',
          description:
            'Get the full CLAUDE.md documentation for a specific package',
          inputSchema: {
            type: 'object',
            properties: {
              packageName: {
                type: 'string',
                description:
                  'Name of the package (e.g., "core", "agents", "content")',
              },
            },
            required: ['packageName'],
          },
        },
      ],
    }));

    // Handle tool calls
    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      try {
        switch (request.params.name) {
          case 'ask': {
            const input = (request.params.arguments ??
              {}) as unknown as AskInput;
            return await ask(input);
          }

          case 'list-packages': {
            return await listPackages();
          }

          case 'get-docs': {
            const args = (request.params.arguments ?? {}) as unknown as {
              packageName: string;
            };
            return await getDocs(args.packageName);
          }

          default:
            throw new Error(`Unknown tool: ${request.params.name}`);
        }
      } catch (error) {
        return {
          content: [
            {
              type: 'text',
              text: `Error executing tool: ${error instanceof Error ? error.message : String(error)}`,
            },
          ],
          isError: true,
        };
      }
    });
  }

  private setupErrorHandling() {
    this.server.onerror = (error) => {
      console.error('[MCP Error]', error);
    };

    process.on('SIGINT', async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error('SMRT MCP Server running on stdio');
  }
}

// Start server
const server = new SMRTMCPServer();
server.run().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
