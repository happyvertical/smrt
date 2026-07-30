/**
 * Official MCP conformance suite against the smrt-dev-mcp server (#2146).
 *
 * The conformance CLI tests servers over Streamable HTTP, so this spec mounts
 * the exact `createServer()` construction `main()` ships over a stateless
 * `StreamableHTTPServerTransport` (fresh server + transport per request — the
 * SDK's documented stateless pattern) and runs the pinned
 * `@modelcontextprotocol/conformance` CLI against it at the spec revision the
 * current SDK line implements (2025-11-25).
 *
 * `conformance-baseline.yml` lists the scenarios that cannot pass for a
 * product server: they require the suite's fixture tools/prompts/resources
 * (`test_simple_text`, …) or optional capabilities (logging, completions,
 * subscriptions) smrt-dev-mcp intentionally does not declare. The CLI exits
 * non-zero on any unexpected failure AND on stale baseline entries, so both
 * regressions and silent fixes surface here. Sibling harnesses:
 * packages/mcp-conformance-fixture (generated Tier-1 template server) and
 * packages/smrt-app-mcp (HTTP tool API composed with the app-cli bridge).
 */
import { spawn } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer } from './index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const conformanceBin = join(packageRoot, 'node_modules', '.bin', 'conformance');
const baselinePath = join(packageRoot, 'conformance-baseline.yml');

const SPEC_VERSION = '2025-11-25';

let httpServer: ReturnType<typeof createHttpServer>;
let mcpUrl: string;
let allowedHosts: string[] = [];

beforeAll(async () => {
  httpServer = createHttpServer(async (req, res) => {
    try {
      const server = createServer();
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
      console.error('[mcp-conformance] request error', error);
      if (!res.headersSent) {
        res.writeHead(500).end();
      }
    }
  });
  await new Promise<void>((resolveListen) => {
    httpServer.listen(0, '127.0.0.1', resolveListen);
  });
  const { port } = httpServer.address() as AddressInfo;
  mcpUrl = `http://127.0.0.1:${port}/mcp`;
  allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
});

afterAll(async () => {
  if (!httpServer) return;
  await new Promise<void>((resolveClose, rejectClose) => {
    httpServer.close((error) => (error ? rejectClose(error) : resolveClose()));
  });
});

describe('smrt-dev-mcp MCP conformance', () => {
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
