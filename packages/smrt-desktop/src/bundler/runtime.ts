/**
 * The real-machine seams of the bundler: the default filesystem, pnpm runner,
 * Node acquisition, measurement and environment. The CLI composes these; the
 * tests inject fakes instead. This is the only module that touches
 * `child_process`, `http` and `net`.
 */

import { spawn } from 'node:child_process';
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

/** `MeasureSeams` backed by the real machine. */
export function createNodeMeasureSeams(): MeasureSeams {
  return {
    spawn(request): MeasureChild {
      const child = spawn(request.command, [...request.args], {
        cwd: request.cwd,
        env: { ...request.env },
        stdio: 'ignore',
        shell: false,
        windowsHide: true,
      });
      const exit = new Promise<unknown>((resolve) => {
        child.on('error', () => resolve(undefined));
        child.on('close', (code, signal) => resolve({ code, signal }));
      });
      return {
        kill: (signal) => {
          child.kill(signal);
        },
        exit,
      };
    },
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
    async makeDataDir(): Promise<DataDirectory> {
      const path = await fsp.mkdtemp(join(tmpdir(), 'smrt-desktop-measure-'));
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
