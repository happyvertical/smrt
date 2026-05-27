/**
 * `@happyvertical/smrt-app-mcp` — app-runtime MCP server scaffolding for
 * SMRT apps.
 *
 * Three layers:
 *
 * - **Core** (this module): `createMcpAppServer` wraps
 *   `@happyvertical/smrt-core/generators/mcp` with allow-listing, a public
 *   tool policy, and per-tool workflow assertions. Returns
 *   `{ listTools, callTool }` you can mount however you like.
 *
 * - **SvelteKit** (`@happyvertical/smrt-app-mcp/sveltekit`): thin route
 *   adapters that turn an `McpAppServer` into the GET/POST handlers a
 *   SvelteKit `+server.ts` expects.
 *
 * - **Stdio bridge** (`@happyvertical/smrt-app-mcp/bin/smrt-mcp-bridge`):
 *   a generic CLI that exposes a remote app's MCP surface as a local stdio
 *   MCP server (so editors and AI clients can connect to it). Configure via
 *   `--env-prefix=APP` and the app's CLI config file.
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
