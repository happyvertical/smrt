/**
 * Error returned by the MCP app server when a caller tries to use a tool
 * they are not allowed to access. The HTTP layer should map `status` onto
 * the response status code.
 */
export class McpAccessError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'McpAccessError';
  }
}
