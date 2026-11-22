/**
 * Checks on tool arguments before they are used.
 *
 * MCP tool arguments are untyped JSON: a client may send any value under any
 * name, whatever the tool's input schema says. An identifier argument
 * (`id`, `slug`) selects the one row a tool reads, changes or removes, so it
 * is used only when it is a non-empty string. The in-process MCP generator
 * and both emitted MCP servers share this check.
 *
 * Import-free at runtime besides the error base, so emitted code and the
 * browser entry can use it.
 */

import { ValidationError } from './errors';

/**
 * A tool argument that cannot be used.
 *
 * Extends `ValidationError` so the retry classifier never retries it, and
 * carries `status` / `publicMessage` so it is reported as a typed 400 and as
 * an MCP tool failure with a code.
 */
export class ToolArgumentError extends ValidationError {
  readonly status = 400;
  readonly publicMessage: string;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message, 'VALIDATION_INVALID_ARGUMENT', details);
    this.name = 'ToolArgumentError';
    this.publicMessage = message;
  }
}

/**
 * Read an optional identifier argument.
 *
 * @returns the identifier, or `undefined` when the argument is absent
 *   (`undefined`, `null` or an empty string)
 * @throws {ToolArgumentError} when the argument is present and is not a
 *   string: a number, a boolean, an array or an object is never an identifier
 */
export function identifierArgument(
  args: unknown,
  name: string,
): string | undefined {
  const value =
    args && typeof args === 'object'
      ? (args as Record<string, unknown>)[name]
      : undefined;
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') {
    throw new ToolArgumentError(`'${name}' must be a non-empty string.`, {
      argument: name,
    });
  }
  return value;
}

/**
 * Read a required identifier argument: the first of `names` that is present.
 *
 * @param args - The tool call's arguments
 * @param names - Argument names to accept, in order of preference
 * @param missingMessage - Text of the refusal when none is present
 * @throws {ToolArgumentError} when none is present, or one is present and is
 *   not a string
 */
export function requireIdentifierArgument(
  args: unknown,
  names: readonly string[],
  missingMessage?: string,
): string {
  for (const name of names) {
    const value = identifierArgument(args, name);
    if (value !== undefined) return value;
  }
  throw new ToolArgumentError(
    missingMessage ??
      `${names.map((name) => `'${name}'`).join(' or ')} is required.`,
    { arguments: [...names] },
  );
}
