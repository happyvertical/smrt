import { chmod, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  DIAGNOSTICS,
  type DiagnosticCode,
  formatDiagnostic,
  type InstalledRuntime,
} from '../index.js';
import {
  disposeNode,
  failWith,
  fakeProvider,
  nextLine,
  PRODUCT_ID,
  pidAlive,
  prepareNode,
  type Run,
  type Stage,
  type Stub,
  stageInstall,
  start,
  startStub,
  TOKEN,
  waitGone,
  writeFileMode,
} from './harness.js';

let stub: Stub;
let stage: Stage;
const NAME = 'smrt-desktop-launcher';

beforeAll(prepareNode);
afterAll(disposeNode);
beforeEach(async () => {
  stub = await startStub();
  stage = await stageInstall();
});
afterEach(async () => {
  await stub.close();
});

function diagnostic(code: DiagnosticCode): string {
  return formatDiagnostic(NAME, code);
}

function expectNoToken(run: Run): void {
  expect(run.stdout.text).not.toContain(TOKEN);
  expect(run.stderr.text).not.toContain(TOKEN);
}

describe('diagnostic table', () => {
  it('has unique, stable exit codes and no interpolation points', () => {
    expect(
      Object.fromEntries(
        Object.entries(DIAGNOSTICS).map(([key, value]) => [
          key,
          value.exitCode,
        ]),
      ),
    ).toEqual({
      missing_install: 10,
      unsupported_contract: 11,
      stale_instance: 12,
      credential_unavailable: 13,
      credential_invalid: 14,
      unexpected_endpoint: 15,
      untrusted_runtime: 16,
      bridge_start_failed: 17,
      bridge_exited: 18,
      internal: 20,
    });
    for (const entry of Object.values(DIAGNOSTICS)) {
      expect(entry.message).not.toMatch(/[${}]|\/|:\d/u);
    }
  });
});

describe('forwarding', () => {
  it('forwards stdio to the bridge, hands over the credential by environment only, and tears down cleanly', async () => {
    const provider = fakeProvider(stage, stub);
    const run = start(provider, stub);

    const info = await nextLine<{
      pid: number;
      argv: string[];
      envKeys: string[];
      cwd: string;
      origin: string;
    }>(run, { cmd: 'info' });
    expect(info.argv).toEqual([
      '--env-prefix=HEARTHOS_MCP',
      '--mcp-path=/api/mcp',
      '--name=hearthos-mcp',
      '--version=1.2.3',
    ]);
    // macOS adds __CF_USER_TEXT_ENCODING to every exec; nothing else appears.
    expect(
      info.envKeys.filter((key) => key !== '__CF_USER_TEXT_ENCODING'),
    ).toEqual([
      'HEARTHOS_MCP_CLI_CONFIG',
      'HEARTHOS_MCP_SERVER_URL',
      'HEARTHOS_MCP_TOKEN',
    ]);
    expect(info.cwd).toBe(stage.root);
    expect(info.origin).toBe(stub.origin);

    const forwarded = await nextLine<{ status: number }>(run, {
      cmd: 'forward',
    });
    expect(forwarded.status).toBe(200);

    run.stdin.end();
    expect(await run.result).toBe(0);
    await waitGone(info.pid);
    expect(run.stderr.text).toBe('');
    expectNoToken(run);
    expect(provider.released).toBe(1);
    expect(provider.calls).toEqual([
      'resolveInstall',
      'connectInstance',
      'acquireCredential',
    ]);
    // The credential reached only the loopback stub, in a header.
    expect(
      stub.requests.every((request) => request.url.startsWith('/api/')),
    ).toBe(true);
  });

  it('does not use PATH, NODE_OPTIONS or any ambient environment', async () => {
    const saved = { ...process.env };
    process.env.PATH = '';
    process.env.NODE_OPTIONS = '--require /nonexistent/preload.cjs';
    process.env.AMBIENT_SECRET = 'ambient-secret-value';
    try {
      const run = start(fakeProvider(stage, stub), stub);
      const info = await nextLine<{ pid: number; envKeys: string[] }>(run, {
        cmd: 'info',
      });
      expect(info.envKeys).not.toContain('PATH');
      expect(info.envKeys).not.toContain('NODE_OPTIONS');
      expect(info.envKeys).not.toContain('AMBIENT_SECRET');
      run.stdin.end();
      expect(await run.result).toBe(0);
      expect(run.stdout.text).not.toContain('ambient-secret-value');
    } finally {
      process.env = saved;
    }
  });

  it('forwards a large message and a large stream with backpressure', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      stdoutDelayMs: 1,
    });
    const big = await nextLine<{ length: number }>(run, {
      cmd: 'length',
      data: 'y'.repeat(4 * 1024 * 1024),
    });
    expect(big.length).toBe(4 * 1024 * 1024);

    const count = 12_000; // ~12 MB through a deliberately slow sink
    const before = run.stdout.chunks.length;
    run.stdin.write(`${JSON.stringify({ cmd: 'flood', count })}\n`);
    const deadline = Date.now() + 60_000;
    while (!run.stdout.text.includes(`{"done":${count}}`)) {
      if (Date.now() > deadline) throw new Error('flood did not finish');
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(run.stdout.chunks.length).toBeGreaterThan(before);
    const lines = run.stdout.text
      .split('\n')
      .filter((line) => /^\d+:/u.test(line));
    expect(lines).toHaveLength(count);
    expect(lines.every((line, index) => line.startsWith(`${index}:`))).toBe(
      true,
    );
    // The sink never held more than a few pipe buffers: input was throttled.
    expect(run.stdout.maxPending).toBeLessThan(1024 * 1024);
    run.stdin.end();
    expect(await run.result).toBe(0);
  }, 90_000);
});

