/**
 * SMRT Development MCP Server
 * Provides code generation, project introspection, knowledge context,
 * review/architecture prompt bundles, and portable agent skills.
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

import { getAgentSkill, listAgentSkills } from './agent-skills.js';
import {
  buildArchitectureContext,
  buildKnowledgeIndex,
  buildReviewContext,
  checkKnowledgeFreshness,
  checkKnowledgeFreshnessFromIndex,
  smrtArchitecture,
  smrtReview,
} from './knowledge/index.js';
import { generateSmrtClass, introspectProject } from './tools/index.js';

const SERVER_NAME = 'smrt-dev-mcp';
const SERVER_VERSION = '0.1.0';
const DEBUG = process.env.DEBUG === 'true';
const REVIEW_SKILL_NAME = 'smrt-code-review';
const REVIEW_SKILL_URI = `smrt-dev-mcp://agent-skills/${REVIEW_SKILL_NAME}`;
const DOMAIN_CODE_REVIEW_PROMPT = 'domain-code-review';
const DOMAIN_ARCHITECTURE_PROMPT = 'domain-architecture';
const KNOWLEDGE_PROJECT_URI = 'smrt://knowledge/project';
const KNOWLEDGE_PACKAGE_PREFIX = 'smrt://knowledge/package/';

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
    name: 'reflect-domain-knowledge',
    description:
      'Report domain-scoped SMRT knowledge artifacts, SDK packages, and freshness',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        scope: {
          type: 'string',
          enum: ['project', 'local', 'package', 'sdk'],
          default: 'project',
        },
        package: { type: 'string' },
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
    name: 'check-domain-knowledge',
    description:
      'Run deterministic freshness checks for domain knowledge artifacts',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        changed: { type: 'boolean' },
        strict: { type: 'boolean' },
        scope: {
          type: 'string',
          enum: ['project', 'local', 'package', 'sdk'],
          default: 'project',
        },
        package: { type: 'string' },
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
    name: 'build-domain-review-context',
    description:
      'Build domain-scoped model-ready SMRT review context and prompt bundle',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        changedFiles: { type: 'array', items: { type: 'string' } },
        focus: { type: 'string' },
        documentation: { type: 'string' },
        scope: {
          type: 'string',
          enum: ['project', 'local', 'package', 'sdk'],
          default: 'project',
        },
        package: { type: 'string' },
      },
    },
  },
  {
    name: 'smrt-review',
    description:
      'Return deterministic review findings and/or a reusable model prompt bundle. For a formal downstream review, first call get-agent-skill with { "name": "smrt-code-review" } or load the smrt-code-review MCP prompt/resource.',
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
    name: 'build-domain-architecture-context',
    description:
      'Build domain-scoped model-ready SMRT architecture context and prompt bundle',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        idea: { type: 'string' },
        documentation: { type: 'string' },
        focus: { type: 'string' },
        scope: {
          type: 'string',
          enum: ['project', 'local', 'package', 'sdk'],
          default: 'project',
        },
        package: { type: 'string' },
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
  {
    name: 'list-agent-skills',
    description:
      'List bundled harness-agnostic agent skills shipped with smrt-dev-mcp',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get-agent-skill',
    description:
      'Return a bundled harness-agnostic agent skill as Markdown plus optional references',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: [REVIEW_SKILL_NAME],
          description: 'Bundled agent skill name',
        },
        includeReferences: {
          type: 'boolean',
          default: true,
          description: 'Include referenced files with the skill bundle',
        },
      },
      required: ['name'],
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
        prompts: {},
        resources: {},
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

  server.setRequestHandler(ListPromptsRequestSchema, async () => {
    return {
      prompts: [
        {
          name: REVIEW_SKILL_NAME,
          title: 'SMRT Code Review',
          description:
            'Harness-agnostic downstream SMRT review procedure that uses smrt-dev-mcp deterministic context and prompt bundles.',
        },
        {
          name: DOMAIN_CODE_REVIEW_PROMPT,
          title: 'Domain Code Review',
          description:
            'Model-ready domain-scoped SMRT code review prompt bundle.',
        },
        {
          name: DOMAIN_ARCHITECTURE_PROMPT,
          title: 'Domain Architecture',
          description:
            'Model-ready domain-scoped SMRT architecture planning prompt bundle.',
        },
      ],
    };
  });

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;
    if (name === REVIEW_SKILL_NAME) {
      return {
        description:
          'Use this procedure when reviewing downstream SMRT projects.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: renderAgentSkillMarkdown(REVIEW_SKILL_NAME),
            },
          },
        ],
      };
    }

    if (name === DOMAIN_CODE_REVIEW_PROMPT) {
      const context = await buildReviewContext(request.params.arguments as any);
      return {
        description: 'Review downstream SMRT code with domain knowledge.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: context.promptBundle.contextMarkdown,
            },
          },
        ],
      };
    }

    if (name === DOMAIN_ARCHITECTURE_PROMPT) {
      const context = await buildArchitectureContext(
        request.params.arguments as any,
      );
      return {
        description: 'Plan a downstream SMRT project with domain knowledge.',
        messages: [
          {
            role: 'user' as const,
            content: {
              type: 'text' as const,
              text: context.promptBundle.contextMarkdown,
            },
          },
        ],
      };
    }

    throw new Error(`Unknown prompt: ${name}`);
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const index = await buildKnowledgeIndex();
    return {
      resources: [
        {
          uri: REVIEW_SKILL_URI,
          name: REVIEW_SKILL_NAME,
          title: 'SMRT Code Review Skill',
          description:
            'Bundled Markdown skill for downstream SMRT code reviews.',
          mimeType: 'text/markdown',
        },
        {
          uri: KNOWLEDGE_PROJECT_URI,
          name: 'smrt-domain-knowledge-project',
          title: 'SMRT Domain Knowledge Project Index',
          description:
            'Composed SMRT, downstream domain, and HappyVertical SDK knowledge index.',
          mimeType: 'application/json',
        },
        ...index.packages.map((pkg) => ({
          uri: `${KNOWLEDGE_PACKAGE_PREFIX}${encodeURIComponent(pkg.name)}`,
          name: `smrt-domain-knowledge-${pkg.name}`,
          title: `SMRT Domain Knowledge: ${pkg.name}`,
          description:
            'Package-scoped SMRT domain knowledge, generated surfaces, and authored context.',
          mimeType: 'application/json',
        })),
      ],
    };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    if (uri === REVIEW_SKILL_URI) {
      return {
        contents: [
          {
            uri,
            mimeType: 'text/markdown',
            text: renderAgentSkillMarkdown(REVIEW_SKILL_NAME),
          },
        ],
      };
    }

    if (uri === KNOWLEDGE_PROJECT_URI) {
      const index = await buildKnowledgeIndex();
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(index, null, 2),
          },
        ],
      };
    }

    if (uri.startsWith(KNOWLEDGE_PACKAGE_PREFIX)) {
      const packageName = decodeURIComponent(
        uri.slice(KNOWLEDGE_PACKAGE_PREFIX.length),
      );
      const index = await buildKnowledgeIndex();
      const pkg = index.packages.find((item) => item.name === packageName);
      if (!pkg) throw new Error(`Unknown knowledge package: ${packageName}`);
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(pkg, null, 2),
          },
        ],
      };
    }

    throw new Error(`Unknown resource: ${uri}`);
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
          const freshness = await checkKnowledgeFreshnessFromIndex(
            index,
            args as any,
          );
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

        case 'reflect-domain-knowledge': {
          const index = await buildKnowledgeIndex(args as any);
          const freshness = await checkKnowledgeFreshnessFromIndex(
            index,
            args as any,
          );
          result = JSON.stringify(
            {
              rootDir: index.rootDir,
              packageCount: index.packages.length,
              smrtPackageCount: index.smrtPackages.length,
              sdkPackageCount: index.sdkPackages.length,
              domainKnowledgePackageCount: index.packages.filter(
                (pkg) => pkg.hasDomainKnowledge,
              ).length,
              missingDomainKnowledgePackages: index.packages
                .filter(
                  (pkg) =>
                    pkg.exportKeys.includes('./smrt-knowledge.json') &&
                    !pkg.hasDomainKnowledge,
                )
                .map((pkg) => pkg.name),
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

        case 'check-domain-knowledge':
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

        case 'build-domain-review-context':
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

        case 'build-domain-architecture-context':
          result = JSON.stringify(
            await buildArchitectureContext(args as any),
            null,
            2,
          );
          break;

        case 'smrt-architecture':
          result = JSON.stringify(await smrtArchitecture(args as any), null, 2);
          break;

        case 'list-agent-skills':
          result = JSON.stringify({ skills: listAgentSkills() }, null, 2);
          break;

        case 'get-agent-skill':
          result = JSON.stringify(await getAgentSkill(args as any), null, 2);
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
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return import.meta.url === pathToFileURL(entry).href;
  }
}

function renderAgentSkillMarkdown(name: string): string {
  const skill = getAgentSkill({ name, includeReferences: true });
  const references = skill.referenceFiles.map(
    (file) => `## Reference: ${file.path}\n\n${file.content.trim()}`,
  );
  return [skill.skillMarkdown.trim(), ...references].join('\n\n');
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
  });
}
