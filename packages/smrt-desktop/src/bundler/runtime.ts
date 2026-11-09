/**
 * The real-machine seams of the bundler: the default filesystem, pnpm runner,
 * Node acquisition, measurement and environment. The CLI composes these; the
 * tests inject fakes instead. This is the only module that touches
 * `child_process`, `http` and `net`.
 */

import { execFile, spawn, spawnSync } from 'node:child_process';
import { promises as fsp, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer } from 'node:net';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildChildEnv } from './child-env.js';
import {
  type DataDirectory,
  type MeasureChild,
  type MeasureSeams,
  measureBundle,
  type SpawnRequest,
} from './measure.js';
import { acquireNodeBinary } from './node-dist.js';
import { nodeTreeFs, type TreeFs } from './paths.js';
import { createPnpmRunner } from './pnpm-runner.js';
import type { BundleSeams } from './run.js';

/** Where downloaded Node archives are cached (untrusted, re-hashed on use). */
export function defaultNodeCacheDir(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string {
  switch (platform) {
    case 'darwin':
      return join(home, 'Library', 'Caches', 'smrt-desktop', 'node');
    case 'win32': {
      const base = env.LOCALAPPDATA;
      return win32.join(
        base !== undefined && win32.isAbsolute(base)
          ? base
          : win32.join(home, 'AppData', 'Local'),
        'smrt-desktop',
        'node',
      );
    }
    default: {
      const xdg = env.XDG_CACHE_HOME;
      return join(
        xdg?.startsWith('/') ? xdg : join(home, '.cache'),
        'smrt-desktop',
        'node',
      );
    }
  }
}

/** Version of this package: the nearest `package.json` with its name. */
export function readToolVersion(startUrl: string = import.meta.url): string {
  let dir = dirname(fileURLToPath(startUrl));
  for (let i = 0; i < 6; i += 1) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(dir, 'package.json'), 'utf8'),
      ) as { name?: unknown; version?: unknown };
      if (
        manifest.name === '@happyvertical/smrt-desktop' &&
        typeof manifest.version === 'string'
      ) {
        return manifest.version;
      }
    } catch {
      // Not here; keep walking up.
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return '0.0.0';
}

async function diskUsage(root: string): Promise<number | undefined> {
  if (process.platform === 'win32') return undefined;
  let total = 0;
  const visit = async (path: string): Promise<void> => {
    const stats = await fsp.lstat(path);
    total += (stats.blocks ?? 0) * 512;
    if (stats.isDirectory()) {
      for (const name of await fsp.readdir(path)) {
        await visit(join(path, name));
      }
    }
  };
  await visit(root);
  return total;
}

interface ProcessRow {
  readonly pid: number;
  readonly ppid: number;
  readonly pgid: number;
  /** `ps` state; a leading `Z` is a zombie (already dead). */
  readonly stat: string;
}

const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,stat='];

function parseProcessRows(stdout: string): ProcessRow[] | undefined {
  const rows: ProcessRow[] = [];
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)/.exec(line);
    if (match !== null) {
      rows.push({
        pid: Number(match[1]),
        ppid: Number(match[2]),
        pgid: Number(match[3]),
        stat: match[4] as string,
      });
    }
  }
  return rows.length === 0 ? undefined : rows;
}

/** The process table (`ps -A -o pid=,ppid=,pgid=,stat=`), or `undefined`. */
function processTable(): Promise<ProcessRow[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      'ps',
      PS_ARGS,
      { timeout: 5000, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        resolve(error === null ? parseProcessRows(stdout) : undefined);
      },
    );
  });
}

