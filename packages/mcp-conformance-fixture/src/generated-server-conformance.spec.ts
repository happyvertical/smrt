/**
 * Official MCP conformance suite against a generated Tier-1 runtime server
 * (#2146).
 *
 * The spec generates a real server from `MCPGenerator` (the same
 * `mcp-runtime-template.ts` bootstrap every downstream app bakes), runs it as
 * the stdio process it ships as, and bridges it to the HTTP-only conformance
 * CLI through a thin forwarder: one SDK `Client` connected to the generated
 * server over stdio, mirrored per-request onto a stateless
 * `StreamableHTTPServerTransport`. tools/list, tools/call, and every result
 * shape the generated server produces pass through the forwarder verbatim;
 * only the transport envelope (initialize response assembly, ping) is the
 * forwarder's own — the generated template stays stdio-only by design
 * (#1540 documents its trust boundary; a native HTTP endpoint is #2147).
 *
 * `conformance-baseline.yml` lists scenarios that cannot pass for a
 * generated tools-only server (suite fixture tools, undeclared optional
 * capabilities). Unexpected failures AND stale baseline entries both fail.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPGenerator } from '@happyvertical/smrt-core/generators/mcp';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import './fixture-objects.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, '..');
const repoRoot = resolve(packageRoot, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');
const conformanceBin = join(packageRoot, 'node_modules', '.bin', 'conformance');
const baselinePath = join(packageRoot, 'conformance-baseline.yml');
const generatedDir = join(packageRoot, '.generated-tmp');
const generatedServerPath = join(generatedDir, 'index.ts');

const SPEC_VERSION = '2025-11-25';

let stdioClient: Client;
let stdioTransport: StdioClientTransport;
let httpServer: ReturnType<typeof createHttpServer>;
let mcpUrl: string;
let allowedHosts: string[] = [];

beforeAll(async () => {
  // 1. Generate the Tier-1 server from the registered fixture objects using
  //    the exact template downstream builds consume.
  await rm(generatedDir, { force: true, recursive: true });
  await mkdir(generatedDir, { recursive: true });
  const generator = new MCPGenerator(
    {
      name: 'smrt-conformance-fixture',
      version: '0.0.0',
      description: 'Generated-template conformance fixture server',
    },
    { user: { id: 'conformance-fixture' } },
  );
  await generator.generateServer({ outputPath: generatedServerPath });

  // 2. Run the generated server exactly as shipped: a stdio process.
  stdioTransport = new StdioClientTransport({
    command: tsxBin,
    args: [generatedServerPath],
    cwd: packageRoot,
    stderr: 'pipe',
  });
  stdioClient = new Client(
    { name: 'conformance-forwarder', version: '0.0.0' },
    { capabilities: {} },
  );
  await stdioClient.connect(stdioTransport);

  const remoteInfo = stdioClient.getServerVersion();
  const remoteCapabilities = stdioClient.getServerCapabilities();
  if (!remoteInfo || !remoteCapabilities) {
    throw new Error('generated server did not report serverInfo/capabilities');
  }

  // 3. Mirror the generated server per-request onto the HTTP transport the
  //    conformance CLI requires, forwarding through the single stdio client.
  httpServer = createHttpServer(async (req, res) => {
    try {
      const forwarder = new Server(
        { name: remoteInfo.name, version: remoteInfo.version },
        { capabilities: remoteCapabilities },
      );
      forwarder.setRequestHandler(ListToolsRequestSchema, async () =>
        stdioClient.listTools(),
      );
      forwarder.setRequestHandler(CallToolRequestSchema, async (request) =>
        stdioClient.callTool({
          name: request.params.name,
          arguments: request.params.arguments,
        }),
      );
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
        void forwarder.close();
      };
      res.on('finish', cleanup);
      res.on('close', cleanup);
      await forwarder.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('[generated-conformance] request error', error);
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
  await stdioClient?.close();
  await stdioTransport?.close();
  if (httpServer) {
    await new Promise<void>((resolveClose, rejectClose) => {
      httpServer.close((error) =>
        error ? rejectClose(error) : resolveClose(),
      );
    });
  }
  if (process.env.MCP_CONFORMANCE_KEEP_GENERATED !== 'true') {
    await rm(generatedDir, { force: true, recursive: true });
  }
});

describe('generated Tier-1 template MCP conformance', () => {
  // Direct stdio lifecycle coverage of the REAL generated process — the
  // forwarder below never handles these: `client.connect()` in beforeAll
  // already performed the initialize handshake against the generated
  // server, and these assertions pin the identity, capabilities, listing,
  // and tools/call error contract it answered with.
  it('serves the MCP lifecycle directly over stdio', async () => {
    expect(stdioClient.getServerVersion()).toMatchObject({
      name: 'smrt-conformance-fixture',
      version: '0.0.0',
    });
    const capabilities = stdioClient.getServerCapabilities();
    expect(capabilities?.tools).toBeDefined();

    const { tools } = await stdioClient.listTools();
    const names = tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'conformancewidget_list',
        'conformancewidget_get',
        'conformancegadget_list',
        'conformancegadget_get',
        'conformancegadget_create',
      ]),
    );
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema).toMatchObject({ type: 'object' });
    }

    // tools/call against the real generated switch: unknown tools must come
    // back as an in-band isError text result, not a protocol failure.
    const errorResult = await stdioClient.callTool({
      name: 'test_simple_text',
      arguments: {},
    });
    expect(errorResult.isError).toBe(true);
    const [first] = errorResult.content as Array<{
      type: string;
      text?: string;
    }>;
    expect(first?.type).toBe('text');
    expect(first?.text).toContain('Unknown tool');
  });

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
