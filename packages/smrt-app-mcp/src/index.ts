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

export { McpAccessError } from './errors.js';
export {
  type CallToolInput,
  type CreateMcpAppServerOptions,
  createMcpAppServer,
  type ListToolsInput,
  type McpAppServer,
  type McpAppUser,
  type McpPublicToolPatternsThunk,
  type McpSmrtOptionsThunk,
  type McpWorkflowAssertion,
} from './server.js';
export {
  classNamePrefixes,
  isAllowedCoreTool,
  isPublicToolName,
  isReadOnlyToolName,
  matchesToolPattern,
} from './tools.js';
