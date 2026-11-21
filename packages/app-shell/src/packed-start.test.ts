/**
 * Start the server from the PACKED package (#5494).
 *
 * `npm pack --ignore-scripts` packs exactly what `files` selects from the
 * already built package (the release's prepack only rebuilds; the file
 * selection is the same), the tarball is extracted into a fresh empty
 * directory as `node_modules/@happyvertical/smrt-app-shell`, and the server
 * is started from there through the package `bin`, on an ephemeral port in the
 * local profile. The checkout is not on the child's path: it runs the tarball's
 * `build/`.
 *
 * Not a registry install. The tarball's dependencies are `workspace:*` (they
 * resolve to unpublished versions offline), so the extracted package gets
 * symlinks to the workspace's own installed dependencies next to it
 * (`node_modules/*`): the dependencies are the workspace's, the package under
 * test is the tarball's.
 */
import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, expect, it } from 'vitest';

const pkgRoot = fileURLToPath(new URL('..', import.meta.url));
let work = '';
let installed = '';
let dataRoot = '';
let child: ChildProcess | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number };
      s.close(() => resolve(port));
    });
  });
}

beforeAll(() => {
  if (!existsSync(join(pkgRoot, 'build/index.js'))) {
    throw new Error(
      'Run `pnpm build` first: build/ (the server build) is missing',
    );
  }
  // Canonical path: the runtime refuses a state root under a symlink (/var).
  work = realpathSync(mkdtempSync(join(tmpdir(), 'app-shell-packed-')));
  // Apart from the working directory: local data may not overlap the source tree.
  dataRoot = realpathSync(mkdtempSync(join(tmpdir(), 'app-shell-data-')));
  const packDir = join(work, 'pack');
  mkdirSync(packDir);
  const [{ filename, files }] = JSON.parse(
    execFileSync(
      'npm',
      ['pack', '--ignore-scripts', '--json', '--pack-destination', packDir],
      { cwd: pkgRoot, encoding: 'utf8' },
    ),
  ) as [{ filename: string; files: { path: string }[] }];
  const paths = files.map((f) => f.path);
  // What a consumer needs to start: the entry, the server build, the bin.
  for (const required of [
    'build/index.js',
    'build/server-start.js',
    'bin/smrt-app-shell.mjs',
    'dist/lib/server/shutdown.js',
  ]) {
    expect(paths, required).toContain(required);
  }
  const nm = join(work, 'node_modules');
  installed = join(nm, '@happyvertical', 'smrt-app-shell');
  mkdirSync(installed, { recursive: true });
  execFileSync('tar', [
    '-xzf',
    join(packDir, filename),
    '-C',
    installed,
    '--strip-components=1',
  ]);
  // The workspace's dependencies, next to the tarball's package.
  const own = join(pkgRoot, 'node_modules');
  for (const name of readdirSync(own)) {
    if (name.startsWith('.')) continue;
    if (name.startsWith('@')) {
      mkdirSync(join(nm, name), { recursive: true });
      for (const sub of readdirSync(join(own, name))) {
        const link = join(nm, name, sub);
        if (!existsSync(link)) symlinkSync(join(own, name, sub), link);
      }
    } else if (!existsSync(join(nm, name))) {
      symlinkSync(join(own, name), join(nm, name));
    }
  }
});

afterAll(() => {
  // Only the child this test started, by handle.
  if (child && child.exitCode === null) child.kill('SIGKILL');
  for (const dir of [work, dataRoot]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

it('starts from the tarball, answers /api/_runtime/health, drains on SIGTERM and exits 0', async () => {
  const port = await freePort();
  let log = '';
  child = spawn(process.execPath, [join(installed, 'bin/smrt-app-shell.mjs')], {
    cwd: work,
    env: {
      PATH: process.env.PATH,
      HOME: dataRoot,
      SMRT_APP_ID: 'packed-start-test',
      SMRT_RUNTIME_PROFILE: 'local',
      SMRT_DATA_DIR: join(dataRoot, 'data'),
      HOST: '127.0.0.1',
      PORT: String(port),
      SMRT_APP_SHELL_SHUTDOWN_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (log += d));
  child.stderr?.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((resolve) =>
    child?.once('exit', (code) => resolve(code)),
  );

  let body: unknown;
  const t = Date.now();
  while (Date.now() - t < 90_000) {
    if (child.exitCode !== null)
      throw new Error(`server exited early:\n${log}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/_runtime/health`);
      if (res.ok) {
        body = await res.json();
        break;
      }
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  expect(body, log).toMatchObject({ status: 'ready', profile: 'local' });

  child.kill('SIGTERM');
  expect(await exited, log).toBe(0);
  expect(log).toContain('[shutdown] SIGTERM: draining');
});
