/**
 * `<name> mcp tools` / `<name> mcp call <tool> '<json>'` — thin HTTP client
 * for a deployed app's `<mcpPath>/tools` and `<mcpPath>/call`. The stdio
 * bridge lives in `bin/smrt-mcp-bridge` and `bridge.ts`; these are the
 * equivalent one-shot HTTP commands for ad-hoc inspection and owner tooling.
 *
 * Flags (either subcommand):
 *  - `--url <server>`      target server (default: configured server URL)
 *  - `--token-env <NAME>`  read the bearer token from this env var; the token
 *                          is never printed and is scrubbed from all output
 *  - `--mcp-path <path>`   same-server MCP route (default `/api/mcp`)
 * `mcp call` only:
 *  - `--confirm`           inject `confirm: true` into the call arguments for
 *                          outbound/destructive tools; never added implicitly
 *
 * @packageDocumentation
 */

import type { CliConfigContext } from '../config.js';
import { requestJsonResult, resolveMcpPath } from '../config.js';

export interface McpCommandOptions {
  context: CliConfigContext;
  stdout?: NodeJS.WriteStream;
  stderr?: NodeJS.WriteStream;
  fetch?: typeof fetch;
  /** Environment used to resolve `--token-env` (tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Default MCP route when `--mcp-path` is absent (default `/api/mcp`). */
  mcpPath?: string;
}

const USAGE =
  'Usage: mcp tools [flags] | mcp call <tool> [<json>] [--confirm] [flags]\n' +
  'Flags: --url <server> --token-env <ENV_NAME> --mcp-path <path>';

interface ParsedMcpArgs {
  positionals: string[];
  url?: string;
  tokenEnv?: string;
  mcpPath?: string;
  confirm: boolean;
}

function parseMcpArgs(args: string[]): ParsedMcpArgs {
  const parsed: ParsedMcpArgs = { positionals: [], confirm: false };
  const valueFlags = new Set(['--url', '--token-env', '--mcp-path']);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === '--confirm') {
      parsed.confirm = true;
      continue;
    }
    if (raw.startsWith('--')) {
      const eq = raw.indexOf('=');
      const flag = eq === -1 ? raw : raw.slice(0, eq);
      if (!valueFlags.has(flag))
        throw new Error(`Unknown flag ${flag}.\n${USAGE}`);
      const value = eq === -1 ? args[++i] : raw.slice(eq + 1);
      if (!value || value.startsWith('--'))
        throw new Error(`Flag ${flag} requires a value.`);
      if (flag === '--url') parsed.url = value;
      else if (flag === '--token-env') parsed.tokenEnv = value;
      else parsed.mcpPath = value;
      continue;
    }
    parsed.positionals.push(raw);
  }
  return parsed;
}

export async function runMcpCommand(
  options: McpCommandOptions,
  args: string[],
): Promise<boolean> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const parsed = parseMcpArgs(args);
  const [sub, ...rest] = parsed.positionals;
  if (sub !== 'tools' && sub !== 'call') throw new Error(USAGE);
  if (parsed.confirm && sub !== 'call')
    throw new Error('--confirm is only valid with `mcp call`.');

  let token: string | undefined;
  if (parsed.tokenEnv !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(parsed.tokenEnv))
      throw new Error('--token-env must be an environment variable name.');
    token = (options.env ?? process.env)[parsed.tokenEnv];
    if (!token)
      throw new Error(
        `Environment variable ${parsed.tokenEnv} is not set or is empty.`,
      );
  }

  const base = resolveMcpPath(parsed.mcpPath ?? options.mcpPath).replace(
    /\/+$/u,
    '',
  );
  const requestOptions = {
    fetch: options.fetch,
    ...(parsed.url ? { serverUrl: parsed.url } : {}),
    ...(token ? { token } : {}),
  };

  let result: Awaited<ReturnType<typeof requestJsonResult>>;
  if (sub === 'tools') {
    result = await requestJsonResult(
      options.context,
      `${base}/tools`,
      { method: 'GET' },
      requestOptions,
    );
  } else {
    const name = rest[0];
    if (!name) throw new Error('Usage: mcp call <tool> [<json>]');
    let callArguments: unknown;
    try {
      callArguments = JSON.parse(rest[1] ?? '{}');
    } catch (error) {
      throw new Error(
        `Could not parse mcp call payload: ${(error as Error).message}`,
      );
    }
    if (parsed.confirm) {
      if (
        callArguments === null ||
        typeof callArguments !== 'object' ||
        Array.isArray(callArguments)
      )
        throw new Error(
          '--confirm requires the call arguments to be a JSON object.',
        );
      callArguments = { ...(callArguments as object), confirm: true };
    }
    result = await requestJsonResult(
      options.context,
      `${base}/call`,
      {
        body: JSON.stringify({ arguments: callArguments, name }),
        method: 'POST',
      },
      requestOptions,
    );
  }

  const scrub = (text: string) =>
    token ? text.split(token).join('[REDACTED]') : text;
  stdout.write(scrub(`${JSON.stringify(result, null, 2)}\n`));
  if (!result.ok)
    stderr.write(scrub(`${result.error.message ?? result.error.code}\n`));
  return result.ok;
}
