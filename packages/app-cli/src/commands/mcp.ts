/**
 * `<name> mcp tools` / `<name> mcp call <tool> '<json>'` — thin HTTP client
 * for a deployed app's modern MCP endpoint (`<mcpPath>`, Streamable HTTP) or,
 * with `--legacy-rest`, its `<mcpPath>/tools` and `<mcpPath>/call`. The stdio
 * bridge lives in `bin/smrt-mcp-bridge` and `bridge.ts`; these are the
 * equivalent one-shot HTTP commands for ad-hoc inspection and owner tooling.
 *
 * Flags (either subcommand):
 *  - `--url <server>`      target server (default: configured server URL)
 *  - `--token-env <NAME>`  read the bearer token from this env var; the token
 *                          is never printed and is scrubbed from all output
 *  - `--mcp-path <path>`   same-server MCP route (default `/api/mcp`)
 *  - `--legacy-rest`      use the deprecated `<mcpPath>/tools` and
 *                          `<mcpPath>/call` REST routes instead of the modern
 *                          MCP endpoint at exactly `<mcpPath>`
 * `mcp call` only:
 *  - `--confirm`           inject `confirm: true` into the call arguments for
 *                          outbound/destructive tools; never added implicitly
 *
 * @packageDocumentation
 */

import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import type { CliConfigContext } from '../config.js';
import {
  assertSecureServerUrl,
  getServerUrl,
  getStoredToken,
  loadCliConfig,
  redactTransportValue,
  requestJsonResult,
  resolveMcpPath,
} from '../config.js';

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
  'Flags: --url <server> --token-env <ENV_NAME> --mcp-path <path> --legacy-rest';

interface ParsedMcpArgs {
  positionals: string[];
  url?: string;
  tokenEnv?: string;
  mcpPath?: string;
  confirm: boolean;
  legacyRest: boolean;
}

function parseMcpArgs(args: string[]): ParsedMcpArgs {
  const parsed: ParsedMcpArgs = {
    positionals: [],
    confirm: false,
    legacyRest: false,
  };
  const valueFlags = new Set(['--url', '--token-env', '--mcp-path']);
  for (let i = 0; i < args.length; i++) {
    const raw = args[i];
    if (raw === '--confirm') {
      parsed.confirm = true;
      continue;
    }
    if (raw === '--legacy-rest') {
      parsed.legacyRest = true;
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
  if (rest.length > (sub === 'call' ? 2 : 0))
    throw new Error(`Unexpected extra arguments.\n${USAGE}`);
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
  let callArguments: unknown;
  let name: string | undefined;
  if (sub === 'call') {
    name = rest[0];
    if (!name) throw new Error('Usage: mcp call <tool> [<json>]');
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
  }

  const scrub = (text: string) =>
    token
      ? text
          .split(token)
          .join('[REDACTED]')
          .split(JSON.stringify(token).slice(1, -1))
          .join('[REDACTED]')
      : text;

  if (!parsed.legacyRest) {
    try {
      const result = await runModern(options, base, parsed.url, token, () =>
        sub === 'tools'
          ? { kind: 'tools' as const }
          : {
              kind: 'call' as const,
              name: name as string,
              args: callArguments as Record<string, unknown>,
            },
      );
      stdout.write(
        scrub(
          `${JSON.stringify(redactTransportValue(result.value), null, 2)}\n`,
        ),
      );
      if (result.isError) {
        stderr.write('MCP tool call returned an error result.\n');
        return false;
      }
      return true;
    } catch (error) {
      // Setup errors (bad URL, insecure token transport) propagate like the
      // legacy path; only transport failures become a scrubbed failure.
      if (!(error instanceof McpTransportFailure)) throw error;
      stderr.write(scrub(`${safeMessage(error)}\n`));
      return false;
    }
  }

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

  stdout.write(scrub(`${JSON.stringify(result, null, 2)}\n`));
  if (!result.ok)
    stderr.write(scrub(`${result.error.message ?? result.error.code}\n`));
  return result.ok;
}

const MODERN_TIMEOUT_MS = 30_000;
const MODERN_MAX_RESPONSE_BYTES = 10 * 1024 * 1024;

/** Refuse oversized responses by header or by a streaming byte counter. */
function capResponse(response: Response, max: number): Response {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max)
    throw new Error('Response too large.');
  if (!response.body) return response;
  let seen = 0;
  const counted = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > max) controller.error(new Error('Response too large.'));
        else controller.enqueue(chunk);
      },
    }),
  );
  return new Response(counted, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

class McpTransportFailure extends Error {}

type ModernOperation =
  | { kind: 'tools' }
  | { kind: 'call'; name: string; args: Record<string, unknown> };

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return String(redactTransportValue(message));
}

/** One-shot modern MCP client against the exact `<serverUrl><mcpPath>` target. */
async function runModern(
  options: McpCommandOptions,
  path: string,
  serverUrlOverride: string | undefined,
  token: string | undefined,
  operation: () => ModernOperation,
): Promise<{ value: unknown; isError: boolean }> {
  const config = await loadCliConfig(options.context);
  const serverUrl = (
    serverUrlOverride ?? (await getServerUrl(options.context, config))
  ).replace(/\/+$/u, '');
  if (options.context.requireSecureServerUrl || token)
    assertSecureServerUrl(serverUrl);
  const bearer =
    token ?? (await getStoredToken(options.context, config, serverUrl));
  const target = new URL(`${serverUrl}${path}`);
  const client = new Client(
    {
      name: `${options.context.envPrefix.toLowerCase()}-mcp-cli`,
      version: '1',
    },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  const transport = new StreamableHTTPClientTransport(target, {
    fetch: async (input, init) => {
      const requested = new URL(
        input instanceof Request ? input.url : String(input),
      );
      if (requested.href !== target.href)
        throw new Error('MCP target changed.');
      const headers = new Headers(init?.headers);
      headers.delete('authorization');
      if (bearer) headers.set('authorization', `Bearer ${bearer}`);
      const signal = AbortSignal.any(
        [init?.signal, AbortSignal.timeout(MODERN_TIMEOUT_MS)].filter(
          (value): value is AbortSignal => value != null,
        ),
      );
      const response = await (options.fetch ?? fetch)(input, {
        ...init,
        headers,
        redirect: 'error',
        signal,
      });
      return capResponse(response, MODERN_MAX_RESPONSE_BYTES);
    },
  });
  try {
    await client.connect(transport);
    const op = operation();
    if (op.kind === 'tools') {
      const tools: unknown[] = [];
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        tools.push(...page.tools);
        cursor = page.nextCursor;
        if (cursor && (cursors.has(cursor) || cursors.size >= 100))
          throw new Error('Invalid tool catalog pagination.');
        if (cursor) cursors.add(cursor);
      } while (cursor);
      return { value: { tools }, isError: false };
    }
    const called = await client.callTool({
      name: op.name,
      arguments: op.args,
    });
    return { value: called, isError: called.isError === true };
  } catch (error) {
    throw new McpTransportFailure(`MCP request failed: ${safeMessage(error)}`);
  } finally {
    await client.close().catch(() => undefined);
  }
}
