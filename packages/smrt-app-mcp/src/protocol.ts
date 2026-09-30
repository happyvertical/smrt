/** MCP SDK v2 protocol adapter for the framework-neutral app server core. */

import type { MCPTool } from '@happyvertical/smrt-core/generators/mcp';
import {
  type CallToolResult,
  type JSONObject,
  ProtocolError,
  ProtocolErrorCode,
  Server,
  type ServerContext,
  type Tool,
} from '@modelcontextprotocol/server';
import { McpAccessError } from './errors.js';
import type { McpAppPrincipal, McpAppServer } from './server.js';
import { compareMcpToolNames } from './tools.js';

export const MCP_TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

const DEFAULT_TOOL_LIST_CACHE_HINT = {
  ttlMs: 86_400_000,
  cacheScope: 'private' as const,
};

export interface McpProtocolServerOptions {
  /** Resolve the authenticated application principal for each MCP request. */
  principal?:
    | McpAppPrincipal
    | null
    | ((
        context: ServerContext,
      ) => McpAppPrincipal | null | Promise<McpAppPrincipal | null>);
}

/** Request-bound options for asynchronous catalog extension projection. */
export interface McpProtocolRequestOptions {
  principal?: McpAppPrincipal | null;
  /** Optional inert extension metadata, recomputed from this request's authorized catalog. */
  extensions?: (context: {
    principal: McpAppPrincipal | null;
    tools: readonly MCPTool[];
  }) =>
    | Record<string, Record<string, unknown>>
    | Promise<Record<string, Record<string, unknown>>>;
}

/** Prepare native capabilities before the SDK HTTP factory installs discovery handlers. */
export async function createMcpProtocolServerForRequest(
  appServer: McpAppServer,
  options: McpProtocolRequestOptions = {},
): Promise<Server> {
  const principal = options.principal ?? null;
  let extensions: Record<string, JSONObject> = {};
  if (options.extensions) {
    try {
      const tools = await appServer.listTools({ principal });
      const projected = await options.extensions({ principal, tools });
      assertExtensionMetadata(projected);
      if (Object.hasOwn(projected, MCP_TASKS_EXTENSION))
        throw new TypeError('Reserved extension.');
      extensions = structuredClone(projected);
    } catch {
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        'Extension discovery unavailable.',
      );
    }
  }
  return protocolServer(appServer, { principal }, extensions);
}

async function resolvePrincipal(
  option: McpProtocolServerOptions['principal'],
  context: ServerContext,
): Promise<McpAppPrincipal | null> {
  if (typeof option === 'function') return (await option(context)) ?? null;
  return option ?? null;
}

/**
 * Adapt an app MCP core to the SDK v2 low-level server protocol.
 *
 * Transport ownership remains with the caller. In particular, this does not
 * add a production HTTP endpoint; it is safe to compose with `serveStdio` or
 * `createMcpHandler` in a deployment that supplies its own authentication.
 */
export function createMcpProtocolServer(
  appServer: McpAppServer,
  options: McpProtocolServerOptions = {},
): Server {
  if ('extensions' in options) {
    throw new TypeError(
      'Extension discovery requires createMcpProtocolServerForRequest.',
    );
  }
  return protocolServer(appServer, options, {});
}