/** The same table, synchronously: for `exit` and signal handlers only. */
function processTableSync(): ProcessRow[] | undefined {
  try {
    const result = spawnSync('ps', PS_ARGS, {
      encoding: 'utf8',
      timeout: 2000,
      maxBuffer: 16 * 1024 * 1024,
      windowsHide: true,
    });
    return result.status === 0 ? parseProcessRows(result.stdout) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * While a measured child is alive, make the CLI's own death take it down too.
 *
 * The child leads its own session/group (`detached`), so a terminal Ctrl+C or
 * a SIGTERM aimed at the CLI no longer reaches it, and the `finally` that
 * would stop it never runs when the process is killed. `cleanup` therefore
 * runs synchronously from `exit`, `SIGINT` and `SIGTERM`. After a signal the
 * default behaviour is restored: unless another listener still handles that
 * signal, the process exits with `128 + signal`, as it would have without us.
 * The returned function removes the handlers (idempotent).
 */
function killOnProcessExit(cleanup: () => void): () => void {
  const signals = [
    ['SIGINT', 2],
    ['SIGTERM', 15],
  ] as const;
  const onExit = (): void => cleanup();
  const listeners = signals.map(([name, number]) => {
    const listener = (): void => {
      cleanup();
      release();
      if (process.listenerCount(name) === 0) process.exit(128 + number);
    };
    return [name, listener] as const;
  });
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    process.removeListener('exit', onExit);
    for (const [name, listener] of listeners) {
      process.removeListener(name, listener);
    }
  }
  process.once('exit', onExit);
  for (const [name, listener] of listeners) process.once(name, listener);
  return release;
}

/** Every process below `root` in the parent chain (not `root` itself). */
export function descendantsOf(
  rows: readonly ProcessRow[],
  root: number,
): number[] {
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const list = children.get(row.ppid) ?? [];
    list.push(row.pid);
    children.set(row.ppid, list);
  }
  const found: number[] = [];
  const seen = new Set<number>([root]);
  const queue = [root];
  for (let index = 0; index < queue.length; index += 1) {
    for (const child of children.get(queue[index] as number) ?? []) {
      if (!seen.has(child)) {
        seen.add(child);
        found.push(child);
        queue.push(child);
      }
    }
  }
  return found;
}

function probe(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code === 'EPERM';
  }
}

/**
 * Spawn a measured sidecar as a process group leader (POSIX) and return a
 * handle whose `kill` signals the whole group plus every descendant seen in
 * the process table (a grandchild that called `setsid` or was spawned
 * `detached` is in another group but still has the child above it until it
 * dies), and whose `alive` reports whether anything is left.
 *
 * Residual: a process that double-forks away (its parent exits first, so it
 * is re-parented) AND leaves the group is not found. Windows has no process
 * group semantics here: `kill` stops the direct child only, `alive` reports
 * nothing (a job object is a tracked follow-up).
 */
