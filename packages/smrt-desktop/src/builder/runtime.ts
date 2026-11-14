/**
 * The real seams of `smrt desktop build`: `node:fs/promises` and
 * `node:child_process`. Nothing here runs in a test that must stay offline;
 * `run.test.ts` uses the fakes in `testing/`.
 */

import { spawn } from 'node:child_process';
import { constants, promises as fsp } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BuildError } from './errors.js';
import type { BuildFs, BuildSeams, ChildRequest, EntryKind } from './run.js';

const PACKAGE_NAME = '@happyvertical/smrt-desktop';

/** The directory of this package (the nearest ancestor `package.json` by name). */
export async function findPackageRoot(
  start = dirname(fileURLToPath(import.meta.url)),
): Promise<string> {
  let dir = start;
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(
        await fsp.readFile(join(dir, 'package.json'), 'utf8'),
      ) as { name?: unknown };
      if (manifest.name === PACKAGE_NAME) return dir;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new BuildError('wrapper_missing');
}

export const nodeBuildFs: BuildFs = {
  async kind(path): Promise<EntryKind> {
    try {
      const stat = await fsp.lstat(path);
      if (stat.isFile()) return 'file';
      if (stat.isDirectory()) return 'dir';
      return 'other';
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
  },
  async readFile(path, maxBytes) {
    const handle = await fsp.open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > maxBytes) {
        throw new Error('not a bounded regular file');
      }
      return new Uint8Array(await handle.readFile());
    } finally {
      await handle.close();
    }
  },
  async readdir(path) {
    return (await fsp.readdir(path)).sort();
  },
  async mkdirp(path) {
    await fsp.mkdir(path, { recursive: true });
  },
  async writeFile(path, data, mode) {
    await fsp.writeFile(path, data, { flag: 'wx', mode });
  },
  async mkdtemp(parent, prefix) {
    return fsp.mkdtemp(join(parent, prefix));
  },
  async rename(from, to) {
    await fsp.rename(from, to);
  },
  async removeTree(path) {
    await fsp.rm(path, { recursive: true, force: true });
  },
};

function spawnChild(
  request: ChildRequest,
  capture: boolean,
): Promise<{ code: number; stdout: string }> {
  return new Promise((resolvePromise, reject) => {
    // `tauri` and `cargo` are `.cmd` shims on Windows; the argv here is fixed
    // by this module (no user text), so a shell is only used for them.
    const shell = process.platform === 'win32' && request.command === 'tauri';
    const child = spawn(request.command, [...request.args], {
      cwd: request.cwd,
      env: { ...request.env },
      stdio: capture ? ['ignore', 'pipe', 'ignore'] : 'inherit',
      shell,
      windowsHide: true,
    });
    let stdout = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (stdout.length < 4096) stdout += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('close', (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}

export async function createBuildSeams(
  options: { onStage?: (stage: import('./errors.js').BuildStage) => void } = {},
): Promise<BuildSeams> {
  const root = await findPackageRoot();
  return {
    fs: nodeBuildFs,
    run: async (request) => (await spawnChild(request, false)).code,
    capture: (request) => spawnChild(request, true),
    wrapperRoot: join(root, 'wrapper'),
    nodePath: process.execPath,
    platform: process.platform,
    env: process.env,
    ...(options.onStage === undefined ? {} : { onStage: options.onStage }),
  };
}
