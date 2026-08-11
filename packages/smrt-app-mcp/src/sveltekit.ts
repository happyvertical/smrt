/**
 * SvelteKit route adapters for an `McpAppServer`. Mirrors the
 * `@happyvertical/smrt-users/sveltekit` pattern: minimal `HandleInput` type
 * so we never need `@sveltejs/kit` as a real dependency.
 *
 * @packageDocumentation
 *
 * @example
 * ```ts
 * // src/routes/api/mcp/+server.ts
 * import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
 * import { mcpServer } from '$lib/server/mcp';
 * export const POST = mountMcpRoute(mcpServer);
 * ```
 */

import {
  classifyInboundRequest,
  createMcpHandler,
  isJsonContentType,
} from '@modelcontextprotocol/server';
import { McpAccessError } from './errors.js';
import { createMcpProtocolServer, MCP_TASKS_EXTENSION } from './protocol.js';
import type { CallToolInput, McpAppPrincipal, McpAppServer } from './server.js';

/** Minimal subset of a SvelteKit RequestEvent we actually touch. */
type SvelteKitRequestEvent = {
  locals?: Record<string, unknown>;
  request: Request;
  url: URL;
};

/** A SvelteKit `+server.ts` request handler with no SvelteKit dependency. */
export type McpSvelteKitHandler = (
  event: SvelteKitRequestEvent,
) => Promise<Response>;

type ResolvedRequestPrincipal = {
  principal: McpAppPrincipal | null;
  /** Defined only for the legacy discovery-only authentication adapter. */
  legacyAuthenticated?: boolean;
};

/** Locals reader used to pull the request principal out of `event.locals`. */
export type McpPrincipalResolver = (
  event: SvelteKitRequestEvent,
) => McpAppPrincipal | null | undefined;

/** Backwards-compatible alias for callers that name the principal a user. */
export type McpUserResolver = McpPrincipalResolver;

const defaultResolvePrincipal: McpPrincipalResolver = (event) =>
  (event.locals?.user ?? null) as McpAppPrincipal | null;

function resolveRequestPrincipal(
  event: SvelteKitRequestEvent,
  options: MountMcpRouteOptions,
): ResolvedRequestPrincipal {
  const resolvePrincipal =
    options.resolvePrincipal ?? options.resolveUser ?? defaultResolvePrincipal;
  const principal = resolvePrincipal(event) ?? null;
  // Keep the legacy boolean gate for existing apps, but apply it to the same
  // principal that both routes receive. A new principal resolver supersedes it.
  if (
    !options.resolvePrincipal &&
    options.resolveAuthenticated &&
    !options.resolveAuthenticated(event)
  ) {
    return { principal: null, legacyAuthenticated: false };
  }
  return {
    principal,
    ...(options.resolvePrincipal || !options.resolveAuthenticated
      ? {}
      : { legacyAuthenticated: true }),
  };
}

function listToolsInput(resolved: ResolvedRequestPrincipal) {
  // Before principal-aware routes, `resolveAuthenticated` affected discovery
  // independently of `resolveUser`. Preserve a true legacy result only when
  // there is no principal to pass; new routes should use `resolvePrincipal`
  // for a single identity on both discovery and calls.
  if (!resolved.principal && resolved.legacyAuthenticated) {
    return { authenticated: true };
  }
  return { principal: resolved.principal };
}

/** Options shared by both route mounts. */
export interface MountMcpRouteOptions {
  /**
   * Resolve the request principal once for both discovery and direct calls.
   * Defaults to `event.locals.user`.
   */
  resolvePrincipal?: McpPrincipalResolver;
  /**
   * Backwards-compatible alias for `resolvePrincipal`.
   */
  resolveUser?: McpUserResolver;
  /**
   * Deprecated legacy authentication gate. When `resolvePrincipal` is not
   * supplied, a false result makes the principal null for both routes.
   */
  resolveAuthenticated?: (event: SvelteKitRequestEvent) => boolean;
}

function protocolServerForRequest(
  server: McpAppServer,
  resolved: ResolvedRequestPrincipal,
): McpAppServer {
  // Older applications sometimes used a boolean discovery-only adapter. Keep
  // its positive result intact for the deprecated resolver while new mounts
  // consistently use the principal on both MCP methods.
  if (!resolved.legacyAuthenticated || resolved.principal) return server;
  return {
    serverInfo: server.serverInfo,
    listTools: () => server.listTools({ authenticated: true }),
    callTool: (input) => server.callTool(input),
  };
}

/**
 * Mount a modern, stateless Streamable HTTP MCP endpoint as a SvelteKit
 * `POST` handler. The scoped SDK validates the 2026-07-28 envelope plus the
 * required `Mcp-Method` and `Mcp-Name` headers, returning `-32020` on a
 * mismatch. A fresh protocol server is created for each HTTP request, so this
 * route holds neither MCP sessions nor request principal state between nodes.
 */
