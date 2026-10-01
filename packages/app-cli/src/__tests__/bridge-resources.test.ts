import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpStdioBridge } from '../bridge.js';

const prefix = 'SMRT_BRIDGE_RESOURCES_TEST';
const uri = 'ui://bridge/v1/view.html';
const meta = {
  ui: { resourceUri: uri },
  'example.org/extension': { value: 'kept' },
};
afterEach(() => {
  delete process.env[`${prefix}_TOKEN`];
  delete process.env[`${prefix}_SERVER_URL`];
  delete process.env[`${prefix}_CLI_CONFIG`];
});

async function withBridge(
  run: (client: Client, requests: Request[]) => Promise<void>,
  broken = false,
  mismatchedToken = false,
) {
  const dir = await mkdtemp(join(tmpdir(), 'bridge-resource-'));
  process.env[`${prefix}_CLI_CONFIG`] = join(dir, 'config.json');
  const requests: Request[] = [];
  process.env[`${prefix}_TOKEN`] = 'bound-test-credential';
  process.env[`${prefix}_SERVER_URL`] = 'https://server.test';
  const upstream = createMcpHandler(() => {
    const server = new Server(
      { name: 'upstream', version: '1' },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'view',
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          _meta: meta,
        },
      ],
    }));
    server.setRequestHandler('tools/call', async () => ({
      content: [{ type: 'text', text: 'headless' }],
      structuredContent: { value: 1 },
      _meta: meta,
    }));
    server.setRequestHandler('resources/list', async () => ({
      resources: [
        {
          uri,
          name: 'view',
          mimeType: 'text/html;profile=mcp-app',
          _meta: meta,
        },
      ],
    }));
    server.setRequestHandler('resources/read', async (request) => ({
      contents: [
        {
          uri: request.params.uri,
          text: '<title>Static</title>',
          mimeType: 'text/html;profile=mcp-app',
          _meta: { ui: { csp: { connectDomains: [] } } },
        },
      ],
    }));
    return server;
  });
  const bridge = createMcpStdioBridge({
    envPrefix: prefix,
    defaultServerUrl: 'https://server.test',
    serverInfo: { name: 'bridge', version: '1' },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      expect(init?.redirect).toBe('error');
      return broken
        ? new Response('{invalid secret upstream}', {
            headers: { 'content-type': 'application/json' },
          })
        : upstream.fetch(request);
    },
  });
  // A token without its exact environment server binding is never attached.
  if (mismatchedToken) delete process.env[`${prefix}_SERVER_URL`];
  const local = createMcpHandler(() => bridge.server, {
    legacy: 'reject',
    maxSubscriptions: 0,
  });
  const client = new Client(
    { name: 'local-host', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/bridge'), {
        fetch: (input, init) => local.fetch(new Request(input, init)),
      }),
    );
    await run(client, requests);
  } finally {
    await client.close();
    await rm(dir, { recursive: true, force: true });
  }
}

describe('modern local bridge resources', () => {
  it('forwards resource metadata through an actual modern stdio client', async () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
    const transport = new StdioClientTransport({
      command: resolve(root, '../../node_modules/.bin/tsx'),
      args: ['src/__tests__/fixtures/mcp-resource-bridge.ts'],
      cwd: root,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'stdio-host', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(transport);
      expect(client.getServerCapabilities()?.resources).toEqual({});
      const catalog = await client.listResources();
      expect(catalog.resources[0].uri).toBe('ui://stdio/v1/view.html');
      expect(
        (await client.readResource({ uri: catalog.resources[0].uri }))
          .contents[0],
      ).toMatchObject({
        text: '<title>stdio</title>',
        _meta: { ui: { permissions: {} } },
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });
  it('forwards native resources, tool schemas and extension metadata with bound credentials', async () => {
    await withBridge(async (client, requests) => {
      expect(client.getServerCapabilities()?.resources).toEqual({});
      expect((await client.listTools()).tools[0]).toMatchObject({
        outputSchema: { type: 'object' },
        _meta: meta,
      });
      expect(
        await client.callTool({ name: 'view', arguments: {} }),
      ).toMatchObject({ structuredContent: { value: 1 }, _meta: meta });
      expect((await client.listResources()).resources[0]._meta).toEqual(meta);
      expect((await client.readResource({ uri })).contents[0]).toMatchObject({
        text: '<title>Static</title>',
        _meta: { ui: { csp: { connectDomains: [] } } },
      });
      expect(requests.length).toBeGreaterThan(3);
      expect(
        requests.every(
          (request) =>
            request.url === 'https://server.test/api/mcp' &&
            request.headers.get('authorization') ===
              'Bearer bound-test-credential',
        ),
      ).toBe(true);
    });
  });
  it('never forwards credentials without their exact selected server binding', async () => {
    await withBridge(
      async (client, requests) => {
        await client.listResources();
        expect(
          requests.every((request) => !request.headers.has('authorization')),
        ).toBe(true);
      },
      false,
      true,
    );
  });
  it('fails safely for malformed/upstream protocol failures', async () => {
    await withBridge(async (client) => {
      await expect(client.listResources()).rejects.toThrow(
        'MCP upstream request failed.',
      );
    }, true);
  });
  it.each([
    '//evil.test/mcp',
    'https://evil.test/mcp',
    '/\\evil.test',
  ])('rejects unsafe endpoint paths %s', (mcpPath) => {
    expect(() =>
      createMcpStdioBridge({
        envPrefix: prefix,
        serverInfo: { name: 'bridge', version: '1' },
        mcpPath,
      }),
    ).toThrow('same-server');
  });
});