describe('provider diagnostics', () => {
  it.each<[string, DiagnosticCode, () => Parameters<typeof fakeProvider>[2]]>([
    [
      'missing install',
      'missing_install',
      () => ({ install: failWith('missing_install') }),
    ],
    [
      'unsupported contract (provider)',
      'unsupported_contract',
      () => ({ install: failWith('unsupported_contract') }),
    ],
    [
      'unsupported contract (version)',
      'unsupported_contract',
      () => ({ install: () => ({ ...stage.install, contract: 2 }) }),
    ],
    [
      'unsupported contract (shape)',
      'unsupported_contract',
      () => ({
        install: () => ({ ...stage.install, envPrefix: 'lower-case' }),
      }),
    ],
    [
      'wrong product',
      'missing_install',
      () => ({ install: () => ({ ...stage.install, productId: 'other' }) }),
    ],
    [
      'stale instance',
      'stale_instance',
      () => ({ instance: failWith('stale_instance') }),
    ],
    [
      'credential unavailable',
      'credential_unavailable',
      () => ({ credential: failWith('credential_unavailable') }),
    ],
    [
      'credential invalid (provider)',
      'credential_invalid',
      () => ({ credential: failWith('credential_invalid') }),
    ],
    [
      'credential malformed',
      'credential_invalid',
      () => ({ credential: () => ({ token: 'short' }) }),
    ],
    [
      'credential with header injection',
      'credential_invalid',
      () => ({ credential: () => ({ token: `${TOKEN}\r\nx-evil: 1` }) }),
    ],
    [
      'rendezvous origin (provider)',
      'unexpected_endpoint',
      () => ({ instance: failWith('unexpected_endpoint') }),
    ],
    [
      'unknown provider error',
      'internal',
      () => ({
        install: () => {
          throw new Error(`boom ${TOKEN}`);
        },
      }),
    ],
  ])('%s', async (_name, code, behavior) => {
    const provider = fakeProvider(stage, stub, behavior());
    const run = start(provider, stub);
    expect(await run.result).toBe(DIAGNOSTICS[code].exitCode);
    expect(run.stderr.text).toBe(diagnostic(code));
    expect(run.stdout.text).toBe('');
    expectNoToken(run);
  });

  it.each([
    ['https origin', 'https://127.0.0.1:4678'],
    ['remote host', 'http://example.com:4678'],
    ['lookalike host', 'http://127.0.0.1.evil.test:4678'],
    ['userinfo', 'http://user:pw@127.0.0.1:4678'],
    ['path', 'http://127.0.0.1:4678/app'],
    ['trailing slash', 'http://127.0.0.1:4678/'],
    ['no port', 'http://127.0.0.1'],
    ['port zero', 'http://127.0.0.1:0'],
    ['query', 'http://127.0.0.1:4678?x=1'],
    ['not a url', 'nonsense'],
    ['all interfaces', 'http://0.0.0.0:4678'],
    // Only the literal address the supervisor listens on and probes: another
    // local user can listen on ::1 or on a localhost alias the instance does
    // not use, and would receive the bearer token.
    ['localhost', 'http://localhost:4678'],
    ['localhost, uppercase', 'http://LOCALHOST:4678'],
    ['ipv6 loopback', 'http://[::1]:4678'],
    ['ipv4 loopback elsewhere in the block', 'http://127.0.0.2:4678'],
    ['ipv4-mapped ipv6 loopback', 'http://[::ffff:127.0.0.1]:4678'],
    ['decimal ipv4 loopback', 'http://2130706433:4678'],
  ])('rejects an unexpected endpoint: %s', async (_name, origin) => {
    const provider = fakeProvider(stage, stub, {
      instance: () => ({ origin }),
    });
    const run = start(provider, stub);
    expect(await run.result).toBe(15);
    expect(run.stderr.text).toBe(diagnostic('unexpected_endpoint'));
    expect(provider.calls).not.toContain('acquireCredential');
  });

  it('treats a missing or failing health route as a stale instance before handing over a credential', async () => {
    for (const status of [404, 500, 302]) {
      stub.mode.health = status;
      const provider = fakeProvider(stage, stub);
      const run = start(provider, stub);
      expect(await run.result).toBe(12);
      expect(provider.calls).not.toContain('acquireCredential');
    }
  });

  it('treats a dead port as a stale instance', async () => {
    const dead = await startStub();
    const origin = dead.origin;
    await dead.close();
    const provider = fakeProvider(stage, stub, {
      instance: () => ({ origin }),
    });
    const run = start(provider, stub);
    expect(await run.result).toBe(12);
    expect(provider.calls).not.toContain('acquireCredential');
  });

  it('denies a credential the instance rejects, and still releases it', async () => {
    const provider = fakeProvider(stage, stub, {
      credential: () => ({
        token: `${TOKEN.slice(0, -1)}${TOKEN.endsWith('A') ? 'B' : 'A'}`,
      }),
    });
    const run = start(provider, stub);
    expect(await run.result).toBe(14);
    expect(run.stderr.text).toBe(diagnostic('credential_invalid'));
    expect(run.stdout.text).toBe('');
  });

  it('releases the credential when the bridge cannot start', async () => {
    const provider = fakeProvider(stage, stub);
    // The staged node is a hard link: replace it, never write through it.
    await rm(stage.install.nodePath);
    // A shebang naming a missing interpreter fails execve on every platform.
    await writeFileMode(
      stage.install.nodePath,
      '#!/nonexistent/interpreter\n',
      0o755,
    );
    const run = start(provider, stub);
    expect(await run.result).toBe(17);
    expect(run.stderr.text).toBe(diagnostic('bridge_start_failed'));
    expect(provider.released).toBe(1);
  });

  it.each([
    ['not found', 404, 15],
    ['server error', 503, 12],
  ])('maps an MCP endpoint that is %s', async (_name, status, exit) => {
    stub.mode.mcp = status;
    const provider = fakeProvider(stage, stub);
    const run = start(provider, stub);
    expect(await run.result).toBe(exit);
  });

  it('bounds a provider that never answers', async () => {
    const provider = fakeProvider(stage, stub, {
      install: () => new Promise(() => undefined),
    });
    const run = start(provider, stub, { providerTimeoutMs: 50 });
    expect(await run.result).toBe(10);
    expect(run.stderr.text).toBe(diagnostic('missing_install'));
  });
});

