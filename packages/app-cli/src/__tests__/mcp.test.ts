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

describe('mcp remote client flags', () => {
  const SECRET = 'sk-super-secret-token-123';
  const context = {
    envPrefix: 'MCPREMOTE',
    defaultServerUrl: 'https://default.test',
  };
  const sink = () => ({ write: vi.fn() }) as unknown as NodeJS.WriteStream;
  const ok = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  it('lists tools on --url with a bearer from --token-env', async () => {
    const stdout = sink();
    const fetchMock = vi.fn(async () => ok({ tools: [] }));
    const succeeded = await runMcpCommand(
      {
        context,
        stdout,
        stderr: sink(),
        fetch: fetchMock as unknown as typeof fetch,
        env: { MY_TOKEN: SECRET },
      },
      ['tools', '--url', 'https://app.test/', '--token-env', 'MY_TOKEN'],
    );
    expect(succeeded).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe('https://app.test/api/mcp/tools');
    expect(new Headers(init.headers).get('authorization')).toBe(
      `Bearer ${SECRET}`,
    );
    expect(String((stdout.write as any).mock.calls[0][0])).not.toContain(
      SECRET,
    );
  });

  it('injects confirm only when --confirm is passed', async () => {
    const bodies: unknown[] = [];
    const fetchMock = vi.fn(async (_u: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return ok({ ok: true });
    });
    const run = (extra: string[]) =>
      runMcpCommand(
        {
          context,
          stdout: sink(),
          stderr: sink(),
          fetch: fetchMock as unknown as typeof fetch,
          env: { MY_TOKEN: SECRET },
        },
        [
          'call',
          'send',
          '{"id":"1"}',
          '--url',
          'https://app.test',
          '--token-env',
          'MY_TOKEN',
          ...extra,
        ],
      );
    await run([]);
    await run(['--confirm']);
    expect(bodies).toEqual([
      { name: 'send', arguments: { id: '1' } },
      { name: 'send', arguments: { id: '1', confirm: true } },
    ]);
  });

  it('rejects --confirm with non-object arguments', async () => {
    await expect(
      runMcpCommand(
        { context, stdout: sink(), stderr: sink(), fetch: vi.fn() as any },
        ['call', 'x', '[1]', '--confirm'],
      ),
    ).rejects.toThrow('JSON object');
  });

  it('names a missing env var without leaking anything', async () => {
    await expect(
      runMcpCommand({ context, env: {} }, ['tools', '--token-env', 'NOPE']),
    ).rejects.toThrow('NOPE is not set');
  });

  it('refuses to send an explicit token over plain http to a remote host', async () => {
    const fetchMock = vi.fn();
    await expect(
      runMcpCommand(
        { context, fetch: fetchMock as any, env: { MY_TOKEN: SECRET } },
        ['tools', '--url', 'http://evil.test', '--token-env', 'MY_TOKEN'],
      ),
    ).rejects.not.toThrow(SECRET);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('scrubs a server-echoed token from output and errors', async () => {
    const stdout = sink();
    const stderr = sink();
    const succeeded = await runMcpCommand(
      {
        context,
        stdout,
        stderr,
        fetch: (async () =>
          new Response(
            JSON.stringify({
              error: { code: 'bad', message: `key ${SECRET} rejected` },
            }),
            {
              status: 401,
              headers: { 'content-type': 'application/json' },
            },
          )) as unknown as typeof fetch,
        env: { MY_TOKEN: SECRET },
      },
      ['tools', '--url', 'https://app.test', '--token-env', 'MY_TOKEN'],
    );
    expect(succeeded).toBe(false);
    expect(JSON.stringify((stdout.write as any).mock.calls)).not.toContain(
      SECRET,
    );
    expect(JSON.stringify((stderr.write as any).mock.calls)).not.toContain(
      SECRET,
    );
  });

  it('honors --mcp-path', async () => {
    const fetchMock = vi.fn(async () => ok({}));
    await runMcpCommand(
      { context, stdout: sink(), stderr: sink(), fetch: fetchMock as any },
      ['tools', '--mcp-path', '/mcp', '--url', 'https://app.test'],
    );
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe(
      'https://app.test/mcp/tools',
    );
  });

  it('refuses a token for an http remote URL from env or stored config', async () => {
    const fetchMock = vi.fn();
    const prev = process.env.MCPSEC_SERVER_URL;
    process.env.MCPSEC_SERVER_URL = 'http://remote.test';
    try {
      const err = await runMcpCommand(
        {
          context: { envPrefix: 'MCPSEC' },
          fetch: fetchMock as any,
          env: { MY_TOKEN: SECRET },
        },
        ['tools', '--token-env', 'MY_TOKEN'],
      ).catch((e) => e as Error);
      expect(String(err)).not.toContain(SECRET);
      expect(err).toBeInstanceOf(Error);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      if (prev === undefined) delete process.env.MCPSEC_SERVER_URL;
      else process.env.MCPSEC_SERVER_URL = prev;
    }
  });

  it('allows a token over loopback http', async () => {
    const fetchMock = vi.fn(async () => ok({ tools: [] }));
    const succeeded = await runMcpCommand(
      {
        context,
        stdout: sink(),
        stderr: sink(),
        fetch: fetchMock as any,
        env: { MY_TOKEN: SECRET },
      },
      ['tools', '--url', 'http://localhost:5173', '--token-env', 'MY_TOKEN'],
    );
    expect(succeeded).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
