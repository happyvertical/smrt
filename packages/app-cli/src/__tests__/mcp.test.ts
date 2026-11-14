import { createMcpHandler, Server } from '@modelcontextprotocol/server';
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
      ['tools', '--legacy-rest'],
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
    }).run(['mcp', 'tools', '--legacy-rest']);

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
      [
        'tools',
        '--legacy-rest',
        '--url',
        'https://app.test/',
        '--token-env',
        'MY_TOKEN',
      ],
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
          '--legacy-rest',
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
    ).rejects.toThrow(/Invalid server URL/);
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
      [
        'tools',
        '--legacy-rest',
        '--url',
        'https://app.test',
        '--token-env',
        'MY_TOKEN',
      ],
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
      [
        'tools',
        '--legacy-rest',
        '--mcp-path',
        '/mcp',
        '--url',
        'https://app.test',
      ],
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
        ['tools', '--legacy-rest', '--token-env', 'MY_TOKEN'],
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
      [
        'tools',
        '--legacy-rest',
        '--url',
        'http://localhost:5173',
        '--token-env',
        'MY_TOKEN',
      ],
    );
    expect(succeeded).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

describe('mcp argument and transport hardening', () => {
  const context = { envPrefix: 'MCPHARD', defaultServerUrl: 'https://d.test' };
  const sink = () => ({ write: vi.fn() }) as unknown as NodeJS.WriteStream;

  it('refuses redirects', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    await runMcpCommand(
      { context, stdout: sink(), stderr: sink(), fetch: fetchMock as any },
      ['tools', '--legacy-rest', '--url', 'https://app.test'],
    );
    expect((fetchMock.mock.calls[0] as any)[1].redirect).toBe('error');
  });

  it('accepts the --url=value form', async () => {
    const fetchMock = vi.fn(async () => new Response('{}'));
    await runMcpCommand(
      { context, stdout: sink(), stderr: sink(), fetch: fetchMock as any },
      ['tools', '--legacy-rest', '--url=https://eq.test'],
    );
    expect((fetchMock.mock.calls[0] as any)[0]).toBe(
      'https://eq.test/api/mcp/tools',
    );
  });

  it.each([
    [['tools', '--mcp-path', '//evil.test']],
    [['tools', '--confirm']],
    [['tools', '--bogus']],
    [['tools', 'extra']],
    [['call', 'x', '{}', 'extra']],
  ])('rejects %j', async (args) => {
    const fetchMock = vi.fn();
    await expect(
      runMcpCommand({ context, fetch: fetchMock as any }, args),
    ).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps a timeout to network_error', async () => {
    const stdout = sink();
    const ok = await runMcpCommand(
      {
        context,
        stdout,
        stderr: sink(),
        fetch: (async () => {
          throw Object.assign(new Error('x'), { name: 'TimeoutError' });
        }) as any,
      },
      ['tools', '--legacy-rest', '--url', 'https://app.test'],
    );
    expect(ok).toBe(false);
    expect(String((stdout.write as any).mock.calls[0][0])).toContain(
      'network_error',
    );
  });
});

describe('mcp modern transport (default)', () => {
  const SECRET = 'sk-modern-secret-token-456';
  const context = {
    envPrefix: 'MCPMODERN',
    defaultServerUrl: 'https://d.test',
  };
  const sink = () => ({ write: vi.fn() }) as unknown as NodeJS.WriteStream;
  const calls: { url: string; auth: string | null; args?: unknown }[] = [];
  const handler = createMcpHandler(() => {
    const server = new Server(
      { name: 'up', version: '1' },
      { capabilities: { tools: {} } },
    );
    server.setRequestHandler('tools/list', async () => ({
      tools: [{ name: 'send', inputSchema: { type: 'object' } }],
    }));
    server.setRequestHandler('tools/call', async (request) => {
      calls.push({ url: '', auth: null, args: request.params.arguments });
      return { content: [{ type: 'text', text: `echo ${SECRET}` }] };
    });
    return server;
  });
  const fetchImpl = (async (input: any, init: any) => {
    const request = new Request(input, init);
    calls.push({
      url: request.url,
      auth: request.headers.get('authorization'),
    });
    return handler.fetch(request);
  }) as unknown as typeof fetch;

  it('talks to the exact --mcp-path endpoint, never /tools or /call', async () => {
    calls.length = 0;
    const stdout = sink();
    const ok = await runMcpCommand(
      { context, stdout, stderr: sink(), fetch: fetchImpl, env: { T: SECRET } },
      [
        'tools',
        '--url',
        'https://app.test',
        '--mcp-path',
        '/mcp',
        '--token-env',
        'T',
      ],
    );
    expect(ok).toBe(true);
    expect(JSON.parse(String((stdout.write as any).mock.calls[0][0]))).toEqual({
      tools: [{ name: 'send', inputSchema: { type: 'object' } }],
    });
    const urls = calls.filter((c) => c.url).map((c) => c.url);
    expect(urls.length).toBeGreaterThan(0);
    expect(new Set(urls)).toEqual(new Set(['https://app.test/mcp']));
    expect(
      calls.filter((c) => c.url).every((c) => c.auth === `Bearer ${SECRET}`),
    ).toBe(true);
  });

  it('injects confirm and scrubs a tool-echoed token', async () => {
    calls.length = 0;
    const stdout = sink();
    const stderr = sink();
    const ok = await runMcpCommand(
      { context, stdout, stderr, fetch: fetchImpl, env: { T: SECRET } },
      [
        'call',
        'send',
        '{"id":"1"}',
        '--confirm',
        '--url',
        'https://app.test',
        '--token-env',
        'T',
      ],
    );
    expect(ok).toBe(true);
    expect(calls.find((c) => c.args)?.args).toEqual({ id: '1', confirm: true });
    const out = JSON.stringify((stdout.write as any).mock.calls);
    expect(out).not.toContain(SECRET);
    expect(out).toContain('[REDACTED]');
  });
});
