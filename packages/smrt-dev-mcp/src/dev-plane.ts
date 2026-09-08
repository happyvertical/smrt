/**
 * In-app runtime dev-plane (#2782, Level 3 of #2307).
 *
 * The standalone `--http` host (Level 2) boots manifests in its own process.
 * This module runs *inside* the application's dev server, where the real
 * decorated `ObjectRegistry` is already live and the app's own database
 * configuration is at hand. It serves the same read-only runtime tools as
 * Level 2 plus `registry-live`, over two surfaces on one mount:
 *
 * - JSON: `GET <base>` (catalog), `GET|POST <base>/<tool>` (envelope);
 *   arguments come from the query string or a JSON body.
 * - MCP: `POST <base>/mcp`, stateless Streamable HTTP (#2147).
 *
 * Security boundary: the caller (a generated SvelteKit route) only mounts
 * this in dev mode; every request must present `Authorization: Bearer` with
 * the configured token and arrive on a loopback `Host`. No principal exists,
 * so scope is fail-closed global-only. The catalog is positive: generated
 * CRUD, custom actions, `do()`, and tool-backed `is()` are never mounted.
 */

import { snapshotRegistry } from '@happyvertical/smrt-core';
import {
  type CallToolResult,
  createMcpHandler,
  Server,
  type Tool,
} from '@modelcontextprotocol/server';
import { bearerMatches } from './http.js';
import { SERVER_NAME, SERVER_VERSION } from './server-info.js';
import { TOOLS } from './tool-catalog.js';
import {
  runtimeObject,
  runtimeRegistry,
  runtimeSchemaDiff,
} from './tools/runtime/observation.js';
import {
  RUNTIME_PROVENANCE,
  type RuntimeToolEnvelope,
  runtimeDispatchHealth,
  runtimeJobHealth,
  runtimeMigrationStatus,
  runtimeRecentChanges,
  runtimeRegistryDrift,
  runtimeScheduleHealth,
} from './tools/runtime/tools.js';

/** Provenance label for the application's own live registry. */
export const LIVE_REGISTRY_PROVENANCE = 'live (app registry)';

export interface DevPlaneDatabase {
  url?: string;
  type?: string;
}

export interface DevPlaneOptions {
  /** Bearer token every request must present. */
  token: string;
  /** Project root; used only to relativize paths in snapshots. */
  projectRoot?: string;
  /**
   * The app's database configuration (typically `getSmrtConfig(name).db`
   * from the generated `$lib/server/smrt`). Passed to the runtime tools as
   * `dbUrl`/`dbType`, so the SDK's connection cache hands back the same
   * handle the app uses. `:memory:` or absent means static-only answers.
   */
  db?: DevPlaneDatabase;
}

export interface DevPlane {
  /** Tool names served, in catalog order. */
  tools: readonly string[];
  /** Serve one request mounted at `basePath` (e.g. `/api/_dev`). */
  handleRequest(request: Request, basePath: string): Promise<Response>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Positive catalog: the nine Level 2 tools plus the in-process-only one. */
export const DEV_PLANE_TOOL_NAMES = [
  'registry-live',
  'runtime-registry',
  'runtime-object',
  'runtime-schema-diff',
  'migration-status',
  'job-health',
  'schedule-health',
  'dispatch-health',
  'recent-changes',
  'registry-drift',
] as const;

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function hostIsLoopback(request: Request): boolean {
  const host = request.headers.get('host') ?? '';
  const hostname = host.replace(/:\d+$/, '').toLowerCase();
  if (!LOOPBACK.has(hostname)) return false;
  const origin = request.headers.get('origin');
  if (!origin) return true;
  try {
    return LOOPBACK.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false;
  }
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

/**
 * `registry-live`: snapshot the registry as the app has it right now. No
 * manifest boot; the app's own imports (via `$lib/server/smrt`) registered
 * these classes, and Vite's SSR HMR re-registers them on change.
 */
async function registryLive(
  args: Record<string, unknown>,
  projectRoot: string | undefined,
): Promise<RuntimeToolEnvelope> {
  const objects = Array.isArray(args.objects)
    ? args.objects.map(String)
    : typeof args.objects === 'string'
      ? args.objects
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : undefined;
  const snapshot = snapshotRegistry({
    projectRoot,
    objects,
    detail:
      typeof args.detail === 'boolean'
        ? args.detail
        : args.detail === 'true' || Boolean(objects?.length),
  });
  return {
    ok: true,
    coverage: null,
    diagnostics: [],
    data: {
      provenance: LIVE_REGISTRY_PROVENANCE,
      registrySource: 'live',
      snapshot,
    },
  };
}

async function parseArgs(
  request: Request,
  url: URL,
): Promise<Record<string, unknown>> {
  const args: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (value === 'true') args[key] = true;
    else if (value === 'false') args[key] = false;
    else if (/^-?\d+(\.\d+)?$/.test(value)) args[key] = Number(value);
    else args[key] = value;
  }
  if (request.method === 'POST') {
    const type = request.headers.get('content-type') ?? '';
    if (type.includes('application/json')) {
      const body = (await request.json().catch(() => null)) as unknown;
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        Object.assign(args, body as Record<string, unknown>);
      }
    }
  }
  return args;
}

