/**
 * Official MCP conformance suite against the downstream app MCP path (#2146).
 *
 * smrt-app-mcp's shipped surface is an HTTP tool API (`mountMcpToolsRoute` /
 * `mountMcpCallRoute`), not an MCP protocol transport — real MCP clients
 * reach a smrt app today through the `@happyvertical/smrt-app-cli` stdio
 * bridge. This spec conformance-tests that full composition end to end:
 *
 *   conformance CLI → Streamable HTTP harness → bridge `Server`
 *     → fetch → app-mcp route mounts → `createMcpAppServer` → MCPGenerator
 *
 * Everything in that chain is production code over real registered `@smrt()`
 * fixture objects; only the HTTP mounting of the bridge's `Server` (instead
 * of stdio) belongs to the harness. A native spec-compliant stateless
 * Streamable HTTP endpoint for smrt-app-mcp is #2147; when it lands, point
 * this spec (or its successor) at that endpoint directly and re-derive the
 * baseline.
 *
 * `conformance-baseline.yml` semantics match the sibling harnesses
 * (packages/smrt-dev-mcp, packages/mcp-conformance-fixture): unexpected
 * failures and stale baseline entries both fail CI.
 */
import { spawn } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMcpStdioBridge } from '@happyvertical/smrt-app-cli';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMcpAppServer } from '../server.js';
import { mountMcpCallRoute, mountMcpToolsRoute } from '../sveltekit.js';
import './mcp-conformance-fixture-objects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..', '..');
const conformanceBin = join(packageRoot, 'node_modules', '.bin', 'conformance');
const baselinePath = join(packageRoot, 'conformance-baseline.yml');

const SPEC_VERSION = '2025-11-25';
const ENV_PREFIX = 'SMRT_APP_MCP_CONFORMANCE';

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

let appHttpServer: ReturnType<typeof createHttpServer>;
let mcpHttpServer: ReturnType<typeof createHttpServer>;
let mcpUrl: string;
let allowedHosts: string[] = [];

beforeAll(async () => {
  // 1. A real app tool API: createMcpAppServer over the registered fixture
  //    objects, mounted exactly as a SvelteKit app would mount it. The
  //    synthetic event carries an authenticated user, matching a bridge
  //    session with a stored token.
  const appServer = createMcpAppServer({
    smrtOptions: () => ({}),
    serverInfo: { name: 'smrt-app-mcp-conformance', version: '0.0.0' },
    allowedClassNames: ['AppMcpConformanceItem', 'AppMcpConformanceOrder'],
  });
  const toolsRoute = mountMcpToolsRoute(appServer);
  const callRoute = mountMcpCallRoute(appServer);

  appHttpServer = createHttpServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
      const body = req.method === 'GET' ? undefined : await readBody(req);
      const event = {
        locals: { user: { id: 'conformance-user' } },
        request: new Request(url, {
          method: req.method,
          headers: req.headers as Record<string, string>,
          body: body && body.length > 0 ? body : undefined,
        }),
        url,
      };
      let response: Response;
      if (url.pathname === '/api/mcp/tools' && req.method === 'GET') {
        response = await toolsRoute(event);
      } else if (url.pathname === '/api/mcp/call' && req.method === 'POST') {
        response = await callRoute(event);
      } else {
        response = new Response('not found', { status: 404 });
      }
      res.writeHead(
        response.status,
        Object.fromEntries(response.headers.entries()),
      );
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (error) {
      console.error('[app-mcp-conformance] app route error', error);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    }
  });
  await new Promise<void>((resolveListen) => {
    appHttpServer.listen(0, '127.0.0.1', resolveListen);
  });
  const appPort = (appHttpServer.address() as AddressInfo).port;
  process.env[`${ENV_PREFIX}_SERVER_URL`] = `http://127.0.0.1:${appPort}`;
  // Point the CLI config at a path that never exists so developer machines'
  // ~/.config state cannot leak into the run.
  process.env[`${ENV_PREFIX}_CLI_CONFIG`] = join(
    packageRoot,
    '.mcp-conformance-no-config.json',
  );

  // 2. The bridge's MCP Server, mounted per-request on the stateless
  //    Streamable HTTP transport the conformance CLI requires.
  mcpHttpServer = createHttpServer(async (req, res) => {
    try {
      const { server } = createMcpStdioBridge({
        envPrefix: ENV_PREFIX,
        serverInfo: { name: 'smrt-app-mcp-conformance', version: '0.0.0' },
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableDnsRebindingProtection: true,
        allowedHosts,
      });
      // Keep-alive safe: 'finish' covers normal completion, 'close' covers
      // aborted connections; the guard makes double-invocation harmless.
      let cleanedUp = false;
      const cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        void transport.close();
        void server.close();
      };
      res.on('finish', cleanup);
      res.on('close', cleanup);
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[app-mcp-conformance] harness error', error);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    }
  });
  await new Promise<void>((resolveListen) => {
    mcpHttpServer.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = mcpHttpServer.address() as AddressInfo;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
});

afterAll(async () => {
  delete process.env[`${ENV_PREFIX}_SERVER_URL`];
  delete process.env[`${ENV_PREFIX}_CLI_CONFIG`];
  for (const server of [mcpHttpServer, appHttpServer]) {
    if (!server) continue;
    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => (error ? rejectClose(error) : resolveClose()));
    });
  }
});

describe('smrt-app-mcp × app-cli bridge MCP conformance', () => {
  it(`passes the official conformance suite at ${SPEC_VERSION} (baseline-checked)`, async () => {
    const result = await new Promise<{ code: number | null; output: string }>(
      (resolveRun, rejectRun) => {
        const child = spawn(
          conformanceBin,
          [
            'server',
            '--url',
            mcpUrl,
            '--spec-version',
            SPEC_VERSION,
            '--expected-failures',
            baselinePath,
          ],
          { cwd: packageRoot, env: process.env },
        );
        let output = '';
        child.stdout.on('data', (chunk) => {
          output += String(chunk);
        });
        child.stderr.on('data', (chunk) => {
          output += String(chunk);
        });
        child.on('error', rejectRun);
        child.on('close', (code) => resolveRun({ code, output }));
      },
    );

    expect(
      result.code,
      `conformance suite reported unexpected results:\n${result.output}`,
    ).toBe(0);
  }, 240_000);
});
