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

import {
  isTenantScopedClassResolved,
  ObjectRegistry,
} from '@happyvertical/smrt-core';
import type {
  MCPConfig,
  MCPResponse,
  MCPTool,
} from '@happyvertical/smrt-core/generators/mcp';
import {
  MCP_STABLE_CATALOG_TTL_MS,
  MCPGenerator,
} from '@happyvertical/smrt-core/generators/mcp';
import {
  type McpTask,
  McpTaskNotFoundError,
  McpTaskStore,
} from '@happyvertical/smrt-jobs';
import type { DatabaseInterface } from '@happyvertical/sql';
import { MCP_TOOL_ACCESS_DENIED_CODE, McpAccessError } from './errors.js';
import {
  classNamePrefixes,
  compareMcpToolNames,
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
  /** Tenant boundary for task ownership and generated tenant-scoped actions. */
  tenantId?: string;
  /** Trusted operator override for generated tenant-scoped actions. */
  allowCrossTenant?: boolean;
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

export interface McpToolListCacheHint {
  ttlMs: number;
  cacheScope: 'private' | 'public';
}

export interface McpToolListCacheOptions {
  /** Cache lifetime in milliseconds. Defaults to one day for a deploy-static catalog. */
  ttlMs?: number;
  /** Requested cache visibility. Defaults to private. */
  cacheScope?: 'private' | 'public';
  /**
   * Explicit attestation that every allowed tool is global, unauthenticated,
   * and safe to share through an intermediary cache.
   */
  publicCatalog?: true;
}

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
   * Cache policy for the MCP tools/list result. Public caching is honored only
   * when this explicitly opts in and every allowed tool is a non-tenant,
   * unauthenticated read-only tool with no principal-aware policy.
   */
  toolListCache?: McpToolListCacheOptions;
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
  /** Whether this app has any explicitly enabled Tasks extension action. */
  hasTaskSupport?(): Promise<boolean>;
  /** Whether a particular visible tool is task-enabled. */
  isTaskTool?(name: string): Promise<boolean>;
  /** Static declaration used by the protocol discovery capability surface. */
  readonly tasksEnabled?: boolean;
  /** Create a durable task after applying the same tool policy as tools/call. */
  callTask?(input: CallToolInput): Promise<MCPResponse>;
  /** Principal-scoped task lifecycle operations. */
  getTask?(input: {
    taskId: string;
    principal?: McpAppPrincipal | null;
  }): Promise<McpTask>;
  updateTask?(input: {
    taskId: string;
    inputResponses: Record<string, unknown>;
    principal?: McpAppPrincipal | null;
  }): Promise<void>;
  cancelTask?(input: {
    taskId: string;
    principal?: McpAppPrincipal | null;
  }): Promise<void>;
  /** Cache policy for protocol tools/list responses. */
  getToolsListCacheHint?(): Promise<McpToolListCacheHint>;
  /** Read-only view of the configured server identity. */
  readonly serverInfo: CreateMcpAppServerOptions['serverInfo'];
}

function configuredToolListCacheHint(
  options: McpToolListCacheOptions | undefined,
): McpToolListCacheHint {
  const ttlMs = options?.ttlMs ?? MCP_STABLE_CATALOG_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0) {
    throw new RangeError(
      'MCP tools/list cache ttlMs must be a non-negative safe integer.',
    );
  }
  if (
    options?.cacheScope !== undefined &&
    options.cacheScope !== 'private' &&
    options.cacheScope !== 'public'
  ) {
    throw new RangeError(
      "MCP tools/list cacheScope must be 'private' or 'public'.",
    );
  }
  return {
    ttlMs,
    cacheScope:
      options?.cacheScope === 'public' && options.publicCatalog === true
        ? 'public'
        : 'private',
  };
}

function isTenantScopedTool(tool: MCPTool): boolean {
  const separator = tool.name.indexOf('_');
  if (separator <= 0) return false;
  const objectName = tool.name.slice(0, separator).toLowerCase();
  for (const [key, classInfo] of ObjectRegistry.getAllClasses()) {
    const name = classInfo.name || key;
    if (name.toLowerCase() === objectName) {
      return (
        ObjectRegistry.isTenantScoped(name) || isTenantScopedClassResolved(name)
      );
    }
  }
  return false;
}

/**
 * Scope task lookup to both the authenticated principal and its tenant. The
 * opaque value is stored in the existing job row, so no separate task table
 * can accidentally bypass a tenant boundary.
 */
