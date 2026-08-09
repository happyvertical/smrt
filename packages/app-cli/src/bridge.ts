/**
 * Stdio MCP bridge — pipes a remote SMRT app's HTTP MCP surface
 * (`/api/mcp/tools` + `/api/mcp/call`) to a local stdio MCP server so that
 * editors and AI clients can connect to it.
 *
 * Apps wire this up by providing their own bin script:
 *
 * ```ts
 * #!/usr/bin/env node
 * import { runMcpStdioBridge } from '@happyvertical/smrt-app-cli';
 * await runMcpStdioBridge({
 *   envPrefix: 'WILLGRIFFIN',
 *   serverInfo: { name: 'willgriffin-mcp', version: '0.1.0' },
 * });
 * ```
 *
 * The package also ships a `smrt-mcp-bridge` bin (see `bin/smrt-mcp-bridge`)
 * that reads `--env-prefix=…` from argv for ad-hoc use without writing a
 * package-specific entry point.
 *
 * @packageDocumentation
 */

import { SMRT_MCP_RESULT_METADATA_KEY as APP_CONTRACT_MCP_RESULT_METADATA_KEY } from '@happyvertical/smrt-users/app-contract';
import {
  type CallToolRequest,
  type CallToolResult,
  type ListToolsRequest,
  type ListToolsResult,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from '@modelcontextprotocol/server';
import {
  StdioServerTransport,
  serveStdio,
} from '@modelcontextprotocol/server/stdio';
import {
  type AppCliResultMetadata,
  type CliConfigContext,
  type RequestJsonResult,
  redactTransportValue,
  requestJsonResult,
} from './config.js';

/** Namespace shared with the published SMRT app-result contract. */
export { SMRT_MCP_RESULT_METADATA_KEY } from '@happyvertical/smrt-users/app-contract';

const MCP_STABLE_CATALOG_TTL_MS = 86_400_000;
const PRIVATE_TOOL_LIST_CACHE_HINT = {
  ttlMs: MCP_STABLE_CATALOG_TTL_MS,
  cacheScope: 'private' as const,
};

function compareToolNames(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Configuration for the bridge.
 *
 * Combines the {@link CliConfigContext} (env var + config file resolution)
 * with the local MCP server identity the bridge advertises to clients.
 */
export interface McpStdioBridgeOptions extends CliConfigContext {
  /** MCP server identity advertised to local clients. */
  serverInfo: {
    name: string;
    version: string;
  };
  /** Override the tools endpoint path. Defaults to `/api/mcp/tools`. */
  toolsPath?: string;
  /** Override the call endpoint path. Defaults to `/api/mcp/call`. */
  callPath?: string;
  /**
   * Override fetch implementation (used by tests so we never hit the network).
   */
  fetch?: typeof fetch;
}

/**
 * Wire up the stdio server. Use `runMcpStdioBridge` for a one-call entry
 * point in `bin/` scripts; this lower-level form is exposed for tests.
 */
export function createMcpStdioBridge(options: McpStdioBridgeOptions): {
  server: Server;
  connect: () => Promise<void>;
} {
  const toolsPath = options.toolsPath ?? '/api/mcp/tools';
  const callPath = options.callPath ?? '/api/mcp/call';

  const server = new Server(options.serverInfo, {
    capabilities: { tools: {} },
    cacheHints: { 'tools/list': PRIVATE_TOOL_LIST_CACHE_HINT },
  });

  server.setRequestHandler(
    'tools/list',
    async (_request: ListToolsRequest): Promise<ListToolsResult> => {
      const outcome = await requestJsonResult<ListToolsResult>(
        options,
        toolsPath,
        { method: 'GET' },
        { fetch: options.fetch },
      );
      if (!outcome.ok) throw toMcpTransportError(outcome.error);
      const result = withMcpMetadata(outcome.result, outcome.metadata);
      return {
        ...result,
        tools: [...result.tools].sort((left, right) =>
          compareToolNames(left.name, right.name),
        ),
        ...PRIVATE_TOOL_LIST_CACHE_HINT,
      };
    },
  );

  server.setRequestHandler(
    'tools/call',
    async (request: CallToolRequest): Promise<CallToolResult> => {
      const { name, arguments: args = {} } = request.params;
      const outcome = await requestJsonResult<CallToolResult>(
        options,
        callPath,
        {
          body: JSON.stringify({ arguments: args, name }),
          method: 'POST',
        },
        { fetch: options.fetch },
      );
      return formatMcpCallResult(outcome);
    },
  );

  return {
    server,
    connect: () => server.connect(new StdioServerTransport()),
  };
}

/**
 * Preserve the HTTP result/error envelope in protocol-permitted MCP metadata.
 * This deliberately does not create `structuredContent`; #2149 owns declared
 * output schema semantics for generated tools.
 */
export function formatMcpCallResult(
  outcome: RequestJsonResult<CallToolResult>,
): CallToolResult {
  if (!outcome.ok) {
    const error = sanitizeMetadata(outcome.error);
    return withMcpMetadata(
      {
        content: [
          {
            text: error.message ?? error.code,
            type: 'text',
          },
        ],
        isError: true,
      },
      error,
    );
  }

  const metadata = isMcpErrorResult(outcome.result)
    ? {
        ...outcome.metadata,
        code:
          outcome.metadata.code === 'ok'
            ? 'mcp_tool_error'
            : outcome.metadata.code,
        message: outcome.metadata.message ?? resultText(outcome.result),
      }
    : outcome.metadata;
  return withMcpMetadata(
    isMcpErrorResult(outcome.result)
      ? redactMcpErrorContent(outcome.result)
      : outcome.result,
    metadata,
  );
}

function withMcpMetadata<T extends object>(
  result: T,
  metadata: AppCliResultMetadata,
): T {
  const existing = isRecord((result as { _meta?: unknown })._meta)
    ? (result as { _meta: Record<string, unknown> })._meta
    : {};
  return {
    ...result,
    _meta: {
      ...existing,
      [APP_CONTRACT_MCP_RESULT_METADATA_KEY]: sanitizeMetadata(metadata),
    },
  } as T;
}

function sanitizeMetadata(
  metadata: AppCliResultMetadata,
): AppCliResultMetadata {
  return {
    ...metadata,
    ...(metadata.message
      ? { message: String(redactTransportValue(metadata.message)) }
      : {}),
    ...(metadata.details !== undefined
      ? {
          details: redactTransportValue(
            metadata.details,
          ) as AppCliResultMetadata['details'],
        }
      : {}),
    ...(metadata.correlationId
      ? { correlationId: String(redactTransportValue(metadata.correlationId)) }
      : {}),
  };
}

/** Convert an HTTP transport failure into an MCP JSON-RPC error safely. */
export function toMcpTransportError(
  metadata: AppCliResultMetadata,
): ProtocolError {
  const sanitized = sanitizeMetadata(metadata);
  return new ProtocolError(
    ProtocolErrorCode.InternalError,
    sanitized.message ?? sanitized.code,
    { [APP_CONTRACT_MCP_RESULT_METADATA_KEY]: sanitized },
  );
}

function isMcpErrorResult(result: CallToolResult): boolean {
  return (result as { isError?: unknown }).isError === true;
}

function resultText(result: CallToolResult): string | undefined {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return undefined;
  const text = content.find(
    (entry): entry is { text: string } =>
      isRecord(entry) && typeof entry.text === 'string',
  );
  return text?.text;
}

function redactMcpErrorContent(result: CallToolResult): CallToolResult {
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return result;
  return {
    ...result,
    content: content.map((entry) =>
      isRecord(entry) && typeof entry.text === 'string'
        ? { ...entry, text: String(redactTransportValue(entry.text)) }
        : entry,
    ),
  } as CallToolResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One-call entry point — start the factory-owned stdio bridge. The returned
 * promise resolves once the stdio listener is installed.
 */
export async function runMcpStdioBridge(
  options: McpStdioBridgeOptions,
): Promise<void> {
  serveStdio(() => createMcpStdioBridge(options).server);
}
