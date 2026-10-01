/**
 * `@happyvertical/smrt-app-mcp` — app-runtime MCP server scaffolding for
 * SMRT apps. Exposes a SMRT app's MCP surface over HTTP, regardless of how
 * the app is deployed.
 *
 * - **Core** (this module): `createMcpAppServer` wraps
 *   `@happyvertical/smrt-core/generators/mcp` with allow-listing, a public
 *   tool policy, and per-tool workflow assertions. Returns
 *   `{ listTools, callTool }` you can mount however you like.
 *
 * - **SvelteKit** (`@happyvertical/smrt-app-mcp/sveltekit`): thin route
 *   adapters that turn an `McpAppServer` into the GET/POST handlers a
 *   SvelteKit `+server.ts` expects. Additional transport adapters
 *   (standalone Node HTTP, serverless, Express/Hono/Fastify) can be added
 *   as sibling subpaths without changes to the core.
 *
 * For piping a deployed app's MCP surface to a local stdio MCP client
 * (e.g. for editor/AI client integration), see
 * `@happyvertical/smrt-app-cli` — the client-side counterpart owns the
 * stdio bridge.
 *
 * @packageDocumentation
 */

export {
  continueMcpWorkflow,
  createMcpContinuationTool,
  type McpWorkflowContinuation,
} from './continuation.js';
export {
  MCP_TOOL_ACCESS_DENIED_CODE,
  McpAccessError,
  type McpAccessErrorMetadata,
} from './errors.js';
export {
  createMcpProtocolServer,
  type McpProtocolServerOptions,
} from './protocol.js';
export {
  MCP_APP_RESOURCE_MAX_BYTES,
  MCP_APP_RESOURCE_MIME,
  type McpAppResource,
  type McpAppResourceContent,
  type McpAppResourceCsp,
  type McpAppResourceDefinition,
  type McpResourcePolicy,
  prepareMcpAppResource,
} from './resources.js';
export {
  type CallToolInput,
  type CreateMcpAppServerOptions,
  createMcpAppServer,
  type ListToolsInput,
  type McpAppPrincipal,
  type McpAppServer,
  type McpAppUser,
  type McpPublicToolPatternsThunk,
  type McpSmrtOptionsThunk,
  type McpToolListCacheHint,
  type McpToolListCacheOptions,
  type McpToolPolicy,
  type McpToolPolicyContext,
  type McpWorkflowAssertion,
} from './server.js';
export {
  classNamePrefixes,
  isAllowedCoreTool,
  isPublicMcpTool,
  isPublicToolName,
  isReadOnlyToolName,
  matchesToolPattern,
} from './tools.js';
export {
  createMcpWorkflowTool,
  type McpWorkflowTool,
  type McpWorkflowToolContext,
  type McpWorkflowToolDefinition,
  type McpWorkflowToolVisibility,
} from './workflow-tools.js';
