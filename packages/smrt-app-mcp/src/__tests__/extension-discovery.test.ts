import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpProtocolServer } from '../protocol.js';
import { createMcpAppServer } from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';

async function connect(route: ReturnType<typeof mountMcpRoute>) {
  const client = new Client(
    { name: 'extension-test', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://synthetic.test/mcp'), {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          return route({ request, url: new URL(request.url) });
        },
      }),
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}
const definition = {
  name: 'settings_read',
  description: 'Synthetic read',
  inputSchema: { type: 'object' as const },
  outputSchema: { type: 'object' as const },
  effect: 'read' as const,
  idempotent: true,
  openWorld: false,
  execute: () => ({ content: [{ type: 'text' as const, text: 'Synthetic' }] }),
};
function app() {
  return createMcpAppServer({
    serverInfo: { name: 'test', version: '1' },
    smrtOptions: () => ({}),
    allowedClassNames: [],
    workflowTools: [definition],
    toolPolicy: ({ principal }) =>
      principal?.id === 'owner' && principal.tenantId === 'a',
  });
}
describe('request-local extension discovery', () => {
  it('refuses async extension options on the synchronous factory', () => {
    expect(() =>
      createMcpProtocolServer(app(), { extensions: () => ({}) } as never),
    ).toThrow('createMcpProtocolServerForRequest');
  });
  it('derives metadata from the same principal-filtered catalog and never caches it globally', async () => {
    let principal = { id: 'owner', tenantId: 'a' };
    const route = mountMcpRoute(app(), {
      resolvePrincipal: () => principal,
      extensions: ({ tools, principal: current }) => {
        expect(current).toEqual(principal);
        const extension: Record<string, Record<string, unknown>> = {};
        if (tools.length)
          extension['example/settings'] = { readTool: tools[0].name };
        return extension;
      },
    });
    const first = await connect(route);
    expect(JSON.stringify(first.getServerCapabilities())).toContain(
      'example/settings',
    );
    await first.close();
    principal = { id: 'owner', tenantId: 'b' };
    const second = await connect(route);
    expect(JSON.stringify(second.getServerCapabilities())).not.toContain(
      'example/settings',
    );
    await second.close();
  });
  it('retains ordinary tools when no extension adapter is installed', async () => {
    const client = await connect(
      mountMcpRoute(app(), {
        resolvePrincipal: () => ({ id: 'owner', tenantId: 'a' }),
      }),
    );
    try {
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(
        ['settings_read'],
      );
    } finally {
      await client.close();
    }
  });
  it('fails closed on callback errors and malformed/unbounded extension values without leaking data', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      { broken: 'not an object' },
      { x: { huge: 'x'.repeat(65537) } },
      { x: cyclic },
      { x: new Date() },
      {
        x: {
          get secret() {
            throw new Error('private secret');
          },
        },
      },
    ]) {
      await expect(
        connect(mountMcpRoute(app(), { extensions: () => value as never })),
      ).rejects.toThrow('HTTP 500');
    }
    await expect(
      connect(
        mountMcpRoute(app(), {
          extensions: () => {
            throw new Error('private secret');
          },
        }),
      ),
    ).rejects.toThrow('HTTP 500');
  });
});
