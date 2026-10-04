import type { McpWorkflowToolDefinition } from '@happyvertical/smrt-app-mcp';
import { createHostedMcpResourceAuth } from '@happyvertical/smrt-app-mcp/auth';
import { mountMcpAppRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import { openAiDisplayMetadata, withOpenAiEntrypoints } from '@happyvertical/smrt-mcp-openai';

import { Item } from '$lib/objects/Item';
import { runtime } from '$lib/server/smrt';

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

const { profile } = await runtime.resolvedRuntime();

/**
 * Stateless SDK-v2 Streamable HTTP MCP endpoint for this app's own `Item`.
 * Locally the principal is the signed session (user, authorized tenant, and
 * permission slugs), or an owner-minted bearer token from `smrt app token`
 * for a local MCP client such as the `smrt-mcp-bridge` stdio bridge. Hosted
 * profiles verify a bearer access token and map it through the runtime's
 * membership-backed `resolveMcpPrincipal` (pass `resolvePrincipal` to
 * override it). A bearer principal is bound into the request permission
 * context (under `database-rls`, its own RLS transaction) with its scopes
 * capped to live permissions. Every principal needs `items.read`, so only
 * read-only tools are published until per-operation authorization exists;
 * browser requests from a foreign `Origin` are refused.
 */
export const POST = mountMcpAppRoute({
  models: [Item],
  requiredScopes: ['items.read'],
  effects: ['read'],
  smrtOptions: () => ({ db: runtime.databaseConfig() }),
  auth: createHostedMcpResourceAuth({ profile, runtime }),
  bindPrincipal: runtime.runAsPrincipal,
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
});
