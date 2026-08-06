import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toNodeHandler } from '@modelcontextprotocol/node';
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  type McpHttpHandler,
  PROTOCOL_VERSION_META_KEY,
  SERVER_INFO_META_KEY,
} from '@modelcontextprotocol/server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { McpAccessError } from '../errors.js';
import { createMcpProtocolServer } from '../protocol.js';
import type { McpAppServer } from '../server.js';

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const conformanceBin = join(packageRoot, 'node_modules', '.bin', 'conformance');
const baselinePath = join(packageRoot, 'conformance-baseline.yml');
let httpServer: ReturnType<typeof createHttpServer>;
let mcpUrl: string;
let handler: McpHttpHandler;

const appServer: McpAppServer = {
  serverInfo: { name: 'smrt-app-mcp-conformance', version: '0.0.0' },
  async listTools() {
    return [];
  },
  async callTool() {
    return { content: [{ type: 'text', text: 'unknown tool' }], isError: true };
  },
};

beforeAll(async () => {
  handler = createMcpHandler(() =>
    createMcpProtocolServer(appServer, { principal: { id: 'conformance' } }),
  );
  httpServer = createHttpServer(toNodeHandler(handler));
  await new Promise<void>((resolveListen) =>
    httpServer.listen(0, '127.0.0.1', resolveListen),
  );
  mcpUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}/mcp`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose, rejectClose) =>
    httpServer.close((error) => (error ? rejectClose(error) : resolveClose())),
  );
});

describe('smrt-app-mcp MCP 2026-07-28 conformance', () => {
  it('answers discover and stamps complete results from per-request metadata', async () => {
    const discover = await modernRequest(handler, 'server/discover');
    expect(discover.body.result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      resultType: 'complete',
      _meta: { [SERVER_INFO_META_KEY]: { name: 'smrt-app-mcp-conformance' } },
    });
    const list = await modernRequest(handler, 'tools/list');
    expect(list.body.result).toMatchObject({
      resultType: 'complete',
      tools: [],
    });
  });

  it('allowlists access-error metadata before exposing it over MCP', async () => {
    const accessErrorServer: McpAppServer = {
      ...appServer,
      async callTool() {
        throw new McpAccessError(403, 'access denied', {
          code: 'access_denied',
          retryable: false,
          secret: 'LEAK_ME',
        } as { code: string; retryable: boolean; secret: string });
      },
    };
    const accessErrorHandler = createMcpHandler(() =>
      createMcpProtocolServer(accessErrorServer),
    );

    const response = await modernRequest(accessErrorHandler, 'tools/call', {
      name: 'private-tool',
      arguments: {},
    });
    expect(response.body.error.data).toEqual({
      code: 'access_denied',
      retryable: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('LEAK_ME');
  });

  it('passes the official server suite with the reviewed baseline', async () => {
    const result = await runConformance(mcpUrl);
    expect(result.code, result.output).toBe(0);
  }, 240_000);
});

function runConformance(url: string) {
  return new Promise<{ code: number | null; output: string }>(
    (resolveRun, rejectRun) => {
      const child = spawn(
        conformanceBin,
        [
          'server',
          '--url',
          url,
          '--spec-version',
          '2026-07-28',
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
}

async function modernRequest(
  target: McpHttpHandler,
  method: string,
  params: Record<string, unknown> = {},
) {
  const response = await target.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': '2026-07-28',
        ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: {
          ...params,
          _meta: {
            [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
            [CLIENT_INFO_META_KEY]: {
              name: 'smrt-conformance',
              version: '0.0.0',
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
          },
        },
      }),
    }),
  );
  return { status: response.status, body: (await response.json()) as any };
}
