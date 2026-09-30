import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-core/generators/mcp', async (load) => ({
  ...(await load<object>()),
  MCPGenerator: class {
    async generateTools() {
      return [];
    }
  },
  MCP_STABLE_CATALOG_TTL_MS: 86400000,
}));

import { MCP_APP_RESOURCE_MIME, prepareMcpAppResource } from '../resources.js';
import { createMcpAppServer } from '../server.js';
import { mountMcpRoute } from '../sveltekit.js';

const definition = {
  uri: 'ui://app/v1/view.html',
  version: 'v1',
  name: 'View',
  html: '<!doctype html><title>View</title>',
};
const base = {
  smrtOptions: () => ({}),
  serverInfo: { name: 'resources', version: '1' },
  allowedClassNames: [],
};
const workflow = {
  name: 'view',
  description: 'View',
  inputSchema: { type: 'object' as const },
  outputSchema: { type: 'object' as const },
  effect: 'read' as const,
  idempotent: true,
  openWorld: false,
  ui: { resourceUri: definition.uri },
  execute: () => ({
    content: [{ type: 'text' as const, text: 'Complete headless output' }],
    structuredContent: { value: 1 },
  }),
};

describe('prebuilt resource declarations', () => {
  it('snapshots deterministic bytes, digest and secure metadata defaults', () => {
    const first = prepareMcpAppResource(definition);
    expect(first).toEqual(prepareMcpAppResource({ ...definition }));
    expect(first.descriptor.mimeType).toBe(MCP_APP_RESOURCE_MIME);
    expect(first.descriptor._meta.ui).toEqual({
      csp: {
        connectDomains: [],
        resourceDomains: [],
        frameDomains: [],
        baseUriDomains: [],
      },
      permissions: {},
    });
    expect(
      first.descriptor._meta['com.happyvertical.smrt/resource'].sha256,
    ).toMatch(/^[a-f0-9]{64}$/);
    expect(
      prepareMcpAppResource({ ...definition, html: `${definition.html} ` })
        .descriptor._meta,
    ).not.toEqual(first.descriptor._meta);
  });
  it.each([
    { uri: 'file:///etc/passwd' },
    { uri: 'ui://app/view.html' },
    { uri: 'ui://app/v1/view.html?tenant=x' },
    { html: 'a'.repeat(102401) },
    { html: '<img src="https://evil.test/x">' },
    { html: '<img title=">" src="https://evil.test/x">' },
    { html: '<div style=background:u\\72l(https://evil.test/x)></div>' },
    { html: '<img src="&#104;ttps://evil.test/x">' },
    { html: '<style>@import "https://evil.test/x";</style>' },
    { csp: { unknown: [] } },
    { csp: { connectDomains: ['https://*.test'] } },
    { permissions: { unknown: {} } },
    { permissions: { camera: { allow: true } } },
  ])('rejects malformed or undeclared input %j', (change) =>
    expect(() =>
      prepareMcpAppResource({ ...definition, ...change } as never),
    ).toThrow());
  it('allows explicitly declared assets and permissions', () => {
    expect(
      prepareMcpAppResource({
        ...definition,
        html: '<img src="https://cdn.test/x"><iframe src="https://frame.test/x"></iframe>',
        csp: {
          resourceDomains: ['https://cdn.test'],
          frameDomains: ['https://frame.test'],
        },
        permissions: { clipboardWrite: {} },
      }).descriptor._meta.ui.permissions,
    ).toEqual({ clipboardWrite: {} });
  });
  it('rejects duplicate declarations and dangling associations', async () => {
    expect(() =>
      createMcpAppServer({ ...base, resources: [definition, definition] }),
    ).toThrow('Duplicate');
    await expect(
      createMcpAppServer({ ...base, workflowTools: [workflow] }).listTools({
        principal: { id: 'owner' },
      }),
    ).rejects.toThrow('undeclared');
  });
});

