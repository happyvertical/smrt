import {
  createMcpAppServer,
  type McpAppPrincipal,
} from '@happyvertical/smrt-app-mcp';
import { mountMcpRoute } from '@happyvertical/smrt-app-mcp/sveltekit';
import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';
import { expect, it } from 'vitest';
import { withOpenAiFileEntrypoint } from './files-server.js';

it('carries exact file entrypoint over native v2 HTTP and preserves per-request domain authority', async () => {
  const owner = { id: 'synthetic-owner', tenantId: 'synthetic-tenant' };
  let principal: McpAppPrincipal | null = owner;
  let revoked = false;
  let executions = 0;
  const input = {
    file: { name: 'synthetic.txt', resourceUri: 'host-resource://synthetic' },
  };
  const server = createMcpAppServer({
    serverInfo: { name: 'synthetic-files', version: '1' },
    allowedClassNames: [],
    smrtOptions: () => ({}),
    resources: [
      {
        name: 'File',
        uri: 'ui://synthetic/v1/file',
        version: 'v1',
        html: '<!doctype html><title>Synthetic</title>',
      },
    ],
    workflowTools: [
      withOpenAiFileEntrypoint(
        {
          name: 'file_view',
          description: 'View synthetic file',
          effect: 'read',
          idempotent: true,
          openWorld: false,
          inputSchema: { type: 'object' },
          outputSchema: { type: 'object' },
          ui: { resourceUri: 'ui://synthetic/v1/file' },
          execute: (context) => {
            // Existing provider is responsible for matching a grant to current identity;
            // tool metadata or a URI alone does not create that grant.
            if (
              context.principal?.id !== owner.id ||
              context.principal.tenantId !== owner.tenantId ||
              revoked ||
              (context.arguments.file as { resourceUri: string })
                .resourceUri !== input.file.resourceUri
            )
              throw new Error('Provider grant denied');
            executions++;
            return {
              content: [
                {
                  type: 'text',
                  text: 'Open the authorized synthetic import/download workflow',
                },
              ],
              structuredContent: { title: 'Synthetic file' },
            };
          },
        },
        ['.txt'],
      ),
    ],
    resourcePolicy: ({ principal, resource }) =>
      !revoked &&
      principal?.id === owner.id &&
      principal.tenantId === owner.tenantId &&
      resource.uri === 'ui://synthetic/v1/file',
    toolPolicy: ({ principal }) =>
      !revoked &&
      principal?.id === owner.id &&
      principal.tenantId === owner.tenantId,
  });
  const mount = mountMcpRoute(server, { resolvePrincipal: () => principal });
  const client = new Client(
    { name: 'file-client', version: '1' },
    { versionNegotiation: { mode: { pin: '2026-07-28' } } },
  );
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL('https://synthetic.test/mcp'), {
        fetch: async (request, init) => {
          const req = new Request(request, init);
          return mount({ request: req, url: new URL(req.url) });
        },
      }),
    );
    await expect(
      client.readResource({ uri: 'ui://synthetic/v1/file' }),
    ).resolves.toHaveProperty('contents.0.uri', 'ui://synthetic/v1/file');
    const catalog = await client.listTools();
    expect(catalog.tools[0]._meta?.['openai/ui']).toEqual({
      entrypoints: [{ type: 'file', extensions: ['.txt'] }],
    });
    expect(
      await client.callTool({ name: 'file_view', arguments: input }),
    ).toHaveProperty('structuredContent.title', 'Synthetic file');
    await expect(
      client.callTool({
        name: 'file_view',
        arguments: {
          file: { ...input.file, resourceUri: 'host-resource://guessed' },
        },
      }),
    ).rejects.toThrow();
    await expect(
      client.callTool({
        name: 'file_view',
        arguments: {
          file: { ...input.file, resourceUri: 'file:///etc/passwd' },
        },
      }),
    ).rejects.toThrow();
    for (const actor of [
      null,
      { ...owner, id: 'other' },
      { ...owner, tenantId: 'other' },
    ]) {
      principal = actor;
      await expect(
        client.readResource({ uri: 'ui://synthetic/v1/file' }),
      ).rejects.toThrow();
      expect(await server.listTools({ principal })).toEqual([]);
      await expect(
        client.callTool({ name: 'file_view', arguments: input }),
      ).rejects.toThrow();
    }
    principal = owner;
    revoked = true;
    await expect(
      client.readResource({ uri: 'ui://synthetic/v1/file' }),
    ).rejects.toThrow();
    await expect(
      client.callTool({ name: 'file_view', arguments: input }),
    ).rejects.toThrow();
    expect(executions).toBe(1);
  } finally {
    await client.close();
  }
});
