/**
 * Transport kernel: MCP adapter (#5158). Owned by K7; argument validation is
 * switched on here by F9 and nowhere else.
 */
import type { ToolJsonSchema } from '../generators/tool-schema.js';
import { notImplemented } from './not-implemented.js';
import type { McpRuntimeOptions, McpToolRuntime } from './types.js';

/**
 * Check tool arguments against the schema the tool advertised.
 *
 * Contract:
 * - Supports exactly the vocabulary the tool-schema builders emit; a schema
 *   using anything else is a generation error, not a runtime surprise.
 * - Arguments must be a plain record. Unknown properties are refused where
 *   the schema closes them. No coercion: a number is not accepted for a string
 *   identifier.
 * - Returns a new record holding only validated own properties.
 * - Fails with `VALIDATION_INVALID_ARGUMENT` naming the argument, never its
 *   value.
 */
export function validateToolArguments(
  _schema: ToolJsonSchema,
  _args: unknown,
): Record<string, unknown> {
  return notImplemented('validateToolArguments', 'K7');
}

/**
 * Build the tool-call runtime shared by the in-process generator and both
 * emitted stdio servers.
 *
 * Contract:
 * - A tool name resolves through `targets`; an unknown tool and one that is
 *   not exposed are refused with the same answer.
 * - CRUD tools call `executeOperation`. Custom actions, the cookbook branch
 *   and task plumbing stay with the caller.
 * - A list result renders as `{ data, meta: { total, limit, offset, count } }`.
 * - Failures render through `toTransportError` as an `isError` result.
 * - A call's own principal wins over `options.principal`; with neither, the
 *   call is anonymous.
 */
export function createMcpToolRuntime(
  _options: McpRuntimeOptions,
): McpToolRuntime {
  return notImplemented('createMcpToolRuntime', 'K7');
}
