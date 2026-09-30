/** SDK feasibility probe only; the generated-server suite remains authoritative. */
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  createMcpHandler,
  PROTOCOL_VERSION_META_KEY,
  ProtocolError,
  ProtocolErrorCode,
  Server,
} from '@modelcontextprotocol/server';
import { describe, expect, it } from 'vitest';

const uri = 'ui://smrt-compatibility/opportunities';
const metadata = {
  ui: { resourceUri: uri },
  'openai/ui': { entrypoints: [{ type: 'global' }] },
};
const handler = createMcpHandler(() => {
  const server = new Server(
    { name: 'sdk-feasibility-only', version: '0.0.0' },
    { capabilities: { tools: {}, resources: {} } },
  );
  server.setRequestHandler('tools/list', async () => ({
    tools: [
      {
        name: 'opportunities',
        inputSchema: { type: 'object' },
        _meta: metadata,
      },
    ],
  }));
  server.setRequestHandler('tools/call', async (request) => {
    if (request.params.name !== 'opportunities') {
      throw new ProtocolError(ProtocolErrorCode.InvalidParams, 'Unknown tool');
    }
    return {
      content: [{ type: 'text', text: 'No opportunities' }],
      structuredContent: { opportunities: [] },
    };
  });
  server.setRequestHandler('resources/list', async () => ({
    resources: [
      { uri, name: 'opportunities', mimeType: 'text/html;profile=mcp-app' },
    ],
  }));
  server.setRequestHandler('resources/read', async (request) => {
    if (request.params.uri !== uri) {
      throw new ProtocolError(
        ProtocolErrorCode.InvalidParams,
        'Unknown resource',
      );
    }
    return {
      contents: [
        {
          uri,
          mimeType: 'text/html;profile=mcp-app',
          text: '<!doctype html><title>Probe</title>',
        },
      ],
    };
  });
  return server;
});

async function request(method: string, params: Record<string, unknown> = {}) {
  const response = await handler.fetch(
    new Request('http://localhost/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'mcp-method': method,
        'mcp-protocol-version': '2026-07-28',
        ...(typeof params.name === 'string'
          ? { 'mcp-name': params.name }
          : typeof params.uri === 'string'
            ? { 'mcp-name': params.uri }
            : {}),
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
              name: 'compatibility-probe',
              version: '0.0.0',
            },
            [CLIENT_CAPABILITIES_META_KEY]: {},
            'example.org/unknown': 'ignored',
          },
        },
      }),
    }),
  );
  return response.json();
}

describe('SDK v2 MCP Apps wire feasibility (not host conformance)', () => {
  it('discovers modern tools and resources without requiring UI capabilities', async () => {
    expect((await request('server/discover')).result).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {}, resources: {} },
    });
    expect((await request('tools/list')).result.tools[0]._meta).toEqual(
      metadata,
    );
    expect((await request('resources/list')).result.resources[0].uri).toBe(uri);
  });
  it('accepts empty entrypoint arguments and preserves a useful headless result', async () => {
    expect(
      (await request('tools/call', { name: 'opportunities', arguments: {} }))
        .result,
    ).toMatchObject({
      content: [{ type: 'text', text: 'No opportunities' }],
      structuredContent: { opportunities: [] },
    });
    const resource = await request('resources/read', { uri });
    expect(resource.error, JSON.stringify(resource)).toBeUndefined();
    expect(resource.result.contents[0]).toMatchObject({
      uri,
      mimeType: 'text/html;profile=mcp-app',
      text: '<!doctype html><title>Probe</title>',
    });
  });
  it('preserves failures for unknown targets and malformed request parameters', async () => {
    for (const [method, params] of [
      ['tools/call', { name: 'missing' }],
      ['resources/read', { uri: 'ui://missing' }],
      ['resources/read', { uri: 42 }],
    ] as const) {
      expect((await request(method, params)).error).toBeDefined();
    }
  });
});