describe('untrusted runtime paths', () => {
  const cases: [
    string,
    (stage: Stage) => Promise<Partial<InstalledRuntime>>,
  ][] = [
    ['bare executable name', async () => ({ nodePath: 'node' })],
    ['relative node path', async () => ({ nodePath: 'runtime/node' })],
    ['relative bridge path', async () => ({ bridgePath: 'bridge/index.mjs' })],
    [
      'dot-dot traversal',
      async (s) => ({ bridgePath: `${s.root}/bridge/../bridge/index.mjs` }),
    ],
    [
      'unnormalised path',
      async (s) => ({ nodePath: `${s.root}//runtime/node` }),
    ],
    [
      'NUL in path',
      async (s) => ({ bridgePath: `${s.root}/bridge/in\0dex.mjs` }),
    ],
    ['the root itself', async (s) => ({ bridgePath: s.root })],
    ['node outside the root', async () => ({ nodePath: process.execPath })],
    [
      'bridge outside the root',
      async () => ({ bridgePath: new URL(import.meta.url).pathname }),
    ],
    [
      'symlinked bridge',
      async (s) => {
        const link = join(s.root, 'bridge', 'link.mjs');
        await symlink(s.install.bridgePath, link);
        return { bridgePath: link };
      },
    ],
    [
      'symlinked directory',
      async (s) => {
        await symlink(join(s.root, 'bridge'), join(s.root, 'alias'));
        return { bridgePath: join(s.root, 'alias', 'index.mjs') };
      },
    ],
    [
      'symlink that escapes the root',
      async (s) => {
        const outside = join(s.root, '..', `outside-${process.pid}.mjs`);
        await writeFile(outside, '');
        const link = join(s.root, 'bridge', 'escape.mjs');
        await symlink(outside, link);
        return { bridgePath: link };
      },
    ],
    [
      'group-writable bridge',
      async (s) => {
        await chmod(s.install.bridgePath, 0o664);
        return {};
      },
    ],
    [
      'world-writable node',
      async (s) => {
        const copy = join(s.root, 'runtime', 'node2');
        await writeFileMode(copy, '', 0o777);
        return { nodePath: copy };
      },
    ],
    [
      'world-writable directory',
      async (s) => {
        await chmod(join(s.root, 'bridge'), 0o777);
        return {};
      },
    ],
    [
      'world-writable root',
      async (s) => {
        await chmod(s.root, 0o777);
        return {};
      },
    ],
    [
      'non-executable node',
      async (s) => {
        const copy = join(s.root, 'runtime', 'plain');
        await writeFileMode(copy, '', 0o644);
        return { nodePath: copy };
      },
    ],
    [
      'bridge is a directory',
      async (s) => {
        await mkdir(join(s.root, 'bridge', 'dir'), { mode: 0o755 });
        return { bridgePath: join(s.root, 'bridge', 'dir') };
      },
    ],
    [
      'missing bridge',
      async (s) => ({ bridgePath: join(s.root, 'bridge', 'absent.mjs') }),
    ],
  ];

  it.each(
    cases,
  )('rejects %s without starting anything or fetching a credential', async (_name, mutate) => {
    const overrides = await mutate(stage);
    const install = { ...stage.install, ...overrides };
    const provider = fakeProvider(stage, stub, { install: () => install });
    const run = start(provider, stub);
    expect(await run.result).toBe(16);
    expect(run.stderr.text).toBe(diagnostic('untrusted_runtime'));
    expect(run.stdout.text).toBe('');
    expect(provider.calls).toEqual(['resolveInstall']);
    expect(stub.requests).toEqual([]);
  });

  it('ignores a provider that mutates its install after validation', async () => {
    const install = { ...stage.install };
    const provider = fakeProvider(stage, stub, { install: () => install });
    const run = start(provider, stub);
    await nextLine(run, { cmd: 'info' });
    (install as { nodePath: string }).nodePath = '/bin/sh';
    run.stdin.end();
    expect(await run.result).toBe(0);
  });
});