export function createDevPlane(options: DevPlaneOptions): DevPlane {
  if (!options.token) {
    throw new Error('createDevPlane requires a non-empty bearer token');
  }
  const projectRoot = options.projectRoot;
  const dbArgs =
    options.db?.url && options.db.url !== ':memory:'
      ? {
          dbUrl: options.db.url,
          ...(options.db.type ? { dbType: options.db.type } : {}),
        }
      : {};

  // Every call is pinned to the app's root and database; client-supplied
  // projectPath/dbUrl/dbType are dropped so a caller cannot re-point it.
  const pin = (args: Record<string, unknown>): Record<string, unknown> => {
    const { projectPath: _p, dbUrl: _u, dbType: _t, ...rest } = args;
    return { ...rest, projectPath: projectRoot, ...dbArgs };
  };

  const handlers: Record<(typeof DEV_PLANE_TOOL_NAMES)[number], ToolHandler> = {
    'registry-live': (args) => registryLive(args, projectRoot),
    'runtime-registry': (args) => runtimeRegistry(pin(args) as never),
    'runtime-object': (args) => runtimeObject(pin(args) as never),
    'runtime-schema-diff': (args) => runtimeSchemaDiff(pin(args) as never),
    'migration-status': (args) => runtimeMigrationStatus(pin(args) as never),
    'job-health': (args) => runtimeJobHealth(pin(args) as never),
    'schedule-health': (args) => runtimeScheduleHealth(pin(args) as never),
    'dispatch-health': (args) => runtimeDispatchHealth(pin(args) as never),
    'recent-changes': (args) => runtimeRecentChanges(pin(args) as never),
    'registry-drift': (args) => runtimeRegistryDrift(pin(args) as never),
  };

  const catalogTools = (): Tool[] => {
    const known = new Map(TOOLS.map((tool) => [tool.name, tool]));
    return DEV_PLANE_TOOL_NAMES.map(
      (name) =>
        known.get(name) ?? {
          name,
          description:
            "Sanitized snapshot of the application's live ObjectRegistry (no manifest boot; live provenance; read-only)",
          inputSchema: {
            type: 'object',
            properties: {
              objects: { type: 'array', items: { type: 'string' } },
              detail: { type: 'boolean' },
            },
          },
        },
    ) as Tool[];
  };

  const mcp = createMcpHandler(
    () => {
      const server = new Server(
        { name: `${SERVER_NAME}-dev-plane`, version: SERVER_VERSION },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler('tools/list', async () => ({
        tools: catalogTools(),
      }));
      server.setRequestHandler('tools/call', async (request) => {
        const name = request.params
          .name as (typeof DEV_PLANE_TOOL_NAMES)[number];
        const handler = handlers[name];
        if (!handler)
          throw new Error(`Unknown dev-plane tool: ${String(name)}`);
        const result = await handler(
          (request.params.arguments ?? {}) as Record<string, unknown>,
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          structuredContent: result as Record<string, unknown>,
        } satisfies CallToolResult;
      });
      return server;
    },
    { legacy: 'reject', maxSubscriptions: 0 },
  );

  return {
    tools: DEV_PLANE_TOOL_NAMES,
    async handleRequest(request, basePath) {
      if (!hostIsLoopback(request)) {
        return json(403, {
          error: 'dev-plane requests must arrive on loopback',
        });
      }
      if (
        !bearerMatches(
          request.headers.get('authorization') ?? undefined,
          options.token,
        )
      ) {
        return json(
          401,
          { error: 'missing or invalid bearer token' },
          {
            'www-authenticate': 'Bearer realm="smrt dev-plane"',
          },
        );
      }
      const url = new URL(request.url);
      const base = basePath.replace(/\/+$/, '');
      if (!url.pathname.startsWith(base))
        return json(404, { error: 'not found' });
      const rest = url.pathname.slice(base.length).replace(/^\/+/, '');
      if (rest === '') {
        return json(200, {
          provenance: LIVE_REGISTRY_PROVENANCE,
          tools: catalogTools().map((t) => ({
            name: t.name,
            description: t.description,
          })),
          mcp: `${base}/mcp`,
        });
      }
      if (rest === 'mcp') {
        return mcp.fetch(request);
      }
      const handler = handlers[rest as (typeof DEV_PLANE_TOOL_NAMES)[number]];
      if (!handler || (request.method !== 'GET' && request.method !== 'POST')) {
        return json(404, { error: `unknown dev-plane tool: ${rest}` });
      }
      try {
        return json(200, await handler(await parseArgs(request, url)));
      } catch (error) {
        return json(200, {
          ok: false,
          coverage: null,
          diagnostics: [
            {
              severity: 'warning',
              code: 'dev_plane_tool_error',
              message: error instanceof Error ? error.message : 'unknown error',
            },
          ],
          data: { provenance: RUNTIME_PROVENANCE },
        });
      }
    },
  };
}
