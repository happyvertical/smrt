/**
 * Configurable MCP endpoint path (#3413): `createAppCli({ mcpPath })`,
 * `startMcpBridge({ mcpPath })`, `smrt-app --mcp-path`, and the bridge's
 * upstream target. The default stays `/api/mcp`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

const runMcpStdioBridge = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../bridge.js')>()),
  runMcpStdioBridge,
}));

const { createMcpStdioBridge } = await import('../bridge.js');
const { createAppCli } = await import('../index.js');
const { parseAppCliExecutableConfig } = await import('../executable.js');

const prefix = 'SMRT_MCP_PATH_TEST';
afterEach(() => {
  runMcpStdioBridge.mockClear();
  delete process.env[`${prefix}_TOKEN`];
  delete process.env[`${prefix}_SERVER_URL`];
  delete process.env[`${prefix}_CLI_CONFIG`];
});

describe('startMcpBridge mcpPath', () => {
  it('keeps the bridge default when no path is configured', async () => {
    await createAppCli({ name: 'acme' }).startMcpBridge();
    const [options] = runMcpStdioBridge.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(options).not.toHaveProperty('mcpPath');
    expect(options.serverInfo).toEqual({ name: 'acme-mcp', version: '0.0.0' });
  });

  it('uses the CLI option and lets a call override it', async () => {
    const cli = createAppCli({ name: 'acme', mcpPath: '/mcp' });
    await cli.startMcpBridge();
    await cli.startMcpBridge({ name: 'acme-mcp', mcpPath: '/v2/mcp' });
    expect(
      runMcpStdioBridge.mock.calls.map(
        (call) => (call as unknown as [{ mcpPath?: string }])[0].mcpPath,
      ),
    ).toEqual(['/mcp', '/v2/mcp']);
  });
});

describe('smrt-app --mcp-path', () => {
  const ENV = {
    SMRT_APP_NAME: 'work',
    SMRT_APP_ENV_PREFIX: 'WORK',
    SMRT_APP_CONFIG_DIR: 'happyvertical-work',
    SMRT_APP_DEFAULT_SERVER_URL: 'http://127.0.0.1:5173',
  };

  it('reads the path from argv or SMRT_APP_MCP_PATH', () => {
    expect(
      parseAppCliExecutableConfig(['--mcp-path', '/mcp'], ENV).cliOptions
        .mcpPath,
    ).toBe('/mcp');
    expect(
      parseAppCliExecutableConfig([], { ...ENV, SMRT_APP_MCP_PATH: '/mcp' })
        .cliOptions.mcpPath,
    ).toBe('/mcp');
    expect(parseAppCliExecutableConfig([], ENV).cliOptions).not.toHaveProperty(
      'mcpPath',
    );
  });

  it.each([
    'mcp',
    '//evil.test/mcp',
    '/mcp?x=1',
    '/mcp#x',
    '/\\evil',
  ])('rejects the unsafe path %s', (path) => {
    expect(() =>
      parseAppCliExecutableConfig([`--mcp-path=${path}`], ENV),
    ).toThrow('Invalid MCP path configuration.');
  });
});

describe('bridge upstream target', () => {
  it('forwards to the configured same-server path with the bound bearer', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'bridge-mcp-path-'));
    process.env[`${prefix}_CLI_CONFIG`] = join(dir, 'config.json');
    process.env[`${prefix}_TOKEN`] = 'smrt_mcp_test-credential';
    process.env[`${prefix}_SERVER_URL`] = 'http://127.0.0.1:5173';
    const requests: Request[] = [];
    const upstream = createMcpHandler(() => {
      const server = new Server(
        { name: 'upstream', version: '1' },
        { capabilities: { tools: {} } },
      );
      server.setRequestHandler('tools/list', async () => ({ tools: [] }));
      return server;
    });
    const bridge = createMcpStdioBridge({
      envPrefix: prefix,
      requireSecureServerUrl: true,
      mcpPath: '/mcp',
      serverInfo: { name: 'bridge', version: '1' },
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push(request);
        return upstream.fetch(request);
      },
    });
    const local = createMcpHandler(() => bridge.server, {
      legacy: 'reject',
      maxSubscriptions: 0,
    });
    const client = new Client(
      { name: 'host', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    try {
      await client.connect(
        new StreamableHTTPClientTransport(new URL('http://localhost/bridge'), {
          fetch: (input, init) => local.fetch(new Request(input, init)),
        }),
      );
      expect((await client.listTools()).tools).toEqual([]);
      expect(requests.length).toBeGreaterThan(0);
      for (const request of requests) {
        expect(request.url).toBe('http://127.0.0.1:5173/mcp');
        expect(request.headers.get('authorization')).toBe(
          'Bearer smrt_mcp_test-credential',
        );
      }
    } finally {
      await client.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
