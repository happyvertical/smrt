import { runMcpStdioBridge } from '../../bridge.js';

const jsonHeaders = { 'content-type': 'application/json' };

await runMcpStdioBridge({
  envPrefix: 'SMRT_APP_CLI_STDIO_TEST',
  defaultServerUrl: 'https://bridge.test',
  serverInfo: { name: 'smrt-app-cli-test', version: '1.0.0' },
  fetch: async (input, init) => {
    const url = String(input);
    if (url.endsWith('/api/mcp/tools')) {
      return new Response(
        JSON.stringify({
          tools: [
            {
              name: 'echo',
              description: 'Echo through the HTTP bridge',
              inputSchema: { type: 'object' },
            },
          ],
        }),
        { headers: jsonHeaders },
      );
    }
    if (url.endsWith('/api/mcp/call') && init?.method === 'POST') {
      return new Response(
        JSON.stringify({
          content: [{ type: 'text', text: 'Bearer bridge-secret echoed' }],
          isError: true,
        }),
        { headers: jsonHeaders },
      );
    }
    return new Response('not found', { status: 404 });
  },
});
