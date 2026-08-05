import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMcpCommand } from '../commands/mcp.js';
import { createAppCli } from '../index.js';

const originalExitCode = process.exitCode;
const originalExitTestServerUrl = process.env.MCP_EXIT_TEST_SERVER_URL;

afterEach(() => {
  process.exitCode = originalExitCode;
  if (originalExitTestServerUrl === undefined) {
    delete process.env.MCP_EXIT_TEST_SERVER_URL;
  } else {
    process.env.MCP_EXIT_TEST_SERVER_URL = originalExitTestServerUrl;
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('mcp CLI command', () => {
  it('prints the generic structured error envelope as JSON', async () => {
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const stderr = { write: vi.fn() } as unknown as NodeJS.WriteStream;

    const succeeded = await runMcpCommand(
      {
        context: { envPrefix: 'MCPCLI', defaultServerUrl: 'https://app.test' },
        stdout,
        stderr,
        fetch: async () =>
          new Response(
            JSON.stringify({
              error: {
                code: 'retry_later',
                details: { authorization: 'Bearer not-for-output' },
                message: 'Bearer not-for-output failed',
                retryable: true,
              },
            }),
            { status: 503, headers: { 'content-type': 'application/json' } },
          ),
      },
      ['tools'],
    );

    const output = JSON.parse(String((stdout.write as any).mock.calls[0][0]));
    expect(output).toEqual({
      ok: false,
      status: 503,
      error: {
        code: 'retry_later',
        message: 'Bearer [REDACTED] failed',
        details: { authorization: '[REDACTED]' },
        retryable: true,
      },
    });
    expect(stderr.write).toHaveBeenCalledWith('Bearer [REDACTED] failed\n');
    expect(succeeded).toBe(false);
  });

  it('preserves a nonzero process exit status for envelope failures', async () => {
    process.exitCode = undefined;
    process.env.MCP_EXIT_TEST_SERVER_URL = 'https://app.test';
    vi.stubGlobal(
      'fetch',
      async () =>
        new Response(JSON.stringify({ error: { code: 'unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    await createAppCli({
      name: 'mcp-exit-test',
      defaultServerUrl: 'https://app.test',
    }).run(['mcp', 'tools']);

    expect(process.exitCode).toBe(1);
  });
});
