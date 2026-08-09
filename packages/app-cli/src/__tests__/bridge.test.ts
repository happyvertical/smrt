import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SMRT_MCP_RESULT_METADATA_KEY as CONTRACT_METADATA_KEY } from '@happyvertical/smrt-users/app-contract';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { describe, expect, it } from 'vitest';
import {
  formatMcpCallResult,
  SMRT_MCP_RESULT_METADATA_KEY,
  toMcpTransportError,
} from '../bridge.js';

const packageRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
);
const repoRoot = resolve(packageRoot, '..', '..');
const tsxBin = join(repoRoot, 'node_modules', '.bin', 'tsx');

function resultMetadata(result: object): unknown {
  return (result as { _meta?: Record<string, unknown> })._meta?.[
    SMRT_MCP_RESULT_METADATA_KEY
  ];
}

function errorMetadata(error: object): unknown {
  return (error as { data?: Record<string, unknown> }).data?.[
    SMRT_MCP_RESULT_METADATA_KEY
  ];
}

describe('formatMcpCallResult', () => {
  it('re-exports the canonical artifact selector', () => {
    expect(SMRT_MCP_RESULT_METADATA_KEY).toBe(CONTRACT_METADATA_KEY);
  });

  it('returns an MCP-native error with redacted structured metadata', () => {
    const result = formatMcpCallResult({
      ok: false,
      status: 503,
      error: {
        code: 'upstream_timeout',
        message: 'Bearer bridge-secret failed',
        details: { refreshToken: 'bridge-secret', retryAfter: 5 },
        retryable: true,
        correlationId: 'corr-bridge',
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: 'Bearer [REDACTED] failed' },
    ]);
    expect(resultMetadata(result)).toEqual({
      code: 'upstream_timeout',
      message: 'Bearer [REDACTED] failed',
      details: { refreshToken: '[REDACTED]', retryAfter: 5 },
      retryable: true,
      correlationId: 'corr-bridge',
    });
    expect(
      (result as { structuredContent?: unknown }).structuredContent,
    ).toBeUndefined();
  });

  it('redacts remote MCP error text and ListTools JSON-RPC error data', () => {
    const result = formatMcpCallResult({
      ok: true,
      result: {
        content: [{ type: 'text', text: 'Bearer remote-secret failed' }],
        isError: true,
      },
      metadata: { code: 'ok' },
    });
    expect(result.content).toEqual([
      { type: 'text', text: 'Bearer [REDACTED] failed' },
    ]);
    expect(resultMetadata(result)).toMatchObject({
      code: 'mcp_tool_error',
      message: 'Bearer [REDACTED] failed',
    });

    const error = toMcpTransportError({
      code: 'tools_unavailable',
      message: 'Bearer list-secret failed',
      details: { authorization: 'Bearer list-secret' },
    });
    expect(error.message).toContain('Bearer [REDACTED] failed');
    expect(error.message).not.toContain('list-secret');
    expect(errorMetadata(error)).toEqual({
      code: 'tools_unavailable',
      message: 'Bearer [REDACTED] failed',
      details: { authorization: '[REDACTED]' },
    });
  });
});

describe('runMcpStdioBridge', () => {
  it('negotiates MCP 2026-07-28 and preserves bridged error redaction', async () => {
    expect(existsSync(tsxBin)).toBe(true);
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: ['src/__tests__/fixtures/mcp-stdio-bridge.ts'],
      cwd: packageRoot,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'smrt-app-cli-test-client', version: '1.0.0' },
      {
        capabilities: {},
        versionNegotiation: { mode: { pin: '2026-07-28' } },
      },
    );

    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
      expect(client.getServerVersion()).toMatchObject({
        name: 'smrt-app-cli-test',
        version: '1.0.0',
      });

      const tools = await client.listTools();
      expect(tools).toMatchObject({
        ttlMs: 86_400_000,
        cacheScope: 'private',
      });
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'I_list',
        'antelope',
        'i_list',
        'zebra',
      ]);

      const result = await client.callTool({
        name: 'echo',
        arguments: { text: 'hello' },
      });
      expect(result.content).toEqual([
        { type: 'text', text: 'Bearer [REDACTED] echoed' },
      ]);
      expect(resultMetadata(result)).toMatchObject({
        code: 'mcp_tool_error',
        message: 'Bearer [REDACTED] echoed',
      });
    } finally {
      await client.close();
      await transport.close();
    }
  });

  it('preserves legacy stdio negotiation through the same factory', async () => {
    const transport = new StdioClientTransport({
      command: tsxBin,
      args: ['src/__tests__/fixtures/mcp-stdio-bridge.ts'],
      cwd: packageRoot,
      stderr: 'pipe',
    });
    const client = new Client(
      { name: 'smrt-app-cli-legacy-test-client', version: '1.0.0' },
      { capabilities: {} },
    );

    try {
      await client.connect(transport);
      expect(client.getNegotiatedProtocolVersion()).toBe('2025-11-25');
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        'I_list',
        'antelope',
        'i_list',
        'zebra',
      ]);
    } finally {
      await client.close();
      await transport.close();
    }
  });
});
