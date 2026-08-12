import type { Tool } from '@modelcontextprotocol/server';

export const REVIEW_SKILL_NAME = 'smrt-code-review';

const JSON_SCHEMA_2020_12 = 'https://json-schema.org/draft/2020-12/schema';

function compareToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Stable success/error envelope for development tools. `data` preserves each
 * tool's existing payload exactly; coverage/diagnostics are promoted only when
 * the underlying result actually reports them.
 */
const DEV_MCP_OUTPUT_SCHEMA: NonNullable<Tool['outputSchema']> = {
  $schema: JSON_SCHEMA_2020_12,
  type: 'object',
  additionalProperties: false,
  required: ['ok', 'coverage', 'diagnostics', 'data'],
  properties: {
    ok: { type: 'boolean' },
    coverage: { type: ['object', 'null'], additionalProperties: true },
    diagnostics: {
      type: 'array',
      items: { type: 'object', additionalProperties: true },
    },
    data: {},
  },
};

// Tool definitions
const TOOL_DEFINITIONS: Array<
  Pick<Tool, 'name' | 'description' | 'inputSchema'>
> = [
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
    description:
      'Scan a directory for SMRT objects. Returns a compact summary by default; pass detail: "full" for field, schema, and method details.',
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
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: one compact record per object. full: complete field/schema/method detail (large).',
        },
        maxChars: {
          type: 'number',
          description:
            'Character budget for the `objects` payload. Objects past the budget are omitted and reported under `truncated`. Project metadata and diagnostics are always returned in full, so the serialized response is somewhat larger than this budget.',
        },
        includeFields: {
          type: 'boolean',
          description: 'Include field details (detail: "full" only)',
        },
        includeRelationships: {
          type: 'boolean',
          description: 'Analyze relationships (detail: "full" only)',
        },
        includeMethods: {
          type: 'boolean',
          description: 'Include public method details (detail: "full" only)',
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
          enum: ['project', 'local', 'package', 'sdk', 'installed'],
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
          enum: ['project', 'local', 'package', 'sdk', 'installed'],
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
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: authored package docs are listed by path to stay inside tool-result budgets. full: embed them.',
        },
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
          enum: ['project', 'local', 'package', 'sdk', 'installed'],
          default: 'project',
        },
        package: { type: 'string' },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: authored package docs are listed by path to stay inside tool-result budgets. full: embed them.',
        },
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
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: authored package docs are listed by path to stay inside tool-result budgets. full: embed them.',
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
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: authored package docs are listed by path to stay inside tool-result budgets. full: embed them.',
        },
      },
    },
  },
  {
    name: 'build-package-specialist-context',
    description:
      'Build deterministic package specialist context for the SMRT workbench',
    inputSchema: {
      type: 'object',
      properties: {
        rootDir: { type: 'string' },
        package: {
          type: 'string',
          description:
            'Package name or short package query, e.g. @happyvertical/smrt-content or content',
        },
        focus: { type: 'string' },
      },
      required: ['package'],
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
          enum: ['project', 'local', 'package', 'sdk', 'installed'],
          default: 'project',
        },
        package: { type: 'string' },
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: authored package docs are listed by path to stay inside tool-result budgets. full: embed them.',
        },
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
        detail: {
          type: 'string',
          enum: ['summary', 'full'],
          default: 'summary',
          description:
            'summary: authored package docs are listed by path to stay inside tool-result budgets. full: embed them.',
        },
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

export const TOOLS: Tool[] = TOOL_DEFINITIONS.map((tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    $schema: JSON_SCHEMA_2020_12,
  },
  outputSchema: DEV_MCP_OUTPUT_SCHEMA,
})).sort((left, right) => compareToolNames(left.name, right.name));