function protocolServer(
  appServer: McpAppServer,
  options: McpProtocolServerOptions,
  extensions: Record<string, JSONObject>,
): Server {
  // Task lifecycle records are owner-scoped. Unlike ordinary public read-only
  // tools, they cannot be safely exposed without a stable principal id.
  const tasksEnabled =
    appServer.tasksEnabled &&
    typeof options.principal !== 'function' &&
    Boolean(options.principal?.id);
  const server = new Server(appServer.serverInfo, {
    capabilities: {
      tools: {},
      ...(appServer.listResources && appServer.readResource
        ? { resources: {} }
        : {}),
      ...(tasksEnabled || Object.keys(extensions).length
        ? {
            extensions: {
              ...extensions,
              ...(tasksEnabled ? { [MCP_TASKS_EXTENSION]: {} } : {}),
            },
          }
        : {}),
    } as never,
    cacheHints: { 'tools/list': DEFAULT_TOOL_LIST_CACHE_HINT },
  });

  server.setRequestHandler('tools/list', async (_request, context) => {
    const principal = await resolvePrincipal(options.principal, context);
    const cacheHint =
      (await appServer.getToolsListCacheHint?.()) ??
      DEFAULT_TOOL_LIST_CACHE_HINT;
    return {
      tools: [...(await appServer.listTools({ principal }))].sort(
        (left, right) => compareMcpToolNames(left.name, right.name),
      ) as Tool[],
      ...cacheHint,
    };
  });

  if (appServer.listResources && appServer.readResource) {
    server.setRequestHandler('resources/list', async (_request, context) => ({
      resources: await appServer.listResources!({
        principal: await resolvePrincipal(options.principal, context),
      }),
      ttlMs: 0,
      cacheScope: 'private',
    }));
    server.setRequestHandler('resources/read', async (request, context) => {
      try {
        return {
          contents: [
            await appServer.readResource!({
              uri: request.params.uri,
              principal: await resolvePrincipal(options.principal, context),
            }),
          ],
          ttlMs: 0,
          cacheScope: 'private',
        };
      } catch (error) {
        if (error instanceof McpAccessError)
          throw new ProtocolError(
            ProtocolErrorCode.InvalidParams,
            'MCP resource is not available.',
          );
        throw error;
      }
    });
  }

  server.setRequestHandler('tools/call', async (request, context) => {
    try {
      return (await appServer.callTool({
        name: request.params.name,
        arguments: request.params.arguments,
        principal: await resolvePrincipal(options.principal, context),
      })) as CallToolResult;
    } catch (error) {
      if (error instanceof McpAccessError) {
        const { code, retryable } = error.metadata;
        throw new ProtocolError(
          error.status === 404
            ? ProtocolErrorCode.InvalidParams
            : ProtocolErrorCode.InvalidRequest,
          error.message,
          {
            ...(typeof code === 'string' ? { code } : {}),
            ...(typeof retryable === 'boolean' ? { retryable } : {}),
          },
        );
      }
      throw error;
    }
  });

  return server;
}

/** Bound plugin discovery metadata without allowing executable values or provider-specific types. */
function assertExtensionMetadata(
  value: unknown,
): asserts value is Record<string, JSONObject> {
  let budget = 65536;
  const visit = (v: unknown, depth: number): void => {
    if (--budget < 0 || depth > 16)
      throw new TypeError('Extension metadata exceeds limits.');
    if (v === null || typeof v === 'boolean') return;
    if (typeof v === 'number' && Number.isFinite(v)) return;
    if (typeof v === 'string') {
      budget -= new TextEncoder().encode(v).length;
      if (budget < 0) throw new TypeError('Extension metadata exceeds limits.');
      return;
    }
    if (Array.isArray(v)) {
      if (v.length > 1024)
        throw new TypeError('Extension array exceeds limits.');
      for (const item of v) visit(item, depth + 1);
      return;
    }
    if (
      !v ||
      typeof v !== 'object' ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(v))
    )
      throw new TypeError('Expected plain extension object.');
    const names = Object.keys(v);
    if (names.length > 256)
      throw new TypeError('Extension object exceeds limits.');
    for (const name of names) {
      if (['__proto__', 'constructor', 'prototype'].includes(name))
        throw new TypeError('Unsafe extension key.');
      const descriptor = Object.getOwnPropertyDescriptor(v, name);
      if (!descriptor || !('value' in descriptor))
        throw new TypeError('Expected inert extension metadata.');
      visit(name, depth + 1);
      visit(descriptor.value, depth + 1);
    }
  };
  visit(value, 0);
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Expected extension map.');
  for (const [name, entry] of Object.entries(value)) {
    if (
      !name.trim() ||
      !entry ||
      typeof entry !== 'object' ||
      Array.isArray(entry)
    )
      throw new TypeError('Expected named extension object.');
  }
}