function taskOwnerIdFor(principal: McpAppPrincipal): string {
  return JSON.stringify([principal.tenantId ?? null, principal.id]);
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
  const requestedToolListCacheHint = configuredToolListCacheHint(
    options.toolListCache,
  );
  const tasksEnabled = options.allowedClassNames.some((className) => {
    const mcp = ObjectRegistry.getConfig(className).mcp;
    return (
      typeof mcp === 'object' &&
      (mcp.tasks === true || (Array.isArray(mcp.tasks) && mcp.tasks.length > 0))
    );
  });

  function userForGenerator(
    principal?: McpAppPrincipal | null,
  ): McpAppUser | undefined {
    if (!principal?.id) return undefined;
    return { id: principal.id, roles: principal.roles };
  }

  async function taskStoreFor(
    principal?: McpAppPrincipal | null,
  ): Promise<McpTaskStore> {
    if (!principal?.id) {
      throw new McpAccessError(
        401,
        'Authentication is required for MCP tasks.',
      );
    }
    const db = options.smrtOptions().db as DatabaseInterface | undefined;
    if (!db) {
      throw new Error('MCP Tasks requires smrtOptions() to provide a database');
    }
    return McpTaskStore.create(db, { ownerId: taskOwnerIdFor(principal) });
  }

  function makeGenerator(
    principal?: McpAppPrincipal | null,
    taskStore?: McpTaskStore,
  ): MCPGenerator {
    const user = userForGenerator(principal);
    return new MCPGenerator(options.serverInfo as MCPConfig, {
      ...options.smrtOptions(),
      user,
      tenantId: principal?.tenantId,
      allowCrossTenant: principal?.allowCrossTenant,
      ...(taskStore ? { taskStore } : {}),
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
    return tools
      .filter((tool) =>
        isAllowedCoreTool(tool.name.toLowerCase(), allowedPrefixes),
      )
      .sort((left, right) => compareMcpToolNames(left.name, right.name));
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

  async function getToolsListCacheHint(): Promise<McpToolListCacheHint> {
    if (requestedToolListCacheHint.cacheScope !== 'public') {
      return requestedToolListCacheHint;
    }

    // A principal-aware policy can make one caller's catalog differ from
    // another's. Likewise, tenant-scoped reads must never be shared across
    // tenants. The requested public scope is therefore honored only for a
    // complete, unauthenticated, non-tenant read-only catalog.
    const tools = await allowedTools();
    const publicPatterns = getPublicPatterns();
    const isSafePublicCatalog =
      !toolPolicy &&
      tools.every(
        (tool) =>
          isPublicToolName(tool.name, publicPatterns) &&
          !isTenantScopedTool(tool),
      );

    return isSafePublicCatalog
      ? requestedToolListCacheHint
      : { ...requestedToolListCacheHint, cacheScope: 'private' };
  }

  async function callTool(input: CallToolInput): Promise<MCPResponse> {
    const args = input.arguments ?? {};
    const principal = principalForCall(input);
    const tools = await allowedTools();
    const tool = tools.find((candidate) => candidate.name === input.name);
    if (!tool) {
      throw new McpAccessError(404, 'Unknown MCP tool.');
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

  async function authorizeCall(input: CallToolInput): Promise<{
    args: Record<string, unknown>;
    principal: McpAppPrincipal | null;
    tool: MCPTool;
  }> {
    const args = input.arguments ?? {};
    const principal = principalForCall(input);
    const tools = await allowedTools();
    const tool = tools.find((candidate) => candidate.name === input.name);
    if (!tool) throw new McpAccessError(404, 'Unknown MCP tool.');
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
    if (assertion) assertion(args, userForGenerator(principal) ?? null);
    return { args, principal, tool };
  }

  async function hasTaskSupport(): Promise<boolean> {
    const tools = await allowedTools();
    const generator = makeGenerator();
    for (const tool of tools) {
      if (await generator.supportsTaskTool(tool.name)) return true;
    }
    return false;
  }

  async function isTaskTool(name: string): Promise<boolean> {
    const tools = await allowedTools();
    if (!tools.some((tool) => tool.name === name)) return false;
    return makeGenerator().supportsTaskTool(name);
  }

  async function callTask(input: CallToolInput): Promise<MCPResponse> {
    const { args, principal } = await authorizeCall(input);
    const taskStore = await taskStoreFor(principal);
    return makeGenerator(principal, taskStore).createTask({
      method: 'tools/call',
      params: { arguments: args, name: input.name },
    });
  }

  async function withTaskStore<T>(
    principal: McpAppPrincipal | null | undefined,
    operation: (store: McpTaskStore) => Promise<T>,
  ): Promise<T> {
    try {
      return await operation(await taskStoreFor(principal));
    } catch (error) {
      if (error instanceof McpTaskNotFoundError) {
        throw new McpAccessError(404, 'Unknown MCP task.');
      }
      throw error;
    }
  }

  async function getTask(input: {
    taskId: string;
    principal?: McpAppPrincipal | null;
  }): Promise<McpTask> {
    return withTaskStore(input.principal, (store) =>
      store.getTask(input.taskId),
    );
  }

  async function updateTask(input: {
    taskId: string;
    inputResponses: Record<string, unknown>;
    principal?: McpAppPrincipal | null;
  }): Promise<void> {
    await withTaskStore(input.principal, (store) =>
      store.updateTask(input.taskId, input.inputResponses),
    );
  }

  async function cancelTask(input: {
    taskId: string;
    principal?: McpAppPrincipal | null;
  }): Promise<void> {
    await withTaskStore(input.principal, (store) =>
      store.cancelTask(input.taskId),
    );
  }

  return {
    listTools,
    callTool,
    hasTaskSupport,
    isTaskTool,
    callTask,
    getTask,
    updateTask,
    cancelTask,
    tasksEnabled,
    getToolsListCacheHint,
    serverInfo: options.serverInfo,
  };
}
