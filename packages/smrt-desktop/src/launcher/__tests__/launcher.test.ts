import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  resolveApplicationStateRoot,
  writeOriginFile,
} from '@happyvertical/smrt-app-runtime';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  LAUNCHER_FAILURES,
  type RunLauncherOptions,
  runLauncher,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));
const posix = process.platform !== 'win32';
// Skipped on Windows: SIGTERM/SIGKILL escalation, symlinks, executable mode
// bits and the O_NOFOLLOW/mode checks do not exist there.
const itPosix = posix ? it : it.skip;

const TOKEN = `smrt_mcp_${randomBytes(32).toString('base64url')}`;
const HEALTH = '/api/_runtime/health';
const APP_ID = 'hearthos';
const PREFIX = 'HEARTHOS_MCP';

class Capture extends Writable {
  private readonly chunks: Buffer[] = [];
  override _write(chunk: Buffer, _enc: unknown, done: () => void): void {
    this.chunks.push(chunk);
    done();
  }
  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

interface Stub {
  origin: string;
  port: number;
  requests: { url: string; authorization?: string }[];
  status: number;
  close(): Promise<void>;
}

async function startStub(): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const stub = { requests, status: 200 } as Stub;
  const server: Server = createServer((request, response) => {
    requests.push({
      url: request.url ?? '',
      authorization: request.headers.authorization,
    });
    if (stub.status >= 300 && stub.status < 400) {
      response.writeHead(stub.status, { location: '/redirected' });
    } else {
      response.writeHead(stub.status, { 'content-type': 'application/json' });
    }
    response.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  stub.port = (server.address() as AddressInfo).port;
  stub.origin = `http://127.0.0.1:${stub.port}`;
  stub.close = () =>
    new Promise<void>((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  return stub;
}

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

let scratch: string;
let root: string;
let nodePath: string;
let bridgePath: string;
let dataDirectory: string;
let sourceRoot: string;
let stub: Stub;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-launcher-')));
  // The launcher resolves the state root from these; keep it in the scratch.
  vi.stubEnv('HOME', scratch);
  vi.stubEnv('XDG_STATE_HOME', join(scratch, 'state'));
  vi.stubEnv('LOCALAPPDATA', join(scratch, 'state'));
  root = join(scratch, 'resources');
  mkdirSync(root, { mode: 0o700 });
  nodePath = join(root, posix ? 'node' : 'node.exe');
  copyFileSync(process.execPath, nodePath);
  chmodSync(nodePath, 0o755);
  bridgePath = join(root, 'smrt-mcp-bridge.mjs');
  copyFileSync(join(here, 'fake-bridge.mjs'), bridgePath);
  dataDirectory = join(scratch, 'data');
  sourceRoot = join(scratch, 'source');
  mkdirSync(sourceRoot);
});

afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(scratch, { recursive: true, force: true });
});

const stateRoot = () =>
  resolveApplicationStateRoot({ appId: APP_ID, dataDirectory, sourceRoot });

function clearOrigin(): void {
  rmSync(stateRoot(), { recursive: true, force: true });
}

function publishOrigin(origin: string): void {
  mkdirSync(stateRoot(), { recursive: true, mode: 0o700 });
  expect(writeOriginFile(stateRoot(), origin)).not.toBeNull();
}

interface Run {
  stdin: PassThrough;
  stdout: Capture;
  stderr: Capture;
  result: Promise<number>;
}

const issued: { holder: string; scopes: readonly string[] }[] = [];

function start(extra: Partial<RunLauncherOptions> = {}): Run {
  const stdin = new PassThrough();
  const stdout = new Capture();
  const stderr = new Capture();
  const result = runLauncher({
    productId: 'hearthos',
    appId: APP_ID,
    dataDirectory,
    sourceRoot,
    resourceRoot: root,
    nodePath,
    bridgePath,
    healthRoute: HEALTH,
    envPrefix: PREFIX,
    scopes: ['notes:read'],
    mcpPath: '/api/mcp',
    serverName: 'hearthos-mcp',
    serverVersion: '1.2.3',
    shutdownGraceMs: 300,
    probeTimeoutMs: 2_000,
    issueToken: async (request) => {
      issued.push(request);
      return TOKEN;
    },
    stdin,
    stdout,
    stderr,
    ...extra,
  });
  return { stdin, stdout, stderr, result };
}

