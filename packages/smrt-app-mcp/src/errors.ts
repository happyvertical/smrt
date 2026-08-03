/** Machine-readable code for a principal policy denial. */
export const MCP_TOOL_ACCESS_DENIED_CODE = 'mcp_tool_access_denied';

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
