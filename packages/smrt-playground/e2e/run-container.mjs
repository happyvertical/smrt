import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const image = 'smrt-playground-visual:1.63.0';
const build = spawnSync(
  'docker',
  [
    'build',
    '--platform',
    'linux/amd64',
    '-t',
    image,
    '-f',
    'packages/smrt-playground/e2e/Dockerfile',
    'packages/smrt-playground/e2e',
  ],
  { cwd: root, stdio: 'inherit' },
);
if (build.status !== 0) process.exit(build.status ?? 1);

// Never mistake an unrelated listener for the server this invocation owns.
await new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once('error', reject);
  probe.listen(5560, '0.0.0.0', () => probe.close(resolve));
});

// The host compiles workspace source on the native toolchain; all rendering
// happens in the same Linux AMD64 browser/font image as CI.
const host = spawn(
  'pnpm',
  [
    '--filter',
    'smrt-playground-host',
    'dev',
    '--host',
    '0.0.0.0',
    '--port',
    '5560',
    '--strictPort',
  ],
  {
    cwd: root,
    stdio: 'inherit',
    detached: true,
    env: {
      ...process.env,
      // biome-ignore lint/style/useNamingConvention: Vite-defined environment variable.
      __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: 'host.docker.internal',
    },
  },
);
let hostExited = false;
host.on('exit', () => {
  hostExited = true;
});
const stop = () => {
  try {
    process.kill(-host.pid, 'SIGTERM');
  } catch {
    /* already stopped */
  }
};
process.on('exit', stop);
process.on('SIGTERM', () => process.exit(143));
process.on('SIGINT', () => process.exit(130));
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (hostExited)
      throw new Error(
        'Playground host exited before becoming ready (port 5560 must be free).',
      );
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      const response = await fetch('http://127.0.0.1:5560', {
        signal: AbortSignal.timeout(1000),
      });
      if (response.ok && !hostExited) {
        ready = true;
        break;
      }
    } catch {
      /* server is starting */
    }
  }
  if (!ready) throw new Error('Playground host did not become ready.');
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '--platform',
      'linux/amd64',
      '--ipc=host',
      '--add-host=host.docker.internal:host-gateway',
      '-v',
      `${root}:/workspace`,
      '-e',
      'SMRT_VISUAL_BASE_URL=http://host.docker.internal:5560',
      image,
      ...process.argv.slice(2),
    ],
    { cwd: root, stdio: 'inherit' },
  );
  process.exitCode = result.status ?? 1;
} finally {
  stop();
}