describe('lifecycle', () => {
  it('terminates a bridge that ignores stdin EOF and SIGTERM', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      shutdownGraceMs: 200,
    });
    const info = await nextLine<{ pid: number }>(run, { cmd: 'info' });
    await nextLine(run, { cmd: 'linger', ignoreTerm: true });
    run.stdin.end();
    expect(await run.result).toBe(0);
    await waitGone(info.pid);
  });

  it.each<[NodeJS.Signals, number]>([
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ])('%s tears down the bridge and exits %i', async (signal, code) => {
    const run = start(fakeProvider(stage, stub), stub);
    const info = await nextLine<{ pid: number }>(run, { cmd: 'info' });
    run.signals.fire(signal);
    expect(await run.result).toBe(code);
    await waitGone(info.pid);
    expect(run.stderr.text).toBe('');
    expect(run.signals.listenerCount('SIGTERM')).toBe(0);
    expect(run.signals.listenerCount('SIGINT')).toBe(0);
  });

  it('a second signal kills a bridge that ignores the first', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      shutdownGraceMs: 60_000,
    });
    const info = await nextLine<{ pid: number }>(run, { cmd: 'info' });
    await nextLine(run, { cmd: 'linger', ignoreTerm: true });
    run.signals.fire('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pidAlive(info.pid)).toBe(true);
    run.signals.fire('SIGTERM');
    expect(await run.result).toBe(143);
    await waitGone(info.pid);
  });

  it('a signal during startup stops without a diagnostic or a child', async () => {
    const provider = fakeProvider(stage, stub, {
      instance: () => new Promise(() => undefined),
    });
    const run = start(provider, stub);
    await new Promise((resolve) => setTimeout(resolve, 100));
    run.signals.fire('SIGINT');
    expect(await run.result).toBe(130);
    expect(run.stderr.text).toBe('');
    expect(provider.calls).not.toContain('acquireCredential');
  });

  it('reports a bridge that exits non-zero', async () => {
    const run = start(fakeProvider(stage, stub), stub);
    const info = await nextLine<{ pid: number }>(run, { cmd: 'info' });
    run.stdin.write(`${JSON.stringify({ cmd: 'die', code: 3 })}\n`);
    expect(await run.result).toBe(18);
    expect(run.stderr.text).toBe(diagnostic('bridge_exited'));
    await waitGone(info.pid);
  });

  it('reports a bridge that is killed', async () => {
    const run = start(fakeProvider(stage, stub), stub);
    await nextLine(run, { cmd: 'info' });
    run.stdin.write(`${JSON.stringify({ cmd: 'kill-self' })}\n`);
    expect(await run.result).toBe(18);
    expect(run.stderr.text).toBe(diagnostic('bridge_exited'));
  });

  it('exits 0 when the bridge ends cleanly on its own', async () => {
    const run = start(fakeProvider(stage, stub), stub);
    await nextLine(run, { cmd: 'info' });
    run.stdin.write(`${JSON.stringify({ cmd: 'die', code: 0 })}\n`);
    expect(await run.result).toBe(0);
  });

  it('stops when the host stops reading stdout', async () => {
    const run = start(fakeProvider(stage, stub), stub);
    const info = await nextLine<{ pid: number }>(run, { cmd: 'info' });
    run.stdout.destroy(new Error('EPIPE'));
    run.stdin.write(`${JSON.stringify({ cmd: 'info' })}\n`);
    expect(await run.result).toBe(0);
    await waitGone(info.pid);
  });

  it('stops forwarding input once the bridge is gone', async () => {
    const run = start(fakeProvider(stage, stub), stub);
    await nextLine(run, { cmd: 'info' });
    run.stdin.write(`${JSON.stringify({ cmd: 'die', code: 0 })}\n`);
    expect(await run.result).toBe(0);
    expect(() => run.stdin.write('{"cmd":"info"}\n')).not.toThrow();
  });
});