export function mountMcpRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): McpSvelteKitHandler {
  return async (event) => {
    const resolved = resolveRequestPrincipal(event, options);
    const taskResponse = await maybeHandleTaskRequest(
      server,
      resolved.principal,
      event.request,
    );
    if (taskResponse) return taskResponse;
    const handler = createMcpHandler(
      () =>
        createMcpProtocolServer(protocolServerForRequest(server, resolved), {
          principal: resolved.principal,
        }),
      {
        // The legacy REST-shaped mounts below remain a deprecated migration
        // path. This endpoint accepts only the modern MCP protocol.
        legacy: 'reject',
        // The SDK validates every request before consulting its listen router.
        // Zero capacity keeps this tools-only mount stateless by refusing a
        // listen request before it can open an SSE response.
        maxSubscriptions: 0,
      },
    );
    return handler.fetch(event.request);
  };
}

/**
 * The installed MCP SDK validates tools/call against a pre-Tasks result codec.
 * Intercept the extension before the SDK handler so the regular stateless HTTP
 * protocol stays untouched for every other method.
 */
async function maybeHandleTaskRequest(
  server: McpAppServer,
  principal: McpAppPrincipal | null,
  request: Request,
): Promise<Response | null> {
  if (
    !server.tasksEnabled ||
    !server.callTask ||
    !server.getTask ||
    !server.updateTask ||
    !server.cancelTask ||
    request.method !== 'POST'
  ) {
    return null;
  }
  const body = (await request
    .clone()
    .json()
    .catch(() => null)) as {
    id?: string | number | null;
    jsonrpc?: string;
    method?: string;
    params?: Record<string, unknown>;
  } | null;
  if (body?.jsonrpc !== '2.0' || body.id === undefined) return null;
  const params = body.params ?? {};
  const taskTool =
    body.method === 'tools/call' &&
    typeof params.name === 'string' &&
    (await server.isTaskTool?.(params.name)) === true;
  const taskMethod = ['tasks/get', 'tasks/update', 'tasks/cancel'].includes(
    body.method ?? '',
  );
  if (!taskTool && !taskMethod) return null;

  // Keep task requests on the SDK's protocol-validation path until their
  // 2026 request envelope is known-good. In particular, never enqueue durable
  // work for malformed envelopes, unsupported revisions, or non-JSON bodies.
  // The fallback handler owns its wire-exact error response for those cases.
  if (!isJsonContentType(request.headers.get('content-type'))) return null;
  const classification = classifyInboundRequest({
    httpMethod: request.method,
    protocolVersionHeader:
      request.headers.get('mcp-protocol-version') ?? undefined,
    mcpMethodHeader: request.headers.get('mcp-method') ?? undefined,
    mcpNameHeader: request.headers.get('mcp-name') ?? undefined,
    body: body as never,
  });
  if (classification.kind === 'reject') {
    return jsonRpcResponse(
      body.id,
      undefined,
      {
        code: classification.code,
        message: classification.message,
        ...(classification.data === undefined
          ? {}
          : { data: classification.data }),
      },
      classification.httpStatus,
    );
  }
  if (
    classification.kind !== 'modern' ||
    classification.classification.revision !== '2026-07-28'
  ) {
    return null;
  }

  // The SDK normally performs this modern HTTP routing validation before
  // dispatch. Task responses are intercepted ahead of that SDK handler, so
  // retain the same fail-closed header/body contract here.
  const headerMismatch = taskHeaderMismatch(request, body.method, params);
  if (headerMismatch) {
    return jsonRpcResponse(body.id, undefined, headerMismatch, 400);
  }

  const clientCapabilities = asRecord(params._meta)[
    'io.modelcontextprotocol/clientCapabilities'
  ];
  const clientSupportsTasks = Object.hasOwn(
    asRecord(asRecord(clientCapabilities).extensions),
    MCP_TASKS_EXTENSION,
  );

  // A synchronous fallback exists for tools/call; lifecycle methods do not.
  if (!clientSupportsTasks && body.method === 'tools/call') return null;
  if (!clientSupportsTasks) {
    return jsonRpcResponse(
      body.id,
      undefined,
      {
        code: -32021,
        message: 'Missing required client capability',
        data: {
          requiredCapabilities: { extensions: { [MCP_TASKS_EXTENSION]: {} } },
        },
      },
      400,
    );
  }

  try {
    if (body.method === 'tools/call') {
      const result = await server.callTask({
        name: params.name as string,
        arguments: (params.arguments as Record<string, unknown>) ?? {},
        principal,
      });
      return jsonRpcResponse(body.id, result);
    }
    if (typeof params.taskId !== 'string') {
      return jsonRpcResponse(body.id, undefined, {
        code: -32602,
        message: 'taskId is required',
      });
    }
    if (body.method === 'tasks/get') {
      const task = await server.getTask({ taskId: params.taskId, principal });
      return jsonRpcResponse(body.id, { resultType: 'complete', ...task });
    }
    if (body.method === 'tasks/update') {
      await server.updateTask({
        taskId: params.taskId,
        inputResponses:
          params.inputResponses && typeof params.inputResponses === 'object'
            ? (params.inputResponses as Record<string, unknown>)
            : {},
        principal,
      });
      return jsonRpcResponse(body.id, { resultType: 'complete' });
    }
    await server.cancelTask({ taskId: params.taskId, principal });
    return jsonRpcResponse(body.id, { resultType: 'complete' });
  } catch (error) {
    if (error instanceof McpAccessError) {
      const { code, retryable } = error.metadata;
      return jsonRpcResponse(body.id, undefined, {
        code: error.status === 404 ? -32602 : -32600,
        message: error.message,
        data: {
          ...(typeof code === 'string' ? { code } : {}),
          ...(typeof retryable === 'boolean' ? { retryable } : {}),
        },
      });
    }
    const message =
      error instanceof Error ? error.message : 'Task operation failed';
    return jsonRpcResponse(body.id, undefined, { code: -32602, message });
  }
}

