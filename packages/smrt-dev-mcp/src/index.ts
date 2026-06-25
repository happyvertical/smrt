/**
 * SMRT Development MCP Server
 * Provides code generation, project introspection, knowledge context,
 * review/architecture prompt bundles, and portable agent skills.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ErrorCode,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
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
import {
  generateSmrtClass,
  introspectProject,
  reviewSmrtProject,
} from './tools/index.js';

const SERVER_NAME = 'smrt-dev-mcp';
export const SERVER_VERSION = readPackageVersion();
const DEBUG = process.env.DEBUG === 'true';
const REVIEW_SKILL_NAME = 'smrt-code-review';
const REVIEW_SKILL_URI = `smrt-dev-mcp://agent-skills/${REVIEW_SKILL_NAME}`;
const DOMAIN_CODE_REVIEW_PROMPT = 'domain-code-review';
const DOMAIN_ARCHITECTURE_PROMPT = 'domain-architecture';
const KNOWLEDGE_PROJECT_URI = 'smrt://knowledge/project';
const KNOWLEDGE_PACKAGE_PREFIX = 'smrt://knowledge/package/';

type KnowledgeIndexResult = Awaited<ReturnType<typeof buildKnowledgeIndex>>;
type KnowledgePackageResult = KnowledgeIndexResult['packages'][number];
type PromptArguments = Record<string, string> | undefined;

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
              nullable: { type: 'boolean' },
              description: { type: 'string' },
              defaultValue: {
                oneOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'boolean' },
                  { type: 'object' },
                  { type: 'null' },
                ],
              },
            },
            required: ['name', 'type'],
          },
        },
        baseClass: {
          type: 'string',
          enum: ['SmrtObject', 'SmrtCollection'],
          default: 'SmrtObject',
        },
        template: {
          type: 'string',
          enum: [
            'basic',
            'global-catalog',
            'optional-catalog',
            'tenant-project-object',
            'tenant-event-log-object',
            'cross-package-reference',
          ],
          default: 'basic',
        },
        tableName: { type: 'string' },
        conflictColumns: {
          type: 'array',
          items: { type: 'string' },
        },
        tenantScoped: {
          oneOf: [
            { type: 'boolean' },
            {
              type: 'object',
              properties: {
                mode: { type: 'string', enum: ['required', 'optional'] },
                field: { type: 'string' },
                autoFilter: { type: 'boolean' },
                autoPopulate: { type: 'boolean' },
                allowSuperAdminBypass: { type: 'boolean' },
              },
            },
          ],
        },
        includeTenantIdField: { type: 'boolean' },
        relationships: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              type: {
                type: 'string',
                enum: [
                  'foreignKey',
                  'crossPackageRef',
                  'oneToMany',
                  'manyToMany',
                ],
              },
              related: { type: 'string' },
              required: { type: 'boolean' },
              nullable: { type: 'boolean' },
              description: { type: 'string' },
              validate: { type: 'boolean' },
              foreignKey: { type: 'string' },
              through: { type: 'string' },
              sourceKey: { type: 'string' },
              targetKey: { type: 'string' },
            },
            required: ['name', 'type', 'related'],
          },
        },
        includeCompanionSnippets: { type: 'boolean', default: false },
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
        manifestPath: {
          type: 'string',
          description:
            'Optional manifest path. Defaults to .smrt/manifest.json, dist/manifest.json, then source scanning.',
        },
        includeFields: {
          type: 'boolean',
          description: 'Include field details',
        },
        includeRelationships: {
          type: 'boolean',
          description: 'Analyze relationships',
        },
        includeMethods: {
          type: 'boolean',
          description: 'Include public method details',
        },
      },
    },
  },
  {
    name: 'review-smrt-project',
    description:
      'Advisory ecosystem alignment review for downstream SMRT projects',
    inputSchema: {
      type: 'object',
      properties: {
        directory: {
          type: 'string',
          description: 'Project directory (default: cwd)',
        },
        rootDir: {
          type: 'string',
          description: 'Compatibility alias for directory',
        },
        includeSourceEvidence: {
          type: 'boolean',
          description: 'Include file and line evidence in findings',
          default: true,
        },
        maxFindings: {
          type: 'number',
          description: 'Optional maximum number of findings to return',
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
          arguments: [
            {
              name: 'rootDir',
              description: 'Project root directory. Defaults to server cwd.',
              required: false,
            },
            {
              name: 'changedFiles',
              description:
                'Changed file paths as newline-separated, comma-separated, or JSON array text.',
              required: false,
            },
            {
              name: 'focus',
              description: 'Review focus text.',
              required: false,
            },
            {
              name: 'documentation',
              description: 'Additional documentation or notes.',
              required: false,
            },
            {
              name: 'scope',
              description: 'Knowledge scope: project, local, package, or sdk.',
              required: false,
            },
            {
              name: 'package',
              description: 'Package name or short package selector.',
              required: false,
            },
          ],
        },
        {
          name: DOMAIN_ARCHITECTURE_PROMPT,
          title: 'Domain Architecture',
          description:
            'Model-ready domain-scoped SMRT architecture planning prompt bundle.',
          arguments: [
            {
              name: 'rootDir',
              description: 'Project root directory. Defaults to server cwd.',
              required: false,
            },
            {
              name: 'idea',
              description: 'Architecture idea or product concept.',
              required: false,
            },
            {
              name: 'documentation',
              description: 'Additional documentation or notes.',
              required: false,
            },
            {
              name: 'focus',
              description: 'Planning focus text.',
              required: false,
            },
            {
              name: 'scope',
              description: 'Knowledge scope: project, local, package, or sdk.',
              required: false,
            },
            {
              name: 'package',
              description: 'Package name or short package selector.',
              required: false,
            },
          ],
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
      const context = await buildReviewContext(
        reviewPromptArguments(request.params.arguments),
      );
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
        architecturePromptArguments(request.params.arguments),
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

    throw new McpError(ErrorCode.InvalidParams, `Unknown prompt: ${name}`);
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
            text: JSON.stringify(sanitizeKnowledgeIndex(index), null, 2),
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
      if (!pkg) {
        throw new McpError(
          ErrorCode.InvalidParams,
          `Unknown knowledge package: ${packageName}`,
        );
      }
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(sanitizeKnowledgePackage(pkg), null, 2),
          },
        ],
      };
    }

    throw new McpError(ErrorCode.InvalidParams, `Unknown resource: ${uri}`);
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
          result = await generateSmrtClass(
            args as unknown as Parameters<typeof generateSmrtClass>[0],
          );
          break;

        case 'introspect-project':
          result = await introspectProject(
            args as unknown as Parameters<typeof introspectProject>[0],
          );
          break;

        case 'review-smrt-project':
          result = await reviewSmrtProject(
            args as unknown as Parameters<typeof reviewSmrtProject>[0],
          );
          break;

        case 'reflect-knowledge': {
          const index = await buildKnowledgeIndex(
            args as unknown as Parameters<typeof buildKnowledgeIndex>[0],
          );
          const freshness = await checkKnowledgeFreshnessFromIndex(
            index,
            args as unknown as Parameters<
              typeof checkKnowledgeFreshnessFromIndex
            >[1],
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
          const index = await buildKnowledgeIndex(
            args as unknown as Parameters<typeof buildKnowledgeIndex>[0],
          );
          const freshness = await checkKnowledgeFreshnessFromIndex(
            index,
            args as unknown as Parameters<
              typeof checkKnowledgeFreshnessFromIndex
            >[1],
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
            await checkKnowledgeFreshness(
              args as unknown as Parameters<typeof checkKnowledgeFreshness>[0],
            ),
            null,
            2,
          );
          break;

        case 'check-domain-knowledge':
          result = JSON.stringify(
            await checkKnowledgeFreshness(
              args as unknown as Parameters<typeof checkKnowledgeFreshness>[0],
            ),
            null,
            2,
          );
          break;

        case 'build-review-context':
          result = JSON.stringify(
            await buildReviewContext(
              args as unknown as Parameters<typeof buildReviewContext>[0],
            ),
            null,
            2,
          );
          break;

        case 'build-domain-review-context':
          result = JSON.stringify(
            await buildReviewContext(
              args as unknown as Parameters<typeof buildReviewContext>[0],
            ),
            null,
            2,
          );
          break;

        case 'smrt-review':
          result = JSON.stringify(
            await smrtReview(
              args as unknown as Parameters<typeof smrtReview>[0],
            ),
            null,
            2,
          );
          break;

        case 'build-architecture-context':
          result = JSON.stringify(
            await buildArchitectureContext(
              args as unknown as Parameters<typeof buildArchitectureContext>[0],
            ),
            null,
            2,
          );
          break;

        case 'build-domain-architecture-context':
          result = JSON.stringify(
            await buildArchitectureContext(
              args as unknown as Parameters<typeof buildArchitectureContext>[0],
            ),
            null,
            2,
          );
          break;

        case 'smrt-architecture':
          result = JSON.stringify(
            await smrtArchitecture(
              args as unknown as Parameters<typeof smrtArchitecture>[0],
            ),
            null,
            2,
          );
          break;

        case 'list-agent-skills':
          result = JSON.stringify({ skills: listAgentSkills() }, null, 2);
          break;

        case 'get-agent-skill':
          result = JSON.stringify(
            await getAgentSkill(
              args as unknown as Parameters<typeof getAgentSkill>[0],
            ),
            null,
            2,
          );
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

function readPackageVersion(): string {
  try {
    const packageRoot = dirname(fileURLToPath(import.meta.url));
    const packageJsonPath = join(packageRoot, '..', 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as {
      version?: unknown;
    };
    return typeof packageJson.version === 'string'
      ? packageJson.version
      : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function renderAgentSkillMarkdown(name: string): string {
  const skill = getAgentSkill({ name, includeReferences: true });
  const references = skill.referenceFiles.map(
    (file) => `## Reference: ${file.path}\n\n${file.content.trim()}`,
  );
  return [skill.skillMarkdown.trim(), ...references].join('\n\n');
}

function reviewPromptArguments(args: PromptArguments): Record<string, unknown> {
  return compactRecord({
    rootDir: args?.rootDir,
    changedFiles: parseStringList(args?.changedFiles),
    focus: args?.focus,
    documentation: args?.documentation,
    scope: args?.scope,
    package: args?.package,
  });
}

function architecturePromptArguments(
  args: PromptArguments,
): Record<string, unknown> {
  return compactRecord({
    rootDir: args?.rootDir,
    idea: args?.idea,
    documentation: args?.documentation,
    focus: args?.focus,
    scope: args?.scope,
    package: args?.package,
  });
}

function parseStringList(value: string | undefined): string[] | undefined {
  if (!value?.trim()) return undefined;

  try {
    const parsed = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === 'string');
    }
  } catch {
    // Fall through to delimiter parsing.
  }

  return value
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function compactRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function sanitizeKnowledgeIndex(index: KnowledgeIndexResult) {
  const packages = index.packages.map((pkg) => sanitizeKnowledgePackage(pkg));
  return {
    ...index,
    rootDir: '.',
    packages,
    smrtPackages: packages.filter((pkg) => pkg.kind === 'smrt'),
    sdkPackages: packages.filter((pkg) => pkg.kind === 'sdk'),
  };
}

function sanitizeKnowledgePackage(pkg: KnowledgePackageResult) {
  const { directory: _directory, objects, ...rest } = pkg;
  return {
    ...rest,
    objects: objects.map((object) => ({
      ...object,
      filePath: sanitizePath(object.filePath),
    })),
  };
}

function sanitizePath(path: string | undefined): string | undefined {
  if (!path) return path;
  if (path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path)) {
    return '<absolute-path>';
  }
  return path;
}

if (isEntrypoint()) {
  main().catch((error) => {
    console.error(`[${SERVER_NAME}] Fatal error:`, error);
    process.exit(1);
  });
}