describe('credential handover', () => {
  it('releases the credential once the bridge has started, not when it ends', async () => {
    const provider = fakeProvider(stage, stub);
    const run = start(provider, stub);
    await nextLine(run, { cmd: 'info' });
    expect(provider.released).toBe(1);
    run.stdin.end();
    expect(await run.result).toBe(0);
    expect(provider.released).toBe(1);
  });

  it('releases a credential that arrives after the launch gave up', async () => {
    let released = 0;
    const provider = fakeProvider(stage, stub, {
      credential: () =>
        new Promise((resolve) =>
          setTimeout(
            () =>
              resolve({
                token: TOKEN,
                release: () => {
                  released += 1;
                },
              }),
            150,
          ),
        ),
    });
    const run = start(provider, stub, { providerTimeoutMs: 50 });
    expect(await run.result).toBe(13);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(released).toBe(1);
  });

  it.each([
    '+',
    '/',
    '=',
    '%2B',
    ' ',
    '"',
  ])('refuses a credential containing %j, which an encoder could rewrite', async (character) => {
    const token = `${TOKEN.slice(0, 20)}${character}${TOKEN.slice(21)}`;
    const run = start(
      fakeProvider(stage, stub, { credential: () => ({ token }) }),
      stub,
    );
    expect(await run.result).toBe(14);
  });

  it('runs the bridge from the canonical root even when the root is reached through a symlink', async () => {
    const alias = `${stage.root}-alias`;
    await symlink(stage.root, alias);
    try {
      const install = {
        ...stage.install,
        root: alias,
        nodePath: stage.install.nodePath.replace(stage.root, alias),
        bridgePath: stage.install.bridgePath.replace(stage.root, alias),
      };
      const run = start(
        fakeProvider(stage, stub, { install: () => install }),
        stub,
      );
      const info = await nextLine<{ cwd: string }>(run, { cmd: 'info' });
      expect(info.cwd).toBe(stage.root);
      run.stdin.end();
      expect(await run.result).toBe(0);
    } finally {
      await rm(alias);
    }
  });
});

