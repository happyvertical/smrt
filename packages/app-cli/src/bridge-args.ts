/**
 * Argument parsing for the generic `smrt-mcp-bridge` binary. Every value
 * option requires a non-empty value and may appear once; an explicitly
 * supplied endpoint path (argument or `SMRT_MCP_PATH`, even when empty) is
 * validated and never replaced by the default.
 *
 * @internal
 */

import { resolveMcpPath } from './config.js';

const VALUE_OPTIONS = [
  'env-prefix',
  'app-slug',
  'default-server-url',
  'name',
  'version',
  'mcp-path',
] as const;

type ValueOption = (typeof VALUE_OPTIONS)[number];

/** Parsed bridge configuration (before environment defaults for identity). */
export interface McpBridgeArgs {
  readonly values: ReadonlyMap<ValueOption, string>;
  readonly legacyRest: boolean;
  /** Validated endpoint path, when one was supplied explicitly. */
  readonly mcpPath?: string;
}

/** A usage error: print the message and exit non-zero without listening. */
export class McpBridgeUsageError extends Error {
  override readonly name = 'McpBridgeUsageError';
}

/** Parse bridge argv and the `SMRT_MCP_PATH` environment value. */
export function parseMcpBridgeArgs(
  argv: readonly string[],
  env: Readonly<Record<string, string | undefined>> = {},
): McpBridgeArgs {
  const values = new Map<ValueOption, string>();
  let legacyRest = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--legacy-rest') {
      legacyRest = true;
      continue;
    }
    if (!arg.startsWith('--')) continue;
    const equals = arg.indexOf('=');
    const key = arg.slice(2, equals < 0 ? undefined : equals);
    if (!(VALUE_OPTIONS as readonly string[]).includes(key)) continue;
    const option = key as ValueOption;
    let value: string | undefined;
    if (equals >= 0) {
      value = arg.slice(equals + 1);
    } else {
      value = argv[index + 1];
      if (value !== undefined && !value.startsWith('--')) index += 1;
      else value = undefined;
    }
    if (!value) {
      throw new McpBridgeUsageError(`--${option} requires a value.`);
    }
    if (values.has(option)) {
      throw new McpBridgeUsageError(`--${option} was provided more than once.`);
    }
    values.set(option, value);
  }

  let mcpPath: string | undefined;
  const explicit = values.has('mcp-path')
    ? { source: '--mcp-path', value: values.get('mcp-path') as string }
    : env.SMRT_MCP_PATH !== undefined
      ? { source: 'SMRT_MCP_PATH', value: env.SMRT_MCP_PATH }
      : undefined;
  if (explicit) {
    const invalid = new McpBridgeUsageError(
      `${explicit.source} must be a same-server absolute path such as /mcp.`,
    );
    if (!explicit.value) throw invalid;
    try {
      mcpPath = resolveMcpPath(explicit.value);
    } catch {
      throw invalid;
    }
  }
  return { values, legacyRest, ...(mcpPath ? { mcpPath } : {}) };
}
