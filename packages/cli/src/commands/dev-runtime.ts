/**
 * dev:runtime — client for the runtime dev-plane (#2782).
 *
 * With a running dev server that mounts the in-app plane (`--url` or
 * `SMRT_DEV_PLANE_URL`), the command calls the JSON route and prints the
 * envelope. Without one it falls back to the standalone Level 2 boot in this
 * process, so the same answer is available from a terminal either way.
 */
import { RUNTIME_TOOLS } from '@happyvertical/smrt-dev-mcp/runtime';
import type { CLICommand } from '../cli-generator.js';

interface DevRuntimeOptions {
  url?: string;
  token?: string;
  arg?: string[] | string;
  json?: boolean;
}

/** Parse repeatable `--arg key=value` flags; numbers/booleans are coerced. */
export function parseToolArgs(
  raw: string[] | string | undefined,
): Record<string, unknown> {
  const values = Array.isArray(raw) ? raw : raw ? [raw] : [];
  const args: Record<string, unknown> = {};
  for (const entry of values) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).trim();
    const value = entry.slice(eq + 1).trim();
    if (value === 'true') args[key] = true;
    else if (value === 'false') args[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) args[key] = Number(value);
    else if (value.includes(','))
      args[key] = value.split(',').map((v) => v.trim());
    else args[key] = value;
  }
  return args;
}

/** Call the in-app plane when a URL is configured; otherwise run locally. */
export async function runRuntimeTool(
  tool: string,
  args: Record<string, unknown>,
  options: { url?: string; token?: string; fetchImpl?: typeof fetch } = {},
): Promise<{ source: 'dev-plane' | 'local'; result: unknown }> {
  const url = options.url?.trim() || process.env.SMRT_DEV_PLANE_URL?.trim();
  if (url) {
    const token =
      options.token?.trim() || process.env.SMRT_DEV_MCP_TOKEN?.trim();
    if (!token) {
      throw new Error(
        'A dev-plane URL is set but no token: pass --token or set SMRT_DEV_MCP_TOKEN',
      );
    }
    const fetchImpl = options.fetchImpl ?? fetch;
    const response = await fetchImpl(`${url.replace(/\/+$/, '')}/${tool}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    if (!response.ok) {
      throw new Error(`dev-plane responded ${response.status} for ${tool}`);
    }
    return { source: 'dev-plane', result: await response.json() };
  }
  const local = RUNTIME_TOOLS[tool as keyof typeof RUNTIME_TOOLS];
  if (!local) {
    throw new Error(
      `Unknown runtime tool "${tool}"; known: ${Object.keys(RUNTIME_TOOLS).join(', ')}`,
    );
  }
  return { source: 'local', result: await local(args as never) };
}

export const devRuntimeCommands: Record<string, CLICommand> = {
  'dev:runtime': {
    name: 'dev:runtime',
    description:
      'Call a runtime dev-plane tool (runtime-registry, runtime-object, runtime-schema-diff, migration-status, job-health, schedule-health, dispatch-health, recent-changes, registry-drift) against a running dev server or, without one, the local Level 2 boot',
    args: ['tool'],
    options: {
      url: {
        type: 'string',
        description:
          'Dev-plane base URL (e.g. http://127.0.0.1:5173/api/_dev); default SMRT_DEV_PLANE_URL',
      },
      token: {
        type: 'string',
        description: 'Bearer token; default SMRT_DEV_MCP_TOKEN',
      },
      arg: {
        type: 'string',
        multiple: true,
        description:
          'Tool argument as key=value (repeatable; a,b,c becomes an array)',
      },
      json: {
        type: 'boolean',
        description: 'Print the raw envelope as JSON (default)',
        default: true,
      },
    },
    handler: async (args: string[], options: DevRuntimeOptions) => {
      const tool = args[0];
      if (!tool) throw new Error('dev:runtime requires a tool name');
      const { source, result } = await runRuntimeTool(
        tool,
        parseToolArgs(options.arg),
        { url: options.url, token: options.token },
      );
      console.error(`[smrt] dev:runtime ${tool} via ${source}`);
      console.log(JSON.stringify(result, null, 2));
    },
  },
};