async function send<T = Record<string, unknown>>(
  run: Run,
  command: Record<string, unknown>,
): Promise<T> {
  const before = run.stdout.text.split('\n').length - 1;
  run.stdin.write(`${JSON.stringify(command)}\n`);
  const deadline = Date.now() + 15_000;
  for (;;) {
    const lines = run.stdout.text.split('\n').slice(0, -1);
    if (lines.length > before) return JSON.parse(lines[before]) as T;
    if (Date.now() > deadline) throw new Error('timed out waiting for output');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const line = (code: keyof typeof LAUNCHER_FAILURES) =>
  `smrt-desktop-launcher: ${code}: ${LAUNCHER_FAILURES[code].message}\n`;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid: number): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (alive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function withStub(): Promise<Stub> {
  stub = await startStub();
  publishOrigin(stub.origin);
  return stub;
}

afterEach(async () => {
  issued.length = 0;
  clearOrigin();
  await stub?.close();
});

describe('a launch', () => {
  it('probes the app, takes a holder-scoped token, and relays stdio', async () => {
    const app = await withStub();
    const run = start();

    const info = await send<{
      argv: string[];
      env: Record<string, string>;
      envKeys: string[];
      cwd: string;
    }>(run, { cmd: 'info' });
    expect(info.argv).toEqual([
      `--env-prefix=${PREFIX}`,
      '--mcp-path=/api/mcp',
      '--name=hearthos-mcp',
      '--version=1.2.3',
    ]);
    expect(info.env).toEqual({
      [`${PREFIX}_SERVER_URL`]: app.origin,
      // The bridge held exactly the issued token: its echo was redacted.
      [`${PREFIX}_TOKEN`]: '[REDACTED]',
      [`${PREFIX}_CLI_CONFIG`]:
        process.platform === 'win32' ? 'nul' : '/dev/null',
    });
    // Nothing else is inherited (PATH, NODE_OPTIONS, proxies, ...); only what
    // the OS adds to every process is allowed besides the three keys.
    const osAdded = ['SystemRoot', 'SYSTEMROOT', '__CF_USER_TEXT_ENCODING'];
    expect(info.envKeys.filter((key) => !osAdded.includes(key))).toEqual(
      Object.keys(info.env).sort(),
    );
    expect(realpathSync(info.cwd)).toBe(root);
    expect(info.argv.join(' ')).not.toContain(TOKEN);

    expect(await send(run, { cmd: 'echo', data: 'round trip' })).toEqual({
      echo: 'round trip',
    });

    expect(issued).toEqual([
      { holder: 'plugin-launcher:hearthos', scopes: ['notes:read'] },
    ]);
    // Health only: a GET of the manifest route, no credential on the wire.
    expect(app.requests).toEqual([{ url: HEALTH, authorization: undefined }]);

    run.stdin.end();
    expect(await run.result).toBe(0);
    expect(run.stderr.text).toBe('');
  });

  it('keeps the token out of bridge output, even split across chunks', async () => {
    await withStub();
    const run = start();
    await send(run, { cmd: 'leak' });
    await send(run, { cmd: 'leak-split' });
    run.stdin.end();
    expect(await run.result).toBe(0);
    for (const text of [run.stdout.text, run.stderr.text]) {
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(TOKEN.slice(0, 20));
      expect(text).toContain('[REDACTED]');
    }
  });

  it('ignores an environment proxy when probing', async () => {
    await withStub();
    vi.stubEnv('HTTP_PROXY', 'http://127.0.0.1:9');
    vi.stubEnv('NODE_USE_ENV_PROXY', '1');
    try {
      const run = start();
      await send(run, { cmd: 'echo', data: 'x' });
      run.stdin.end();
      expect(await run.result).toBe(0);
    } finally {
      vi.stubEnv('HTTP_PROXY', undefined);
      vi.stubEnv('NODE_USE_ENV_PROXY', undefined);
    }
  });

  it('exits with the distinct bridge status line when the bridge fails', async () => {
    await withStub();
    const run = start();
    run.stdin.write('{"cmd":"die","code":3}\n');
    expect(await run.result).toBe(LAUNCHER_FAILURES.bridge_exited.exitCode);
    expect(run.stderr.text).toBe(line('bridge_exited'));
  });

  itPosix('ends a bridge that outlives stdin with SIGTERM', async () => {
    await withStub();
    const run = start();
    const { pid } = await send<{ pid: number }>(run, { cmd: 'linger' });
    run.stdin.end();
    expect(await run.result).toBe(0);
    await gone(pid);
  });

  itPosix('kills a bridge that ignores SIGTERM', async () => {
    await withStub();
    const run = start();
    const { pid } = await send<{ pid: number }>(run, {
      cmd: 'linger',
      ignoreTerm: true,
    });
    run.stdin.end();
    expect(await run.result).toBe(0);
    await gone(pid);
  });
});

describe('failures write one fixed line and never reach the bridge', () => {
  const expectFailure = async (
    code: keyof typeof LAUNCHER_FAILURES,
    run: Run,
  ) => {
    expect(await run.result).toBe(LAUNCHER_FAILURES[code].exitCode);
    expect(run.stderr.text).toBe(line(code));
    expect(run.stdout.text).toBe('');
    expect(issued).toEqual([]);
  };

  it('has distinct exit codes', () => {
    const codes = Object.values(LAUNCHER_FAILURES).map((f) => f.exitCode);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('refuses a missing origin file', async () => {
    await expectFailure('origin_unavailable', start());
  });

  it('refuses a stale origin file (its process is gone)', async () => {
    const app = await withStub();
    writeFileSync(
      join(stateRoot(), 'origin.json'),
      JSON.stringify({
        version: 1,
        origin: app.origin,
        pid: 2 ** 31 - 2,
        startedAt: 'then',
      }),
      { mode: 0o600 },
    );
    await expectFailure('origin_unavailable', start());
    expect(app.requests).toEqual([]);
  });

  it.each([
    'http://localhost:1',
    'http://[::1]:1',
    'https://127.0.0.1:1',
    'http://127.0.0.1:1/x',
  ])('refuses an origin file naming %s', async (origin) => {
    const app = await withStub();
    writeFileSync(
      join(stateRoot(), 'origin.json'),
      JSON.stringify({
        version: 1,
        origin,
        pid: process.pid,
        startedAt: 'now',
      }),
      { mode: 0o600 },
    );
    await expectFailure('origin_unavailable', start());
    expect(app.requests).toEqual([]);
  });

  it('reports an instance nothing is listening for as unhealthy', async () => {
    publishOrigin(`http://127.0.0.1:${await unusedPort()}`);
    await expectFailure('unhealthy', start());
  });

  it.each([
    503, 404, 199,
  ])('reports health status %s as unhealthy', async (status) => {
    const app = await withStub();
    app.status = status;
    await expectFailure('unhealthy', start());
  });

  it('does not follow a health redirect', async () => {
    const app = await withStub();
    app.status = 302;
    await expectFailure('unhealthy', start());
    expect(app.requests.map((r) => r.url)).toEqual([HEALTH]);
  });

  it('reports a token failure without echoing the provider message', async () => {
    await withStub();
    const run = start({
      issueToken: async () => {
        throw new Error(`owner_unavailable ${TOKEN} /private/path`);
      },
    });
    expect(await run.result).toBe(LAUNCHER_FAILURES.token_unavailable.exitCode);
    expect(run.stderr.text).toBe(line('token_unavailable'));
  });

  it('refuses a token that is not a plain bearer string', async () => {
    await withStub();
    const run = start({ issueToken: async () => 'short token\n' });
    expect(await run.result).toBe(LAUNCHER_FAILURES.token_unavailable.exitCode);
  });

  it('uses the real token store by default (an app never set up has none)', async () => {
    await withStub();
    const run = start({ issueToken: undefined });
    expect(await run.result).toBe(LAUNCHER_FAILURES.token_unavailable.exitCode);
    expect(run.stderr.text).toBe(line('token_unavailable'));
  });

  itPosix('reports a bridge that cannot be started', async () => {
    await withStub();
    const notExecutable = join(root, 'not-executable');
    writeFileSync(notExecutable, '#!/bin/sh\n', { mode: 0o644 });
    const run = start({ nodePath: notExecutable });
    expect(await run.result).toBe(
      LAUNCHER_FAILURES.bridge_start_failed.exitCode,
    );
    expect(run.stderr.text).toBe(line('bridge_start_failed'));
    expect(run.stderr.text).not.toContain(notExecutable);
  });
});

describe('option and containment checks', () => {
  it.each([
    ['a relative node path', () => ({ nodePath: 'node' })],
    ['a relative bridge path', () => ({ bridgePath: 'bridge.mjs' })],
    ['a relative resource root', () => ({ resourceRoot: 'resources' })],
    [
      'a node outside the resource root',
      () => ({ nodePath: process.execPath }),
    ],
    ['a bad env prefix', () => ({ envPrefix: 'lower' })],
    ['a bad health route', () => ({ healthRoute: '/a/../b' })],
    ['no scopes', () => ({ scopes: [] })],
  ])('refuses %s', async (_name, override) => {
    await withStub();
    const run = start(override());
    expect(await run.result).toBe(LAUNCHER_FAILURES.invalid_options.exitCode);
    expect(run.stderr.text).toBe(line('invalid_options'));
    expect(issued).toEqual([]);
  });

  itPosix('refuses a bridge that is a symlink out of the root', async () => {
    await withStub();
    const outside = join(scratch, 'outside.mjs');
    writeFileSync(outside, '');
    const link = join(root, 'linked-bridge.mjs');
    symlinkSync(outside, link);
    const run = start({ bridgePath: link });
    expect(await run.result).toBe(LAUNCHER_FAILURES.invalid_options.exitCode);
    expect(issued).toEqual([]);
  });
});

describe('owner-issued plugin credentials', () => {
  it('verifies a private existing credential and never remints after revocation', async () => {
    await withStub();
    const runtime = await import('@happyvertical/smrt-app-runtime');
    const verify = vi.fn(async () => ({ scopes: ['notes:read'] }));
    const issue = vi.fn();
    const close = vi.fn(async () => {});
    const openStore = vi
      .spyOn(runtime, 'openLocalMcpTokenStore')
      .mockResolvedValue({ verify, issue, close } as never);
    const credentialPath = join(scratch, 'private-plugin.json');
    writeFileSync(credentialPath, JSON.stringify({ token: TOKEN }), {
      mode: 0o600,
    });
    try {
      const run = start({ credentialPath, issueToken: undefined });
      await send(run, { cmd: 'info' });
      run.stdin.end();
      expect(await run.result).toBe(0);
      expect(verify).toHaveBeenCalledWith(TOKEN);
      expect(issue).not.toHaveBeenCalled();
      expect(run.stdout.text + run.stderr.text).not.toContain(TOKEN);
      verify.mockResolvedValueOnce(null as never);
      const revoked = start({ credentialPath, issueToken: undefined });
      expect(await revoked.result).toBe(
        LAUNCHER_FAILURES.token_unavailable.exitCode,
      );
      expect(issue).not.toHaveBeenCalled();
      expect(close).toHaveBeenCalledTimes(2);
    } finally {
      openStore.mockRestore();
    }
  });
  itPosix('refuses a shared or symlinked credential file', async () => {
    await withStub();
    const runtime = await import('@happyvertical/smrt-app-runtime');
    const verify = vi.fn();
    const openStore = vi
      .spyOn(runtime, 'openLocalMcpTokenStore')
      .mockResolvedValue({ verify, close: async () => {} } as never);
    const shared = join(scratch, 'shared-plugin.json');
    writeFileSync(shared, JSON.stringify({ token: TOKEN }), { mode: 0o644 });
    const linked = join(scratch, 'linked-plugin.json');
    symlinkSync(shared, linked);
    try {
      for (const credentialPath of [shared, linked]) {
        const run = start({ credentialPath, issueToken: undefined });
        expect(await run.result).toBe(
          LAUNCHER_FAILURES.token_unavailable.exitCode,
        );
        expect(run.stderr.text).not.toContain(TOKEN);
      }
      expect(verify).not.toHaveBeenCalled();
    } finally {
      openStore.mockRestore();
    }
  });
});
