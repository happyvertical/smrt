import { createMcpHandler, Server } from '@modelcontextprotocol/server';
import { runMcpStdioBridge } from '../../bridge.js';

const uri = 'ui://stdio/v1/view.html';
const handler = createMcpHandler(
  () => {
    const server = new Server(
      { name: 'remote', version: '1' },
      { capabilities: { tools: {}, resources: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [
        {
          name: 'view',
          inputSchema: { type: 'object' },
          _meta: { ui: { resourceUri: uri } },
        },
      ],
    }));
    server.setRequestHandler('resources/list', async () => ({
      resources: [{ uri, name: 'View', mimeType: 'text/html;profile=mcp-app' }],
    }));
    server.setRequestHandler('resources/read', async () => ({
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: '<title>stdio</title>',
          _meta: { ui: { permissions: {} } },
        },
      ],
    }));
    return server;
  },
  { legacy: 'reject', maxSubscriptions: 0 },
);
await runMcpStdioBridge({
  envPrefix: 'SMRT_RESOURCE_STDIO_TEST',
  defaultServerUrl: 'https://stdio.test',
  serverInfo: { name: 'resource-bridge', version: '1' },
  fetch: (input, init) => handler.fetch(new Request(input, init)),
});
