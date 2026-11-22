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
  writeFileSync,
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
    'build/embed.js',
    'bin/smrt-app-shell.mjs',
    'dist/lib/server/shutdown.js',
    'dist/lib/server/embed.d.ts',
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

function shellEnv(port: number, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH,
    HOME: dataRoot,
    SMRT_APP_ID: 'packed-start-test',
    SMRT_RUNTIME_PROFILE: 'local',
    SMRT_DATA_DIR: join(dataRoot, 'data'),
    HOST: '127.0.0.1',
    PORT: String(port),
    SMRT_APP_SHELL_SHUTDOWN_MS: '10000',
    ...extra,
  };
}

/** Start the packed server through the bin and wait for health. */
async function startPacked(extra: Record<string, string> = {}) {
  const port = await freePort();
  let log = '';
  child = spawn(process.execPath, [join(installed, 'bin/smrt-app-shell.mjs')], {
    cwd: work,
    env: shellEnv(port, extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const proc = child;
  proc.stdout?.on('data', (d) => (log += d));
  proc.stderr?.on('data', (d) => (log += d));
  const exited = new Promise<number | null>((resolve) =>
    proc.once('exit', (code) => resolve(code)),
  );
  let body: unknown;
  const t = Date.now();
  while (Date.now() - t < 90_000) {
    if (proc.exitCode !== null) throw new Error(`server exited early:\n${log}`);
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
  return { proc, port, exited, body, log: () => log };
}

it('starts from the tarball, answers /api/_runtime/health, drains on SIGTERM and exits 0', async () => {
  const s = await startPacked();
  expect(s.body, s.log()).toMatchObject({ status: 'ready', profile: 'local' });
  s.proc.kill('SIGTERM');
  expect(await s.exited, s.log()).toBe(0);
  expect(s.log()).toContain('[shutdown] SIGTERM: draining');
});

it('keeps serving for SMRT_APP_SHELL_PREDRAIN_MS after SIGTERM, then drains and exits 0 (#5546)', async () => {
  const s = await startPacked({ SMRT_APP_SHELL_PREDRAIN_MS: '2500' });
  expect(s.body, s.log()).toMatchObject({ status: 'ready' });
  s.proc.kill('SIGTERM');
  // The listener is still open and answering inside the delay.
  await new Promise((r) => setTimeout(r, 500));
  const during = await fetch(`http://127.0.0.1:${s.port}/api/_runtime/health`);
  expect(during.status, s.log()).toBe(200);
  expect(await s.exited, s.log()).toBe(0);
  expect(s.log()).toContain('still serving for 2500 ms');
  expect(s.log()).toContain('[shutdown] SIGTERM: draining');
});

it('hands an embedding host the handler and the drain: the host listener stays open and the process is not exited (#5546)', async () => {
  const port = await freePort();
  const script = join(work, 'embed-check.mjs');
  // The host: its own listener, the packed handler, then the drain.
  writeFileSync(
    script,
    `import http from 'node:http';
const { handler, drain } = await import('@happyvertical/smrt-app-shell/embed');
const server = http.createServer(handler);
await new Promise((resolve) => server.listen(${port}, '127.0.0.1', resolve));
const url = 'http://127.0.0.1:${port}/api/_runtime/health';
const served = await fetch(url);
const body = await served.json();
const signalHandlers = process.listenerCount('SIGTERM') + process.listenerCount('SIGINT');
const first = drain();
const same = drain() === first;
const result = await first;
const listening = server.listening;
const after = await fetch(url);
console.log('EMBED ' + JSON.stringify({ status: served.status, body, signalHandlers, same, result, listening, after: after.status }));
server.close();
server.closeAllConnections();
`,
  );
  const out = execFileSync(process.execPath, [script], {
    cwd: work,
    env: shellEnv(port),
    encoding: 'utf8',
    timeout: 90_000,
  });
  const line = out.split('\n').find((l) => l.startsWith('EMBED '));
  expect(line, out).toBeDefined();
  const r = JSON.parse((line as string).slice(6));
  expect(r.status).toBe(200);
  expect(r.body).toMatchObject({ status: 'ready', profile: 'local' });
  // The shell installed no signal handler of its own in the host's process.
  expect(r.signalHandlers).toBe(0);
  expect(r.same).toBe(true);
  expect(r.result).toMatchObject({ code: 0, clean: true });
  expect(r.result.steps).toMatchObject({
    endStreams: 'ok',
    stopAccepting: 'skipped',
    stopWork: 'ok',
    drain: 'ok',
  });
  // The host's listener is still open and still answers after the drain.
  expect(r.listening).toBe(true);
  expect(r.after).toBeGreaterThanOrEqual(200);
});