describe('principal-bound resource catalog and reads', () => {
  it('rechecks actor, tenant, revocation and tool access without descriptor leaks', async () => {
    let revoked = false;
    const app = createMcpAppServer({
      ...base,
      resources: [definition],
      workflowTools: [workflow],
      resourcePolicy: ({ principal }) =>
        !revoked &&
        principal?.id === 'owner' &&
        principal.tenantId === 'tenant-a',
      toolPolicy: ({ principal }) =>
        principal?.scopes?.includes('view') === true,
    });
    const allowed = { id: 'owner', tenantId: 'tenant-a', scopes: ['view'] };
    expect(await app.listResources!({ principal: allowed })).toHaveLength(1);
    expect(
      (await app.readResource!({ uri: definition.uri, principal: allowed }))
        .text,
    ).toBe(definition.html);
    for (const principal of [
      null,
      {},
      { ...allowed, id: 'other' },
      { ...allowed, tenantId: 'tenant-b' },
      { ...allowed, scopes: [] },
    ]) {
      expect(await app.listResources!({ principal })).toEqual([]);
      await expect(
        app.readResource!({ uri: definition.uri, principal }),
      ).rejects.toThrow('MCP resource is not available.');
    }
    revoked = true;
    await expect(
      app.readResource!({ uri: definition.uri, principal: allowed }),
    ).rejects.toThrow('MCP resource is not available.');
    await expect(
      app.readResource!({ uri: 'ui://app/v1/guessed', principal: allowed }),
    ).rejects.toThrow('MCP resource is not available.');
  });
  it('requires explicit public static templates and fails closed on policy exceptions', async () => {
    const app = createMcpAppServer({
      ...base,
      resources: [{ ...definition, public: true }],
    });
    expect(await app.listResources!({})).toHaveLength(1);
    const denying = createMcpAppServer({
      ...base,
      resources: [{ ...definition, public: true }],
      resourcePolicy: () => {
        throw new Error('secret');
      },
    });
    expect(await denying.listResources!({})).toEqual([]);
    await expect(
      denying.readResource!({ uri: definition.uri }),
    ).rejects.toThrow('not available');
  });
  it('serves native SDK-v2 HTTP resources without UI capabilities and keeps headless results complete', async () => {
    let principal = { id: 'owner', tenantId: 'a' };
    const app = createMcpAppServer({
      ...base,
      resources: [definition],
      workflowTools: [workflow],
      resourcePolicy: ({ principal }) => principal?.tenantId === 'a',
    });
    const route = mountMcpRoute(app, { resolvePrincipal: () => principal });
    const responses: Response[] = [];
    const client = new Client(
      { name: 'native-client', version: '1' },
      { versionNegotiation: { mode: { pin: '2026-07-28' } } },
    );
    await client.connect(
      new StreamableHTTPClientTransport(new URL('http://localhost/mcp'), {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const response = await route({ request, url: new URL(request.url) });
          responses.push(response);
          return response;
        },
      }),
    );
    try {
      expect(client.getServerCapabilities()?.resources).toEqual({});
      expect((await client.listResources()).resources[0].mimeType).toBe(
        MCP_APP_RESOURCE_MIME,
      );
      expect(
        (await client.readResource({ uri: definition.uri })).contents[0],
      ).toMatchObject({
        text: definition.html,
        _meta: { ui: { permissions: {} } },
      });
      expect((await client.listTools()).tools[0]._meta?.ui).toEqual({
        resourceUri: definition.uri,
      });
      expect(
        await client.callTool({ name: 'view', arguments: {} }),
      ).toMatchObject(workflow.execute());
      await expect(client.readResource({ uri: 'not a uri' })).rejects.toThrow();
      await expect(
        client.readResource({ uri: 'ui://app/v1/unknown' }),
      ).rejects.toThrow('not available');
      principal = { id: 'owner', tenantId: 'b' };
      await expect(
        client.readResource({ uri: definition.uri }),
      ).rejects.toThrow('not available');
      expect(
        responses.every((response) => !response.headers.has('mcp-session-id')),
      ).toBe(true);
    } finally {
      await client.close();
    }
  });
});
