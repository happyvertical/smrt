import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import {
  type InstalledRuntime,
  type InstanceEndpoint,
  type LauncherCredential,
  type LauncherProvider,
  LauncherProviderError,
  type RunLauncherOptions,
  runLauncher,
  type SignalSource,
} from '../index.js';

const here = dirname(fileURLToPath(import.meta.url));

export const PRODUCT_ID = 'hearthos';
export const ENV_PREFIX = 'HEARTHOS_MCP';
export const TOKEN = `smrt_mcp_${randomBytes(32).toString('base64url')}`;

/** A loopback MCP stub: health route plus a bearer-checked `/api/mcp`. */
export interface Stub {
  readonly origin: string;
  readonly requests: { method: string; url: string; authorized: boolean }[];
  mode: { health: number; mcp: number | 'auth' };
  close(): Promise<void>;
}

export async function startStub(): Promise<Stub> {
  const requests: Stub['requests'] = [];
  const mode: Stub['mode'] = { health: 200, mcp: 'auth' };
  const server: Server = createServer((request, response) => {
    const authorized = request.headers.authorization === `Bearer ${TOKEN}`;
    requests.push({
      method: request.method ?? '',
      url: request.url ?? '',
      authorized,
    });
    drain(request).then(() => {
      if (request.url === '/api/_runtime/health') {
        response.writeHead(mode.health, { 'content-type': 'application/json' });
        response.end('{"status":"ok"}');
      } else if (request.url === '/api/mcp') {
        const status =
          mode.mcp === 'auth' ? (authorized ? 200 : 401) : mode.mcp;
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(
          status === 200
            ? '{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}'
            : '{}',
        );
      } else {
        response.writeHead(404).end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    mode,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function drain(request: IncomingMessage): Promise<void> {
  return new Promise((resolve) => {
    request.on('data', () => undefined);
    request.on('end', resolve);
    request.on('error', resolve);
  });
}

/** A staged installed bundle: `<root>/runtime/node` and `<root>/bridge/index.mjs`. */
export interface Stage {
  readonly root: string;
  readonly install: InstalledRuntime;
}

let sharedNode: string | undefined;
let sharedRoot: string | undefined;

/** Copy the running Node into a private directory once; later stages link it. */
export async function prepareNode(): Promise<void> {
  sharedRoot = await realpath(await mkdtemp(join(tmpdir(), 'launcher-node-')));
  await chmod(sharedRoot, 0o700);
  sharedNode = join(sharedRoot, 'node');
  await copyFile(process.execPath, sharedNode);
  await chmod(sharedNode, 0o755);
}

export async function disposeNode(): Promise<void> {
  if (sharedRoot) await rm(sharedRoot, { recursive: true, force: true });
}

export async function stageInstall(
  overrides: Partial<InstalledRuntime> = {},
): Promise<Stage> {
  if (!sharedNode) throw new Error('prepareNode() first');
  const root = await realpath(await mkdtemp(join(tmpdir(), 'launcher-root-')));
  await chmod(root, 0o700);
  await mkdir(join(root, 'runtime'), { mode: 0o755 });
  await mkdir(join(root, 'bridge'), { mode: 0o755 });
  const nodePath = join(root, 'runtime', 'node');
  try {
    await link(sharedNode, nodePath);
  } catch {
    await copyFile(sharedNode, nodePath);
  }
  const bridgePath = join(root, 'bridge', 'index.mjs');
  await copyFile(join(here, 'fake-bridge.mjs'), bridgePath);
  await chmod(bridgePath, 0o644);
  const install: InstalledRuntime = {
    contract: 1,
    productId: PRODUCT_ID,
    root,
    nodePath,
    bridgePath,
    healthRoute: '/api/_runtime/health',
    envPrefix: ENV_PREFIX,
    mcpPath: '/api/mcp',
    serverName: 'hearthos-mcp',
    serverVersion: '1.2.3',
    ...overrides,
  };
  return { root, install };
}

export async function writeFileMode(
  path: string,
  content: string,
  mode: number,
): Promise<void> {
  await writeFile(path, content);
  await chmod(path, mode);
}

export interface FakeProvider extends LauncherProvider {
  readonly calls: string[];
  released: number;
}

export interface ProviderBehavior {
  install?: () => InstalledRuntime | Promise<InstalledRuntime>;
  instance?: () => InstanceEndpoint | Promise<InstanceEndpoint>;
  credential?: () => LauncherCredential | Promise<LauncherCredential>;
}

export function fakeProvider(
  stage: Stage,
  stub: Stub,
  behavior: ProviderBehavior = {},
): FakeProvider {
  const provider: FakeProvider = {
    calls: [],
    released: 0,
    async resolveInstall() {
      provider.calls.push('resolveInstall');
      return behavior.install ? behavior.install() : stage.install;
    },
    async connectInstance() {
      provider.calls.push('connectInstance');
      return behavior.instance ? behavior.instance() : { origin: stub.origin };
    },
    async acquireCredential() {
      provider.calls.push('acquireCredential');
      return behavior.credential
        ? behavior.credential()
        : {
            token: TOKEN,
            release: () => {
              provider.released += 1;
            },
          };
    },
  };
  return provider;
}

export function failWith(
  code: ConstructorParameters<typeof LauncherProviderError>[0],
) {
  return () => {
    throw new LauncherProviderError(code, `provider detail ${TOKEN}`);
  };
}

/** Capture everything written to a stream. */
export class Capture extends Writable {
  readonly chunks: Buffer[] = [];
  maxPending = 0;
  private pending = 0;

  constructor(private readonly delayMs = 0) {
    super({ highWaterMark: 16 * 1024 });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.chunks.push(chunk);
    this.pending = this.writableLength;
    this.maxPending = Math.max(this.maxPending, this.pending);
    if (this.stalled) return;
    if (this.delayMs > 0) setTimeout(callback, this.delayMs);
    else callback();
  }

  private stalled = false;

  /** From now on, accept writes but never complete them. */
  stall(): void {
    this.stalled = true;
  }

  get text(): string {
    return Buffer.concat(this.chunks).toString('utf8');
  }
}

/** A signal source tests can fire. */
export class FakeSignals extends EventEmitter implements SignalSource {
  fire(signal: NodeJS.Signals): void {
    this.emit(signal);
  }
}

export interface Run {
  readonly stdin: PassThrough;
  readonly stdout: Capture;
  readonly stderr: Capture;
  readonly signals: FakeSignals;
  readonly result: Promise<number>;
}

export function start(
  provider: LauncherProvider,
  stub: Stub,
  extra: Partial<RunLauncherOptions> & { stdoutDelayMs?: number } = {},
): Run {
  const stdin = new PassThrough();
  const stdout = new Capture(extra.stdoutDelayMs);
  const stderr = new Capture();
  const signals = new FakeSignals();
  const { stdoutDelayMs: _ignored, ...rest } = extra;
  void stub;
  const result = runLauncher({
    provider,
    productId: PRODUCT_ID,
    stdin,
    stdout,
    stderr,
    signals,
    shutdownGraceMs: 300,
    ...rest,
  });
  return { stdin, stdout, stderr, signals, result };
}

/** Wait until stdout holds a complete line satisfying `predicate`. */
export async function nextLine<T = Record<string, unknown>>(
  run: Run,
  command: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const before = run.stdout.text.split('\n').length - 1;
  run.stdin.write(`${JSON.stringify(command)}\n`);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const lines = run.stdout.text.split('\n').slice(0, -1);
    if (lines.length > before) return JSON.parse(lines[before]) as T;
    if (Date.now() > deadline) throw new Error('timed out waiting for output');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitGone(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`pid ${pid} still alive`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
