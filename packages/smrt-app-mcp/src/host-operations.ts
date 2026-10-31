/**
 * Host operation tools: one authored definition projected as an MCP workflow
 * tool (server) and a WebMCP tool (browser) without drifting.
 *
 * Browser-safe and dependency-free (type-only imports): the `./host-operations`
 * entry never pulls the MCP server, `jose` or jobs into a client bundle.
 * `@happyvertical/smrt-web` owns `registerWebMcpBespokeTool`; the WebMCP spec
 * built here is structurally identical to its `WebMcpBespokeToolSpec`, so
 * there is no package dependency on it.
 *
 * @packageDocumentation
 */
import type {
  MCPResponse,
  ToolEffect,
  ToolJsonSchema,
} from '@happyvertical/smrt-core/generators/mcp';
import {
  type McpToolErrorInfo,
  type McpToolErrorMapper,
  safeMcpToolError,
} from './errors.js';
import type { McpAppPrincipal } from './server.js';
import type { McpWorkflowToolDefinition } from './workflow-tools.js';

export {
  McpToolError,
  type McpToolErrorInfo,
  type McpToolErrorMapper,
  safeMcpToolError,
} from './errors.js';

/** The part of an operation both projections share; safe for a browser bundle. */
export interface HostOperationDescriptor {
  name: string;
  description: string;
  title?: string;
  /** Required canonical classification; it drives both projections' hints. */
  effect: ToolEffect;
  idempotent: boolean;
  openWorld: boolean;
  inputSchema: ToolJsonSchema;
  outputSchema: ToolJsonSchema;
}

/** Trusted context handed to a host operation handler. */
export interface HostOperationContext {
  /** Tool arguments. Untrusted: validate; never read authority from them. */
  arguments: Record<string, unknown>;
  /** The server-authenticated caller. Tenant, role and user come only from here. */
  principal: McpAppPrincipal | null;
}

/** A host operation: descriptor plus the server-side handler. */
export interface HostOperationToolDefinition<TOutput = unknown>
  extends HostOperationDescriptor {
  handler(context: HostOperationContext): TOutput | Promise<TOutput>;
  /** Map a handler failure to a safe code and message; see `McpToolError`. */
  mapError?: McpToolErrorMapper;
}

/** Validate and freeze a host operation definition. */
export function defineHostOperationTool<TOutput>(
  definition: HostOperationToolDefinition<TOutput>,
): HostOperationToolDefinition<TOutput> {
  if (typeof definition.handler !== 'function') {
    throw new TypeError('Host operation handler must be a function.');
  }
  if (!['read', 'write', 'destructive'].includes(definition.effect)) {
    throw new TypeError(
      'Host operation effect must be read, write, or destructive.',
    );
  }
  if (
    typeof definition.idempotent !== 'boolean' ||
    typeof definition.openWorld !== 'boolean'
  ) {
    throw new TypeError(
      'Host operation idempotent and openWorld must be boolean.',
    );
  }
  if (
    typeof definition.name !== 'string' ||
    !/^[a-z][a-z0-9_]{0,63}$/.test(definition.name)
  ) {
    throw new TypeError(
      'Host operation name must be lowercase snake_case with at most 64 characters.',
    );
  }
  return Object.freeze({ ...definition });
}

function hintsFor(descriptor: HostOperationDescriptor) {
  return {
    readOnlyHint: descriptor.effect === 'read',
    destructiveHint: descriptor.effect === 'destructive',
    idempotentHint: descriptor.idempotent,
    openWorldHint: descriptor.openWorld,
  };
}

/**
 * Execute an operation and resolve a failure to its agent-safe form. Never
 * throws; shared by the MCP projection's error path and by a host's own
 * session endpoint so both surface identical codes.
 */
export async function executeHostOperation<TOutput>(
  definition: HostOperationToolDefinition<TOutput>,
  context: HostOperationContext,
): Promise<
  { ok: true; output: TOutput } | { ok: false; error: McpToolErrorInfo }
> {
  try {
    return { ok: true, output: await definition.handler(context) };
  } catch (error) {
    return { ok: false, error: safeMcpToolError(error, definition.mapError) };
  }
}

function toMcpResponse(output: unknown): MCPResponse {
  const text = JSON.stringify(output ?? null);
  return {
    content: [{ type: 'text', text }],
    structuredContent: output ?? null,
  };
}

/** The definition `createMcpAppServer({ workflowTools })` accepts. */
export function toMcpWorkflowTool(
  definition: HostOperationToolDefinition,
): McpWorkflowToolDefinition {
  return {
    name: definition.name,
    description: definition.description,
    ...(definition.title ? { title: definition.title } : {}),
    inputSchema: definition.inputSchema,
    outputSchema: definition.outputSchema,
    effect: definition.effect,
    idempotent: definition.idempotent,
    openWorld: definition.openWorld,
    async execute(context) {
      return toMcpResponse(await definition.handler(context));
    },
    ...(definition.mapError ? { mapError: definition.mapError } : {}),
  };
}

/** The WebMCP `registerTool` shape (`WebMcpBespokeToolSpec`), structurally. */
export interface HostOperationWebMcpSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
  execute: (
    args: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ) => Promise<string>;
}

