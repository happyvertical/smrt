import {
  createMcpWorkflowTool,
  type McpAppPrincipal,
  type McpAppServer,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { json, keys, record, text, toolName } from './validation.js';

export interface OpenAiMentionResource {
  type: 'resource';
  resourceUri: string;
  title: string;
  subtitle?: string;
  icons?: Array<{
    src: string;
    mimeType?: string;
    sizes?: string[];
    theme?: 'light' | 'dark';
  }>;
}

/** Exact native metadata, layered onto an existing authorized read workflow. */
export function withOpenAiMentionSearch(
  definition: McpWorkflowToolDefinition,
): McpWorkflowToolDefinition {
  createMcpWorkflowTool(definition);
  if (definition.effect !== 'read' || !definition.idempotent)
    throw new TypeError('Mention search requires an idempotent read workflow');
  if (
    definition.metadata &&
    Object.hasOwn(definition.metadata, 'openai/extensions')
  )
    throw new TypeError('OpenAI extension metadata already declared');
  return {
    ...definition,
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', maxLength: 256 } },
      required: ['query'],
      additionalProperties: false,
    },
    outputSchema: {
      type: 'object',
      properties: {
        items: { type: 'array', maxItems: 25, items: { type: 'object' } },
      },
      required: ['items'],
      additionalProperties: false,
    },
    metadata: {
      ...structuredClone(definition.metadata ?? {}),
      'openai/extensions': { 'mentions/search': {} },
    },
    ui: { visibility: ['app'] },
    async execute(context) {
      const query = mentionQuery(context.arguments);
      const response = await definition.execute({
        ...context,
        arguments: { query },
      });
      if (response.isError) return response;
      return {
        ...response,
        structuredContent: {
          items: openAiMentionItems(record(response.structuredContent).items),
        },
      };
    },
  };
}

export function mentionQuery(value: unknown): string {
  json(value);
  const input = record(value);
  keys(input, ['query']);
  if (typeof input.query !== 'string' || input.query.length > 256)
    throw new TypeError('Expected bounded mention query');
  return input.query;
}

/** Native mention result is deliberately limited to resource links and resource handles. */
export function openAiMentionItems(value: unknown): OpenAiMentionResource[] {
  if (!Array.isArray(value) || value.length > 25)
    throw new TypeError('Too many mention items');
  return value.map((item) => {
    json(item);
    const input = record(item);
    keys(input, ['type', 'resourceUri', 'title', 'subtitle', 'icons']);
    if (input.type !== 'resource')
      throw new TypeError('Unsupported mention item');
    const result: OpenAiMentionResource = {
      type: 'resource',
      resourceUri: text(input.resourceUri, 2048),
      title: text(input.title, 512),
    };
    if (input.subtitle !== undefined)
      result.subtitle = text(input.subtitle, 512);
    if (input.icons !== undefined) {
      if (!Array.isArray(input.icons) || input.icons.length > 8)
        throw new TypeError('Invalid mention icons');
      result.icons = input.icons.map((icon) => {
        json(icon);
        const i = record(icon);
        keys(i, ['src', 'mimeType', 'sizes', 'theme']);
        return {
          src: text(i.src, 2048),
          ...(i.mimeType === undefined
            ? {}
            : { mimeType: text(i.mimeType, 128) }),
        };
      });
    }
    return result;
  });
}

/**
 * Selection never trusts a resource handle. It calls the existing app server,
 * which repeats the current principal/tenant policy and invokes the owning
 * workflow; no second policy engine or cached authorization exists here.
 */
export async function resolveOpenAiMentionSelection(options: {
  server: McpAppServer;
  tool: string;
  arguments: Record<string, unknown>;
  principal: McpAppPrincipal | null;
}) {
  return options.server.callTool({
    name: toolName(options.tool),
    arguments: record(options.arguments),
    principal: options.principal,
  });
}