describe('output that cannot be delivered', () => {
  it('does not wait forever for a stray process holding the bridge pipes', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      outputFlushTimeoutMs: 300,
    });
    const held = await nextLine<{ grandchild: number }>(run, {
      cmd: 'hold-pipes',
    });
    try {
      run.stdin.write(`${JSON.stringify({ cmd: 'die', code: 0 })}\n`);
      expect(await run.result).toBe(0);
    } finally {
      process.kill(held.grandchild, 'SIGKILL');
    }
  });

  it('does not wait forever for a host that stopped reading', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      outputFlushTimeoutMs: 300,
    });
    const info = await nextLine<{ pid: number }>(run, { cmd: 'info' });
    // Stall the sink: it accepts a little, then never calls back.
    run.stdout.stall();
    run.stdin.write(`${JSON.stringify({ cmd: 'flood', count: 5000 })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    run.signals.fire('SIGTERM');
    const started = Date.now();
    expect(await run.result).toBe(143);
    expect(Date.now() - started).toBeLessThan(5_000);
    await waitGone(info.pid);
  });

  it('a second signal abandons output at once', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      outputFlushTimeoutMs: 60_000,
      shutdownGraceMs: 60_000,
    });
    await nextLine(run, { cmd: 'info' });
    await nextLine(run, { cmd: 'linger', ignoreTerm: true });
    run.stdout.stall();
    run.stdin.write(`${JSON.stringify({ cmd: 'flood', count: 5000 })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 200));
    run.signals.fire('SIGINT');
    run.signals.fire('SIGINT');
    expect(await run.result).toBe(130);
  });
});

describe('credential redaction', () => {
  it('redacts the credential from bridge stdout and stderr, including across chunks', async () => {
    const run = start(fakeProvider(stage, stub), stub);
    await nextLine(run, { cmd: 'leak' });
    await nextLine(run, { cmd: 'leak-split' });
    run.stdin.end();
    expect(await run.result).toBe(0);
    expectNoToken(run);
    expect(run.stdout.text).toContain('{"leak":"[REDACTED]"}');
    expect(run.stdout.text).toContain('{"split":"[REDACTED]"}');
    expect(run.stderr.text).toContain('leak [REDACTED]');
    expect(run.stderr.text).toContain('[REDACTED]\n');
    // Neither half of the split credential survives either.
    const half = TOKEN.slice(0, Math.floor(TOKEN.length / 2));
    expect(run.stdout.text + run.stderr.text).not.toContain(half);
  });

  it('never prints provider messages, in any channel, on failure', async () => {
    for (const behavior of [
      { install: failWith('missing_install') },
      { instance: failWith('stale_instance') },
      { credential: failWith('credential_invalid') },
    ]) {
      const run = start(fakeProvider(stage, stub, behavior), stub);
      await run.result;
      expectNoToken(run);
    }
  });
});

describe('product identity', () => {
  it('is checked against the product the launcher was built for', async () => {
    const run = start(fakeProvider(stage, stub), stub, {
      productId: `${PRODUCT_ID}-other`,
    });
    expect(await run.result).toBe(10);
  });
});
