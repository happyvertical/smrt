/**
 * Standalone Level 2 runtime dev-plane host (#1831).
 *
 * Serves a *positive* read-only tool catalog over the stateless 2026-07-28
 * Streamable HTTP transport (#2147): `createMcpHandler` with `legacy: 'reject'`
 * and `maxSubscriptions: 0`, adapted to Node with `toNodeHandler`. No SSE,
 * no session header, no sticky routing.
 *
 * Security boundary (development only):
 * - binds loopback only; SDK localhost Host/Origin validation runs first;
 * - every request needs `Authorization: Bearer <token>` (constant-time
 *   compare) — from `SMRT_DEV_MCP_TOKEN` or minted per process;
 * - no authenticated principal exists here, so scope stays fail-closed
 *   global-only exactly as in Level 1;
 * - the catalog never includes generated CRUD, custom actions, `do()`, or
 *   tool-backed `is()`.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  localhostHostValidation,
  localhostOriginValidation,
  toNodeHandler,
} from '@modelcontextprotocol/node';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { SERVER_NAME, SERVER_VERSION } from './server-info.js';
import { TOOLS } from './tool-catalog.js';
import { bootRuntime, type RuntimeBoot } from './tools/runtime/boot.js';
import {
  runtimeObject,
  runtimeRegistry,
  runtimeSchemaDiff,
} from './tools/runtime/observation.js';
import {
  runtimeDispatchHealth,
  runtimeJobHealth,
  runtimeMigrationStatus,
  runtimeRecentChanges,
  runtimeRegistryDrift,
  runtimeScheduleHealth,
} from './tools/runtime/tools.js';

/**
 * The complete Level 2 catalog. A tool is exposed over HTTP only if it is
 * named here; the static stdio catalog is deliberately not mounted.
 */
export const RUNTIME_HTTP_TOOL_NAMES = [
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

export type RuntimeHttpToolName = (typeof RUNTIME_HTTP_TOOL_NAMES)[number];

const RUNTIME_HTTP_HANDLERS: Record<
  RuntimeHttpToolName,
  (args: Record<string, unknown>) => Promise<unknown>
> = {
  'runtime-registry': (args) => runtimeRegistry(args as never),
  'runtime-object': (args) => runtimeObject(args as never),
  'runtime-schema-diff': (args) => runtimeSchemaDiff(args as never),
  'migration-status': (args) => runtimeMigrationStatus(args as never),
  'job-health': (args) => runtimeJobHealth(args as never),
  'schedule-health': (args) => runtimeScheduleHealth(args as never),
  'dispatch-health': (args) => runtimeDispatchHealth(args as never),
  'recent-changes': (args) => runtimeRecentChanges(args as never),
  'registry-drift': (args) => runtimeRegistryDrift(args as never),
};

/** Catalog definitions for the HTTP plane, in catalog order. */
export function runtimeHttpTools() {
  const names = new Set<string>(RUNTIME_HTTP_TOOL_NAMES);
  return TOOLS.filter((tool) => names.has(tool.name));
}

/**
 * Build a fresh protocol server per request (stateless transport contract).
 * `projectRoot` is fixed at host start; per-request `projectPath` arguments
 * are ignored so a client cannot re-point the booted process.
 */
export function createRuntimeProtocolServer(projectRoot: string): Server {
  const server = new Server(
    { name: `${SERVER_NAME}-runtime`, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: runtimeHttpTools(),
  }));
  server.setRequestHandler('tools/call', async (request) => {
    const name = request.params.name as string;
    const handler = (RUNTIME_HTTP_HANDLERS as Record<string, unknown>)[name];
    if (typeof handler !== 'function') {
      throw new Error(`Unknown runtime tool: ${name}`);
    }
    const { projectPath: _ignored, ...args } = (request.params.arguments ??
      {}) as Record<string, unknown>;
    const result = await (
      handler as (a: Record<string, unknown>) => Promise<unknown>
    )({ ...args, projectPath: projectRoot });
    const text = JSON.stringify(result, null, 2);
    return {
      content: [{ type: 'text', text }],
      structuredContent: result as Record<string, unknown>,
    } satisfies CallToolResult;
  });
  return server;
}

export interface RuntimeHttpHostOptions {
  projectRoot?: string;
  /** Loopback interface only; anything else is refused at startup. */
  host?: '127.0.0.1' | 'localhost' | '::1';
  /** `0` (default) picks a free port. */
  port?: number;
  /** Bearer token; defaults to `SMRT_DEV_MCP_TOKEN` or a per-process random token. */
  token?: string;
  /** Path the MCP endpoint is mounted on (default `/mcp`). */
  path?: string;
}

export interface RuntimeHttpHost {
  url: string;
  token: string;
  boot: RuntimeBoot;
  close(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

export function bearerMatches(
  header: string | undefined,
  token: string,
): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const presented = Buffer.from(header.slice('Bearer '.length));
  const expected = Buffer.from(token);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

function deny(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  if (status === 401) {
    res.setHeader('www-authenticate', 'Bearer realm="smrt-dev-mcp runtime"');
  }
  res.end(JSON.stringify({ error: message }));
}

/** Start the Level 2 host. Boots the confined runtime before listening. */
export async function startRuntimeHttpHost(
  options: RuntimeHttpHostOptions = {},
): Promise<RuntimeHttpHost> {
  const host = options.host ?? '127.0.0.1';
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      'The runtime dev-plane binds loopback only (127.0.0.1, localhost, ::1).',
    );
  }
  const path = options.path ?? '/mcp';
  const token =
    options.token ??
    process.env.SMRT_DEV_MCP_TOKEN?.trim() ??
    randomBytes(24).toString('base64url');
  if (!token) {
    throw new Error('SMRT_DEV_MCP_TOKEN must not be empty.');
  }
  const projectRoot = options.projectRoot ?? process.cwd();
  const boot = await bootRuntime({ projectRoot });

  const mcp = toNodeHandler(
    createMcpHandler(() => createRuntimeProtocolServer(projectRoot), {
      legacy: 'reject',
      maxSubscriptions: 0,
    }),
  );
  const hostGuard = localhostHostValidation();
  const originGuard = localhostOriginValidation();

  const httpServer: HttpServer = createHttpServer(
    (req: IncomingMessage, res: ServerResponse) => {
      // Guards answer and end the response themselves when they return false.
      if (!hostGuard(req, res)) return;
      if (!originGuard(req, res)) return;
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== path) {
        deny(res, 404, 'not found');
        return;
      }
      if (!bearerMatches(req.headers.authorization, token)) {
        deny(res, 401, 'missing or invalid bearer token');
        return;
      }
      void mcp(req, res);
    },
  );

  await new Promise<void>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(options.port ?? 0, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });
  const address = httpServer.address() as AddressInfo;
  const urlHost =
    address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return {
    url: `http://${urlHost}:${address.port}${path}`,
    token,
    boot,
    close: () =>
      new Promise<void>((resolve, reject) => {
        httpServer.closeAllConnections?.();
        httpServer.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
