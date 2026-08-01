import { SMRT_MCP_RESULT_METADATA_KEY as CONTRACT_METADATA_KEY } from '@happyvertical/smrt-users/app-contract';
import { describe, expect, it } from 'vitest';
import {
  formatMcpCallResult,
  SMRT_MCP_RESULT_METADATA_KEY,
  toMcpTransportError,
} from '../bridge.js';

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
