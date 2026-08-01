/**
 * `createMcpAppServer` returns the framework-agnostic core that backs an
 * app's HTTP MCP endpoints and stdio bridge. It wraps `MCPGenerator` from
 * `@happyvertical/smrt-core` with:
 *
 *  - an allow-list of SMRT class names (so apps publish a subset of their
 *    objects, not everything decorated with `@smrt()`),
 *  - a public-tool policy for unauthenticated callers (read-only patterns
 *    via `publicToolPatterns`),
 *  - an optional principal-aware `toolPolicy`, used for both discovery and
 *    direct calls,
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
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from './errors.js';
import {
  classNamePrefixes,
  isAllowedCoreTool,
  isPublicToolName,
} from './tools.js';

/**
 * Generic authenticated caller information available to app-MCP policy.
 *
 * `kind`, `roles`, and `scopes` are deliberately unconstrained so an app can
 * represent a human or a scoped service without this package encoding an
 * application's identity or capability model. A missing principal means the
 * request is unauthenticated.
 */
export interface McpAppPrincipal {
  id?: string;
  kind?: string;
  roles?: string[];
  scopes?: string[];
}

/** Minimal legacy user shape used for generated tool-call attribution. */
export interface McpAppUser extends McpAppPrincipal {
  id: string;
}

/** Context supplied to the optional per-tool principal policy. */
export interface McpToolPolicyContext {
  principal: McpAppPrincipal | null;
  tool: MCPTool;
}

/**
 * Per-tool access policy. Return `true` to expose/allow the tool and `false`
 * to hide it from discovery and deny a direct call. A thrown error is treated
 * as a denial so policy implementation details cannot escape the app-MCP
 * boundary.
 */
export type McpToolPolicy = (
  context: McpToolPolicyContext,
) => boolean | Promise<boolean>;

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
   * Optional generic principal-aware tool policy. It is evaluated for every
   * tool that passes the app allow-list and base public/authenticated policy,
   * for both discovery and a direct call.
   */
  toolPolicy?: McpToolPolicy;
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
  /** Caller used for public/authenticated and optional tool-policy checks. */
  principal?: McpAppPrincipal | null;
  /**
   * Backwards-compatible authenticated marker. New mounts should pass
   * `principal` so discovery and direct calls use the same identity.
   */
  authenticated?: boolean;
}

/** Tool call inputs. */
export interface CallToolInput {
  name: string;
  arguments?: Record<string, unknown>;
  /** Caller used for public/authenticated and optional tool-policy checks. */
  principal?: McpAppPrincipal | null;
  /**
   * Backwards-compatible user input. New callers should pass `principal`.
   * Null/undefined means unauthenticated.
   */
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
  const toolPolicy = options.toolPolicy;
  const workflowAssertions = options.workflowAssertions ?? {};

  function userForGenerator(
    principal?: McpAppPrincipal | null,
  ): McpAppUser | undefined {
    if (!principal?.id) return undefined;
    return { id: principal.id, roles: principal.roles };
  }

  function makeGenerator(principal?: McpAppPrincipal | null): MCPGenerator {
    const user = userForGenerator(principal);
    return new MCPGenerator(options.serverInfo as MCPConfig, {
      ...options.smrtOptions(),
      user,
    });
  }

  function principalForList(input: ListToolsInput): McpAppPrincipal | null {
    if (input.principal !== undefined) return input.principal;
    // Preserve callers of the original boolean API without inventing an id.
    return input.authenticated ? {} : null;
  }

  function principalForCall(input: CallToolInput): McpAppPrincipal | null {
    if (input.principal !== undefined) return input.principal;
    return input.user ?? null;
  }

  async function allowedTools(): Promise<MCPTool[]> {
    const tools = await makeGenerator().generateTools();
    return tools.filter((tool) =>
      isAllowedCoreTool(tool.name, allowedPrefixes),
    );
  }

  function passesBasePolicy(
    tool: MCPTool,
    principal: McpAppPrincipal | null,
    publicPatterns?: readonly string[],
  ): boolean {
    if (principal) return true;
    return isPublicToolName(tool.name, publicPatterns ?? []);
  }

  async function passesToolPolicy(
    tool: MCPTool,
    principal: McpAppPrincipal | null,
  ): Promise<boolean> {
    if (!toolPolicy) return true;
    try {
      return Boolean(await toolPolicy({ principal, tool }));
    } catch {
      // A policy failure must fail closed and never leak implementation detail.
      return false;
    }
  }

  async function listTools(input: ListToolsInput): Promise<MCPTool[]> {
    const principal = principalForList(input);
    const tools = await allowedTools();
    // Keep the lazy thunk per request, not per tool. Besides avoiding repeated
    // work, this gives one consistent public surface when a thunk reads a
    // dynamic source such as an environment-backed configuration.
    const publicPatterns = principal ? undefined : getPublicPatterns();
    const visible = await Promise.all(
      tools.map(async (tool) => {
        if (!passesBasePolicy(tool, principal, publicPatterns)) return false;
        return passesToolPolicy(tool, principal);
      }),
    );
    return tools.filter((_, index) => visible[index]);
  }

  async function callTool(input: CallToolInput): Promise<MCPResponse> {
    const args = input.arguments ?? {};
    const principal = principalForCall(input);
    const tools = await allowedTools();
    const tool = tools.find((candidate) => candidate.name === input.name);
    if (!tool) {
      throw new McpAccessError(404, `Unknown MCP tool: ${input.name}`);
    }

    const publicPatterns = principal ? undefined : getPublicPatterns();
    if (!passesBasePolicy(tool, principal, publicPatterns)) {
      throw new McpAccessError(
        401,
        `Authentication is required for MCP tool: ${input.name}`,
      );
    }

    if (!(await passesToolPolicy(tool, principal))) {
      throw new McpAccessError(403, 'MCP tool access is not permitted.', {
        code: MCP_TOOL_ACCESS_DENIED_CODE,
        retryable: false,
      });
    }

    const assertion = workflowAssertions[input.name];
    if (assertion) {
      assertion(args, userForGenerator(principal) ?? null);
    }

    return makeGenerator(principal).handleToolCall({
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
