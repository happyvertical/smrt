/** Machine-readable code for a principal policy denial. */
export const MCP_TOOL_ACCESS_DENIED_CODE = 'mcp_tool_access_denied';

/** Machine-readable code for a request refused by the endpoint's origin check. */
export const MCP_ORIGIN_DENIED_CODE = 'mcp_origin_denied';

/**
 * Metadata that is safe to expose for an app-MCP access failure. Policy
 * implementations must not place principal, scope, tool, or internal-error
 * details here.
 */
export interface McpAccessErrorMetadata {
  code?: string;
  retryable?: boolean;
}

/**
 * Error returned by the MCP app server when a caller tries to use a tool
 * they are not allowed to access. The HTTP layer should map `status` onto
 * the response status code.
 */
export class McpAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly metadata: McpAccessErrorMetadata = {},
  ) {
    super(message);
    this.name = 'McpAccessError';
  }
}

/** Stable code for a request naming a tool this server does not publish. */
export const MCP_TOOL_NOT_FOUND_CODE = 'mcp_tool_not_found';

/** Stable code for a tool call that needs an authenticated principal. */
export const MCP_AUTHENTICATION_REQUIRED_CODE = 'mcp_authentication_required';

/** Stable code for an unmapped handler failure; carries no internals. */
export const MCP_TOOL_EXECUTION_FAILED_CODE = 'mcp_tool_execution_failed';

/** The generic message an unmapped handler failure returns. */
export const MCP_TOOL_EXECUTION_FAILED_MESSAGE = 'Workflow execution failed.';

/** The agent-safe projection of a tool failure: a stable code and a message. */
export interface McpToolErrorInfo {
  code: string;
  message: string;
  /** Optional JSON-safe, non-sensitive structured detail. */
  details?: Record<string, unknown>;
}

/**
 * Throw from a workflow tool handler to hand the calling agent a typed,
 * authored failure. The `code` and `message` (and optional `details`) reach
 * the agent verbatim, so they must be safe to disclose: never put records,
 * credentials, stack traces, or other tenants' data in them. Any other
 * thrown value stays behind the generic failure message.
 */
export class McpToolError extends Error {
  readonly code: string;
  readonly details?: Record<string, unknown>;
  constructor(
    code: string,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'McpToolError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

/** Per-tool mapping of a handler failure to a safe code and message. */
export type McpToolErrorMapper = (
  error: unknown,
) => McpToolErrorInfo | null | undefined;

const SAFE_CODE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MAX_SAFE_MESSAGE_LENGTH = 500;
const MAX_SAFE_DETAILS_BYTES = 4096;

const GENERIC_TOOL_ERROR: Readonly<McpToolErrorInfo> = Object.freeze({
  code: MCP_TOOL_EXECUTION_FAILED_CODE,
  message: MCP_TOOL_EXECUTION_FAILED_MESSAGE,
});

function validInfo(value: unknown): McpToolErrorInfo | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const { code, message, details } = value as Record<string, unknown>;
  if (typeof code !== 'string' || !SAFE_CODE.test(code)) return undefined;
  if (
    typeof message !== 'string' ||
    !message.trim() ||
    message.length > MAX_SAFE_MESSAGE_LENGTH
  ) {
    return undefined;
  }
  const info: McpToolErrorInfo = { code, message };
  if (details !== undefined) {
    try {
      if (
        !details ||
        typeof details !== 'object' ||
        Array.isArray(details) ||
        typeof JSON.stringify(details) !== 'string' ||
        JSON.stringify(details).length > MAX_SAFE_DETAILS_BYTES
      ) {
        return undefined;
      }
      info.details = JSON.parse(JSON.stringify(details));
    } catch {
      return undefined;
    }
  }
  return info;
}

/**
 * Resolve a thrown value to the information that may reach an agent. Never
 * throws: a thrown {@link McpToolError} or a valid `mapError` result yields its
 * safe code and message; anything else (including a throwing or malformed
 * mapper) yields the generic failure.
 */
export function safeMcpToolError(
  error: unknown,
  mapError?: McpToolErrorMapper,
): McpToolErrorInfo {
  try {
    if (error instanceof McpToolError) {
      const info = validInfo({
        code: error.code,
        message: error.message,
        details: error.details,
      });
      if (info) return info;
    } else if (mapError) {
      const info = validInfo(mapError(error));
      if (info) return info;
    }
  } catch {
    // A mapper failure falls back to the generic message below.
  }
  return { ...GENERIC_TOOL_ERROR };
}
