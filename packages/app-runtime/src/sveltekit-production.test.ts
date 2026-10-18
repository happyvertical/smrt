import { execFile } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it } from 'vitest';

const exec = promisify(execFile);
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
});

it('preserves runtime redirects and action failures across a production SvelteKit build', async () => {
  root = mkdtempSync(resolve(import.meta.dirname, '../.production-fixture-'));
  const write = (name: string, source: string) => {
    const path = join(root as string, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source);
  };
  // A real installed directory is essential: Vite bundles workspace symlinks
  // by default and would hide this production-only externalization regression.
  const installed = join(root, 'node_modules/@happyvertical/smrt-app-runtime');
  mkdirSync(installed, { recursive: true });
  symlinkSync(
    resolve(import.meta.dirname, '../../core/node_modules/svelte'),
    join(root, 'node_modules/svelte'),
    'dir',
  );
  cpSync(resolve(import.meta.dirname, '../dist'), join(installed, 'dist'), {
    recursive: true,
  });
  cpSync(
    resolve(import.meta.dirname, '../package.json'),
    join(installed, 'package.json'),
  );
  symlinkSync(
    resolve(import.meta.dirname, '../node_modules'),
    join(installed, 'node_modules'),
    'dir',
  );
  write(
    'package.json',
    JSON.stringify({
      name: '@fixture/production-runtime',
      type: 'module',
      private: true,
      dependencies: Object.fromEntries(
        ['app-runtime', 'config', 'core', 'profiles', 'tenancy', 'users'].map(
          (name) => ['@happyvertical/smrt-' + name, '*'],
        ),
      ),
    }),
  );
  const adapter = pathToFileURL(
    resolve(
      import.meta.dirname,
      '../../template-sveltekit/node_modules/@sveltejs/adapter-node/index.js',
    ),
  ).href;
  write(
    'svelte.config.js',
    `import adapter from ${JSON.stringify(adapter)}; export default { kit: { adapter: adapter() } };`,
  );
  write(
    'tsconfig.json',
    JSON.stringify({ extends: './.svelte-kit/tsconfig.json' }),
  );
  write(
    'src/app.html',
    '<html><head>%sveltekit.head%</head><body>%sveltekit.body%</body></html>',
  );
  write('src/routes/+page.svelte', '<h1>Production fixture</h1>');
  write('src/routes/setup/+page.svelte', '<h1>Setup</h1>');
  write(
    'src/routes/setup/+page.server.js',
    `
import { createOwnerSetupPage, createSmrtSvelteKitRuntime } from '@happyvertical/smrt-app-runtime/sveltekit';
import { LocalRuntimeError } from '@happyvertical/smrt-app-runtime';
if (typeof createSmrtSvelteKitRuntime !== 'function') throw new Error('Missing runtime implementation');
const runtime = {
  resolvedRuntime: async () => ({ profile: 'local' }),
  localRuntime: async () => ({
    diagnostics: async () => ({ bootstrap: { status: 'ready' } }),
    claimOwner: async ({ name }) => {
      if (name === 'Conflict') throw new LocalRuntimeError('owner_tenant_conflict', 'fixture');
      return { sessionId: 'fixture-session' };
    }
  }),
  sessionCookie: { name: 'fixture-session', path: '/', sameSite: 'lax', maxAgeSeconds: 3600 }
};
export const { load, actions } = createOwnerSetupPage(runtime, {
  resolveUser: (event) => event.url.searchParams.has('signed-in') ? { id: 'fixture-user' } : null
});
`,
  );
  const preset = pathToFileURL(
    resolve(import.meta.dirname, '../../core/src/vite-preset/index.ts'),
  ).href;
  write(
    'vite.config.ts',
    `
import { sveltekit } from '@sveltejs/kit/vite';
import { smrt } from ${JSON.stringify(preset)};
// Isolate the preset's runtime boundary from unrelated model generation.
const shared = (await smrt({ packages: [] })).filter(plugin => plugin.name === 'smrt:shared-runtime');
// These fixture peers are workspace symlinks; registry installs are external
// by default. Keep their installed behavior without bundling unrelated models.
export default { ssr: { external: ['@happyvertical/smrt-users', '@happyvertical/smrt-core', '@happyvertical/smrt-config', '@happyvertical/smrt-profiles', '@happyvertical/smrt-tenancy'] }, plugins: [sveltekit(), ...shared] };
`,
  );
  write(
    'dev-probe.mjs',
    `
import { createServer } from 'vite';
const server = await createServer({ server: { host: '127.0.0.1', port: 0 } });
try {
  await server.listen();
  const origin = 'http://127.0.0.1:' + server.httpServer.address().port;
  const response = await fetch(origin + '/setup?signed-in', { redirect: 'manual' });
  console.log(JSON.stringify({ status: response.status, location: response.headers.get('location') }));
} finally { await server.close(); }
`,
  );
  const devProbe = await exec(process.execPath, ['dev-probe.mjs'], {
    cwd: root,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  expect(
    JSON.parse(devProbe.stdout.trim().split('\n').at(-1) as string),
    devProbe.stderr,
  ).toEqual({
    status: 303,
    location: '/',
  });
  const viteCli = resolve(
    import.meta.dirname,
    '../node_modules/vite/bin/vite.js',
  );
  await exec(process.execPath, [viteCli, 'build'], {
    cwd: root,
    timeout: 110000,
    maxBuffer: 32 * 1024 * 1024,
  });
  const serverOutput = join(root, '.svelte-kit/output/server');
  const serverSource = readdirSync(serverOutput, { recursive: true })
    .filter((name) => typeof name === 'string' && name.endsWith('.js'))
    .map((name) => readFileSync(join(serverOutput, name as string), 'utf8'))
    .join('\n');
  expect(serverSource).toContain('from "@happyvertical/smrt-app-runtime"');
  expect(serverSource).toContain(
    'from "@happyvertical/smrt-app-runtime/sveltekit-runtime"',
  );
  expect(serverSource).not.toContain(
    'from "@happyvertical/smrt-app-runtime/sveltekit"',
  );
  write(
    'probe.mjs',
    `
import { createServer } from 'node:http';
process.env.PROTOCOL_HEADER = 'x-forwarded-proto';
process.env.ADDRESS_HEADER = 'x-test-peer';
const { handler } = await import('./build/handler.js');
const server = createServer(handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;
const results = [];
try {
  for (const [path, body, peer, html] of [
    ['/setup?signed-in', null, null],
    ['/setup', 'token=fixture&name=Owner&email=owner%40example.test', null],
    ['/setup', '', null],
    ['/setup', '', '203.0.113.1'],
    ['/setup', 'token=fixture&name=Owner&email=owner%40example.test', null, true],
    ['/setup', 'token=fixture&name=Conflict&email=owner%40example.test', null]
  ]) {
    const response = await fetch(origin + path, { redirect: 'manual', headers: { 'x-forwarded-proto': 'http' }, ...(body === null ? {} : {
      method: 'POST', headers: { 'x-forwarded-proto': 'http', origin, 'x-test-peer': peer || '127.0.0.1', 'content-type': 'application/x-www-form-urlencoded', accept: html ? 'text/html' : 'application/json', ...(html ? {} : { 'x-sveltekit-action': 'true' }) }, body
    }) });
    results.push({ status: response.status, location: response.headers.get('location'), cookie: response.headers.has('set-cookie'), body: body === null ? '' : await response.text() });
  }
} finally { await new Promise(resolve => server.close(resolve)); }
console.log(JSON.stringify(results));
`,
  );
  const { stdout } = await exec(process.execPath, ['probe.mjs'], {
    cwd: root,
    timeout: 30000,
    maxBuffer: 1024 * 1024,
  });
  const results = JSON.parse(stdout.trim().split('\n').at(-1) as string);
  expect(results[0]).toMatchObject({ status: 303, location: '/' });
  expect(results[1]).toMatchObject({ status: 200, cookie: true });
  expect(JSON.parse(results[1].body)).toMatchObject({
    type: 'redirect',
    status: 303,
    location: '/',
  });
  expect(results[2]).toMatchObject({ status: 200, cookie: false });
  expect(JSON.parse(results[2].body)).toMatchObject({
    type: 'failure',
    status: 400,
  });
  expect(JSON.parse(results[3].body)).toMatchObject({
    type: 'failure',
    status: 403,
  });
  expect(results[4]).toMatchObject({
    status: 303,
    location: '/',
    cookie: true,
  });
  expect(JSON.parse(results[5].body)).toMatchObject({
    type: 'failure',
    status: 409,
  });
}, 150000);