/** Invokes a host operation with the signed-in user's own authority. */
export type HostOperationCaller = (
  operation: string,
  args: Record<string, unknown>,
  options?: { signal?: AbortSignal },
) => Promise<unknown>;

/**
 * The WebMCP spec for an operation. Its `execute` calls `caller` (normally
 * {@link createSameOriginSessionCaller}), so the server handler never runs in,
 * or ships to, the browser; pass the descriptor, not the handler.
 */
export function toWebMcpSpec(
  descriptor: HostOperationDescriptor,
  caller: HostOperationCaller,
): HostOperationWebMcpSpec {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema as Record<string, unknown>,
    annotations: hintsFor(descriptor),
    async execute(args, options) {
      const output = await caller(
        descriptor.name,
        args,
        options?.signal ? { signal: options.signal } : undefined,
      );
      return JSON.stringify(output ?? null);
    },
  };
}

/** A failure a host operation endpoint reported, or a transport failure. */
export class HostOperationError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    status = 0,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'HostOperationError';
    this.code = code;
    this.status = status;
    if (details !== undefined) this.details = details;
  }
}

/**
 * Argument keys that name authority. They are never forwarded: tenant, role
 * and user come from the signed-in session on the server, so a model-supplied
 * value is dropped rather than trusted (the server must ignore them too).
 */
const AUTHORITY_KEYS = new Set([
  'tenantid',
  'tenant_id',
  'role',
  'roles',
  'userid',
  'user_id',
  'principal',
  'identity',
  'permissions',
  'scopes',
]);

export interface SameOriginSessionCallerOptions {
  /**
   * The operation endpoint: a same-origin path prefix (`'/api/operations'`,
   * called as `<prefix>/<operation name>`) or a function from the operation
   * name to a same-origin path. No query string or fragment is accepted, so
   * nothing secret travels in a URL.
   */
  url: string | ((operation: string) => string);
  /**
   * Extra request headers per call, e.g. the host's CSRF token header. The
   * credential itself is the browser's session cookie, never a header here.
   */
  headers?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Defaults to `globalThis.location.origin`; only used to vet absolute URLs. */
  origin?: string;
}

function operationUrl(
  options: SameOriginSessionCallerOptions,
  operation: string,
): string {
  const raw =
    typeof options.url === 'function'
      ? options.url(operation)
      : `${options.url.replace(/\/+$/, '')}/${encodeURIComponent(operation)}`;
  const origin =
    options.origin ??
    (globalThis as { location?: { origin?: string } }).location?.origin;
  let path = raw;
  if (!raw.startsWith('/')) {
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new TypeError('Host operation URL must be a same-origin path.');
    }
    if (
      !origin ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    ) {
      throw new TypeError('Host operation URL must be same-origin.');
    }
    path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  }
  if (
    path.startsWith('//') ||
    path.includes('?') ||
    path.includes('#') ||
    path.includes('\\')
  ) {
    throw new TypeError(
      'Host operation URL must be a same-origin path without query or fragment.',
    );
  }
  return path;
}

async function failureFrom(response: Response): Promise<HostOperationError> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = undefined;
  }
  const error = (body as { error?: unknown } | undefined)?.error as
    | { code?: unknown; message?: unknown; details?: unknown }
    | undefined;
  if (
    error &&
    typeof error.code === 'string' &&
    error.code &&
    typeof error.message === 'string'
  ) {
    return new HostOperationError(
      error.code,
      error.message,
      response.status,
      error.details &&
        typeof error.details === 'object' &&
        !Array.isArray(error.details)
        ? (error.details as Record<string, unknown>)
        : undefined,
    );
  }
  return new HostOperationError(
    `host_operation_http_${response.status}`,
    'The operation failed.',
    response.status,
  );
}

/**
 * Browser-side caller that invokes the host's operation endpoint with the
 * signed-in user's own session: `credentials: 'same-origin'`, JSON `POST`
 * `{ arguments }`, optional host CSRF headers. A non-2xx response carrying
 * `{ error: { code, message } }` (the shape `executeHostOperation` yields)
 * is thrown as a {@link HostOperationError}; the success body is returned.
 */
export function createSameOriginSessionCaller(
  options: SameOriginSessionCallerOptions,
): HostOperationCaller {
  return async (operation, args, callOptions) => {
    const url = operationUrl(options, operation);
    const sent: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args ?? {})) {
      if (!AUTHORITY_KEYS.has(key.toLowerCase())) sent[key] = value;
    }
    const extra = (await options.headers?.()) ?? {};
    const doFetch = options.fetch ?? globalThis.fetch;
    let response: Response;
    try {
      response = await doFetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        redirect: 'error',
        headers: {
          ...extra,
          accept: 'application/json',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ arguments: sent }),
        ...(callOptions?.signal ? { signal: callOptions.signal } : {}),
      });
    } catch {
      throw new HostOperationError(
        'host_operation_network_error',
        'The operation could not be reached.',
      );
    }
    if (!response.ok) throw await failureFrom(response);
    if (response.status === 204) return undefined;
    try {
      return await response.json();
    } catch {
      throw new HostOperationError(
        'host_operation_bad_response',
        'The operation returned an unreadable response.',
        response.status,
      );
    }
  };
}
