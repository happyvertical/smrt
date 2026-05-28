/**
 * `createMcpAppServer` returns the framework-agnostic core that backs an
 * app's HTTP MCP endpoints and stdio bridge. It wraps `MCPGenerator` from
 * `@happyvertical/smrt-core` with:
 *
 *  - an allow-list of SMRT class names (so apps publish a subset of their
 *    objects, not everything decorated with `@smrt()`),
 *  - a public-tool policy for unauthenticated callers (read-only patterns
 *    via `publicToolPatterns`),
 *  - a pluggable `workflowAssertions` hook so apps can guard their own
 *    domain-specific tool calls (e.g. "approval requires an authenticated
 *    user") without that policy living in this package.
 *
 * @packageDocumentation
 */

import type {
  MCPConfig,
  MCPResponse,
  MCPTool,
} from '@happyvertical/smrt-core/generators/mcp';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { McpAccessError } from './errors.js';
import {
  classNamePrefixes,
  isAllowedCoreTool,
  isPublicToolName,
} from './tools.js';

/** Minimal user shape used for tool-call attribution. */
export interface McpAppUser {
  id: string;
  roles?: string[];
}

/**
 * Workflow assertion hook signature. Throw `McpAccessError` to reject the
 * call. Implementations may mutate `args` in place to inject server-trusted
 * fields (e.g. clamping `approvedByUserId` to the authenticated user's id).
 */
export type McpWorkflowAssertion = (
  args: Record<string, unknown>,
  user: McpAppUser | null,
) => void;

/**
 * SMRT options thunk — returns the `{ db }` (and similar) bag to pass into
 * MCPGenerator's per-request context. A function is used so apps can lazily
 * resolve env vars at call time.
 */
export type McpSmrtOptionsThunk = () => Record<string, unknown>;

/** Public-tool patterns thunk — same lazy-evaluation rationale. */
export type McpPublicToolPatternsThunk = () => readonly string[];

/**
 * Options for `createMcpAppServer`.
 */
export interface CreateMcpAppServerOptions {
  /** SMRT context bag (db, etc.) passed to MCPGenerator per call. */
  smrtOptions: McpSmrtOptionsThunk;
  /** Server identity surfaced in the MCP protocol. */
  serverInfo: Required<Pick<MCPConfig, 'name' | 'version'>> &
    Pick<MCPConfig, 'description'>;
  /**
   * SMRT class names the app wants to publish. Tools whose name does not
   * start with any of these classes (lowercased + underscore) are filtered
   * out, even if SMRT generated them.
   */
  allowedClassNames: readonly string[];
  /**
   * Optional thunk returning glob-ish patterns for read-only tools that
   * unauthenticated callers are allowed to use. Defaults to an empty list
   * (everything requires auth).
   */
  publicToolPatterns?: McpPublicToolPatternsThunk;
  /**
   * Optional per-tool guards. Keyed by tool name. The assertion runs after
   * tool resolution and before `MCPGenerator.handleToolCall`; throwing
   * `McpAccessError` aborts the call with the error's status. Implementations
   * may mutate `args` to inject trusted fields.
   */
  workflowAssertions?: Record<string, McpWorkflowAssertion>;
}

/** Tool listing inputs. */
export interface ListToolsInput {
  /** Whether the calling principal is authenticated. */
  authenticated: boolean;
}

/** Tool call inputs. */
export interface CallToolInput {
  name: string;
  arguments?: Record<string, unknown>;
  /** Authenticated user; null/undefined means unauthenticated. */
  user?: McpAppUser | null;
}

/** Shape returned by `createMcpAppServer`. */
export interface McpAppServer {
  listTools(input: ListToolsInput): Promise<MCPTool[]>;
  callTool(input: CallToolInput): Promise<MCPResponse>;
  /** Read-only view of the configured server identity. */
  readonly serverInfo: CreateMcpAppServerOptions['serverInfo'];
}

/**
 * Build the app-runtime MCP server core. The returned object is intentionally
 * framework-agnostic: HTTP wrappers live in `@happyvertical/smrt-app-mcp/sveltekit`
 * and a stdio bridge lives in `@happyvertical/smrt-app-mcp/bin/smrt-mcp-bridge`.
 */
export function createMcpAppServer(
  options: CreateMcpAppServerOptions,
): McpAppServer {
  const allowedPrefixes = classNamePrefixes(options.allowedClassNames);
  const getPublicPatterns =
    options.publicToolPatterns ?? ((): readonly string[] => []);
  const workflowAssertions = options.workflowAssertions ?? {};

  function makeGenerator(user?: McpAppUser | null): MCPGenerator {
    return new MCPGenerator(options.serverInfo as MCPConfig, {
      ...options.smrtOptions(),
      user: user?.id ? { id: user.id, roles: user.roles } : undefined,
    });
  }

  async function listTools(input: ListToolsInput): Promise<MCPTool[]> {
    const tools = await makeGenerator().generateTools();
    const allowed = tools.filter((tool) =>
      isAllowedCoreTool(tool.name, allowedPrefixes),
    );
    if (input.authenticated) return allowed;
    const patterns = getPublicPatterns();
    return allowed.filter((tool) => isPublicToolName(tool.name, patterns));
  }

  async function callTool(input: CallToolInput): Promise<MCPResponse> {
    const args = input.arguments ?? {};
    const user = input.user ?? null;
    const tools = await listTools({ authenticated: true });
    if (!tools.some((tool) => tool.name === input.name)) {
      throw new McpAccessError(404, `Unknown MCP tool: ${input.name}`);
    }

    if (!user && !isPublicToolName(input.name, getPublicPatterns())) {
      throw new McpAccessError(
        401,
        `Authentication is required for MCP tool: ${input.name}`,
      );
    }

    const assertion = workflowAssertions[input.name];
    if (assertion) {
      assertion(args, user);
    }

    return makeGenerator(user).handleToolCall({
      method: 'tools/call',
      params: { arguments: args, name: input.name },
    });
  }

  return {
    listTools,
    callTool,
    serverInfo: options.serverInfo,
  };
}