export function spawnMeasuredChild(
  request: SpawnRequest,
  posix: boolean = process.platform !== 'win32',
): MeasureChild {
  const child = spawn(request.command, [...request.args], {
    cwd: request.cwd,
    env: { ...request.env },
    stdio: 'ignore',
    shell: false,
    windowsHide: true,
    detached: posix,
  });
  const exit = new Promise<unknown>((resolve) => {
    child.on('error', () => resolve(undefined));
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const pid = child.pid;
  if (!posix || pid === undefined) {
    const release = killOnProcessExit(() => {
      child.kill('SIGKILL');
    });
    return {
      kill: (signal) => {
        child.kill(signal);
      },
      exit,
      release,
    };
  }
  const known = new Set<number>();
  const refresh = async (): Promise<void> => {
    const rows = await processTable();
    if (rows === undefined) return;
    for (const descendant of descendantsOf(rows, pid)) known.add(descendant);
  };
  const signal = (name: 'SIGTERM' | 'SIGKILL'): void => {
    try {
      process.kill(-pid, name);
    } catch {
      // The group is already gone.
    }
    for (const other of known) {
      try {
        process.kill(other, name);
      } catch {
        // Already gone.
      }
    }
  };
  const release = killOnProcessExit(() => {
    // The descendants must be read while the tree is intact: once the group
    // is dead its children are re-parented and no longer lead back to `pid`.
    const rows = processTableSync();
    if (rows !== undefined) {
      for (const descendant of descendantsOf(rows, pid)) known.add(descendant);
    }
    signal('SIGKILL');
  });
  return {
    async kill(name) {
      await refresh();
      signal(name);
    },
    exit,
    release,
    async alive() {
      const rows = await processTable();
      if (rows === undefined) {
        return probe(-pid) || [...known].some(probe);
      }
      return rows.some(
        (row) =>
          !row.stat.startsWith('Z') && (row.pgid === pid || known.has(row.pid)),
      );
    },
  };
}

/** `MeasureSeams` backed by the real machine. */
export function createNodeMeasureSeams(): MeasureSeams {
  return {
    spawn: (request) => spawnMeasuredChild(request),
    version(request): Promise<string> {
      return new Promise((resolve) => {
        const child = spawn(request.command, [...request.args], {
          cwd: request.cwd,
          env: { ...request.env },
          stdio: ['ignore', 'pipe', 'ignore'],
          shell: false,
          windowsHide: true,
        });
        let out = '';
        child.stdout.on('data', (chunk: Buffer) => {
          out += chunk.toString('utf8');
        });
        child.on('error', () => resolve('unknown'));
        child.on('close', () => resolve(out.trim().slice(0, 64) || 'unknown'));
      });
    },
    health(url, timeoutMs): Promise<number | undefined> {
      return new Promise((resolve) => {
        const req = httpRequest(
          url,
          { method: 'GET', agent: false, timeout: timeoutMs },
          (res) => {
            res.resume();
            resolve(res.statusCode);
          },
        );
        req.on('timeout', () => {
          req.destroy();
          resolve(undefined);
        });
        req.on('error', () => resolve(undefined));
        req.end();
      });
    },
    freePort(): Promise<number> {
      return new Promise((resolve, reject) => {
        const server = createServer();
        server.on('error', reject);
        server.listen(0, '127.0.0.1', () => {
          const address = server.address();
          const port =
            address !== null && typeof address === 'object' ? address.port : 0;
          server.close(() => resolve(port));
        });
      });
    },
    now: () => performance.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async makeDataDir(template?: string): Promise<DataDirectory> {
      // The runtime refuses a data path with a symlinked component, and
      // `/tmp` and `/var` are symlinks on macOS: use the real directory.
      const base = await fsp.realpath(tmpdir());
      const path = await fsp.mkdtemp(join(base, 'smrt-desktop-measure-'));
      if (template !== undefined) {
        await fsp.cp(template, path, { recursive: true });
        await fsp.chmod(path, 0o700);
      }
      return {
        path,
        dispose: () => fsp.rm(path, { recursive: true, force: true }),
      };
    },
    diskUsage,
  };
}

export interface CreateBundleSeamsOptions {
  readonly fs?: TreeFs;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly keepStaging?: boolean;
  readonly sourceDateEpoch?: number;
  readonly onStage?: BundleSeams['onStage'];
}

/** The production seams: real filesystem, pnpm, nodejs.org and processes. */
export function createBundleSeams(
  options: CreateBundleSeamsOptions = {},
): BundleSeams {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const pnpm = createPnpmRunner({ platform });
  const epochText = env.SOURCE_DATE_EPOCH;
  const epoch =
    options.sourceDateEpoch ??
    (epochText !== undefined && /^\d{1,12}$/.test(epochText)
      ? Number(epochText)
      : undefined);
  return {
    fs: options.fs ?? nodeTreeFs,
    platform,
    arch: options.arch ?? process.arch,
    env,
    toolVersion: readToolVersion(),
    nodeVersion: process.versions.node,
    defaultNodeCacheDir: defaultNodeCacheDir(platform, env, homedir()),
    acquireNode: (acquire) => acquireNodeBinary(acquire),
    runPnpm: (request) => pnpm.run(request),
    pnpmVersion: (childEnv, cwd) => pnpm.version(childEnv, cwd),
    measure: (input) =>
      measureBundle(
        {
          executablePath: input.executablePath,
          resourcesDir: input.resourcesDir,
          bundleRoot: input.bundleRoot,
          sidecar: input.sidecar,
          baseEnv: buildChildEnv(input.baseEnv, {}, { platform }),
          files: input.files,
          ...(input.dataTemplate === undefined
            ? {}
            : { dataTemplate: input.dataTemplate }),
        },
        createNodeMeasureSeams(),
      ),
    ...(options.keepStaging === undefined
      ? {}
      : { keepStaging: options.keepStaging }),
    ...(epoch === undefined ? {} : { sourceDateEpoch: epoch }),
    ...(options.onStage === undefined ? {} : { onStage: options.onStage }),
  };
}
