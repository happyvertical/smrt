import {
  createMcpAppServer,
  type McpAppPrincipal,
  type McpWorkflowToolDefinition,
} from '@happyvertical/smrt-app-mcp';
import { openAiDisplayMetadata, withOpenAiEntrypoints } from '@happyvertical/smrt-mcp-openai';
import { getApplicationDatabaseConfig } from './application-runtime.js';

const ITEM_RESOURCE_URI = 'ui://smrt-app/v1/items.html';
const itemResourceHtml = `<!doctype html><html lang="en"><head><title>Items</title></head><body><main tabindex="-1"><h1>Items</h1><p>Use the host controls to review your authorized items.</p></main></body></html>`;

const itemsOverview: McpWorkflowToolDefinition = withOpenAiEntrypoints(
  {
    name: 'items_overview',
    description: 'Open the authorized item overview.',
    title: 'Items',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { state: { type: 'string' } },
      required: ['state'],
      additionalProperties: false,
    },
    effect: 'read',
    idempotent: true,
    openWorld: false,
    ui: { resourceUri: ITEM_RESOURCE_URI },
    async execute() {
      return {
        content: [{ type: 'text', text: 'Item overview is ready.' }],
        structuredContent: { state: 'ready' },
      };
    },
  },
  ['global'],
);

/**
 * The session hook resolves membership and permissions for every request. This
 * adapter only projects that trusted, request-local result; headers and route
 * arguments are never identity inputs.
 */
export function resolveMcpPrincipal(event: {
  locals?: Record<string, unknown>;
}): McpAppPrincipal | null {
  const user = event.locals?.user as { id?: unknown } | undefined;
  const tenantId = event.locals?.tenantId;
  const permissions = event.locals?.permissions;
  if (typeof user?.id !== 'string' || typeof tenantId !== 'string') return null;
  if (!Array.isArray(permissions) || !permissions.every((value) => typeof value === 'string'))
    return null;
  return {
    id: user.id,
    tenantId,
    kind: 'human',
    scopes: [...permissions].sort(),
  };
}

export const mcpServer = createMcpAppServer({
  smrtOptions: () => ({ db: getApplicationDatabaseConfig() }),
  serverInfo: { name: 'smrt-app', version: '0.1.0' },
  allowedClassNames: ['Item'],
  workflowTools: [itemsOverview],
  resources: [
    {
      uri: ITEM_RESOURCE_URI,
      version: 'v1',
      name: 'Items',
      html: itemResourceHtml,
      csp: {},
      metadata: openAiDisplayMetadata({ availableDisplayModes: ['inline'] }),
    },
  ],
  toolPolicy: ({ principal }) =>
    principal?.kind === 'human' &&
    typeof principal.id === 'string' &&
    typeof principal.tenantId === 'string' &&
    principal.scopes?.includes('items.read') === true,
  resourcePolicy: ({ principal }) =>
    principal?.kind === 'human' &&
    typeof principal.id === 'string' &&
    typeof principal.tenantId === 'string' &&
    principal.scopes?.includes('items.read') === true,
});