function taskHeaderMismatch(
  request: Request,
  method: string | undefined,
  params: Record<string, unknown>,
): { code: number; message: string } | undefined {
  if (
    !method ||
    normalizeHeaderValue(request.headers.get('mcp-method') ?? '') !== method
  ) {
    return {
      code: -32020,
      message: 'Mcp-Method header must match the JSON-RPC method.',
    };
  }
  const toolName =
    method === 'tools/call' && typeof params.name === 'string'
      ? params.name
      : undefined;
  const headerName = request.headers.get('mcp-name');
  if (
    toolName !== undefined &&
    (headerName === null || decodeMcpHeaderValue(headerName) !== toolName)
  ) {
    return {
      code: -32020,
      message: 'Mcp-Name header must match the tools/call name.',
    };
  }
  return undefined;
}

/** Match the SDK's RFC 9110 optional-whitespace handling for MCP headers. */
function normalizeHeaderValue(value: string): string {
  return value.replace(/^[\t ]+|[\t ]+$/g, '');
}

/** Decode the SDK's canonical Base64 sentinel for an MCP header value. */
function decodeMcpHeaderValue(value: string): string | undefined {
  const normalized = normalizeHeaderValue(value);
  const prefix = '=?base64?';
  if (!normalized.startsWith(prefix) || !normalized.endsWith('?=')) {
    return normalized;
  }
  const encoded = normalized.slice(prefix.length, -2);
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded,
    )
  ) {
    return undefined;
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
    );
  } catch {
    return undefined;
  }
}

function jsonRpcResponse(
  id: string | number | null,
  result?: unknown,
  error?: { code: number; message: string; data?: unknown },
  status = 200,
): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id, ...(error ? { error } : { result }) }),
    { status, headers: { 'content-type': 'application/json' } },
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Mount `server.listTools` as a `GET` handler. Returns the tool list shape
 * `{ tools }` for compatibility with the stock MCP bridge.
 *
 * @deprecated Use {@link mountMcpRoute}. Existing REST-shaped mounts can use
 * this compatibility alias while migrating without a coordinated cutover.
 */
export function mountMcpToolsRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): McpSvelteKitHandler {
  return async (event) => {
    try {
      const tools = await server.listTools(
        listToolsInput(resolveRequestPrincipal(event, options)),
      );
      return jsonResponse({ tools });
    } catch (error) {
      if (error instanceof McpAccessError) {
        return jsonResponse(mcpAccessErrorBody(error), error.status);
      }
      throw error;
    }
  };
}

/**
 * Mount `server.callTool` as a `POST` handler that expects
 * `{ name, arguments }` in the JSON body.
 *
 * @deprecated Use {@link mountMcpRoute}. Existing REST-shaped mounts can use
 * this compatibility alias while migrating without a coordinated cutover.
 */
export function mountMcpCallRoute(
  server: McpAppServer,
  options: MountMcpRouteOptions = {},
): McpSvelteKitHandler {
  return async (event) => {
    const body = (await event.request.json().catch(() => null)) as {
      arguments?: Record<string, unknown>;
      name?: string;
    } | null;

    if (!body?.name) {
      return jsonResponse({ error: 'name is required.' }, 400);
    }

    const input: CallToolInput = {
      arguments: body.arguments ?? {},
      name: body.name,
      principal: resolveRequestPrincipal(event, options).principal,
    };

    try {
      return jsonResponse(await server.callTool(input));
    } catch (error) {
      if (error instanceof McpAccessError) {
        return jsonResponse(mcpAccessErrorBody(error), error.status);
      }
      throw error;
    }
  };
}

function mcpAccessErrorBody(error: McpAccessError): unknown {
  const { code, retryable } = error.metadata;
  // Preserve the legacy shape unless an error deliberately opts into the
  // shared structured failure contract.
  if (!code) return { error: error.message };
  return {
    error: {
      ok: false,
      code,
      message: error.message,
      status: error.status,
      ...(retryable === undefined ? {} : { retryable }),
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

export { McpAccessError } from './errors.js';
export type { McpAppPrincipal, McpAppServer } from './server.js';
