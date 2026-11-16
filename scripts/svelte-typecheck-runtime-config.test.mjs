import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const runtimeConfig = `import { writeFileSync } from 'node:fs';
writeFileSync(new URL('./runtime-vite-loaded', import.meta.url), 'loaded');
export default {};`;

for (const name of [
  'app-shell',
  'assets',
  'chat',
  'commerce',
  'content',
  'events',
  'images',
  'ingestion',
  'planner',
  'projects',
  'smrt-playground',
  'smrt-svelte',
  'smrt-workbench',
]) {
  test(`${name} checks CSS without loading runtime Vite config`, async (t) => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-svelte-typecheck-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const marker = join(root, 'runtime-vite-loaded');
    writeFileSync(join(root, 'vite.config.mjs'), runtimeConfig);
    const { default: build } = await import(`../packages/${name}/svelte.config.js`);
    const { default: check } = await import(`../packages/${name}/svelte.config.typecheck.js`);
    const input = {
      attributes: {},
      content: '.example { color: red; }',
      filename: join(root, 'Example.svelte'),
    };
    const cwd = process.cwd();
    process.chdir(root);
    try {
      const css = await check.preprocess.style(input);
      assert.match(css.code, /color: red/);
      assert.equal(existsSync(marker), false);
      assert.deepEqual(check.compilerOptions, build.compilerOptions);
      assert.equal(check.kit, build.kit);
      await build.preprocess.style(input);
      assert.equal(existsSync(marker), true);
    } finally {
      process.chdir(cwd);
    }
  });
}

test('a workspace-scoped Svelte check skips a sibling Vite config', (t) => {
  const packageDir = join(workspace, 'packages/users');
  const stateDir = join(packageDir, '.smrt');
  mkdirSync(stateDir, { recursive: true });
  const root = mkdtempSync(join(stateDir, 'svelte-check-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const caller = join(root, 'consumer');
  const sibling = join(root, 'sibling');
  mkdirSync(caller);
  mkdirSync(sibling);
  writeFileSync(join(caller, 'tsconfig.json'), JSON.stringify({
    compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', types: ['node'] },
    include: ['Consumer.svelte', '../sibling/Widget.svelte'],
  }));
  writeFileSync(join(caller, 'Consumer.svelte'), '<script>import Widget from "../sibling/Widget.svelte";</script><Widget />');
  writeFileSync(join(sibling, 'Widget.svelte'), '<span>Sibling</span>');
  writeFileSync(join(sibling, 'vite.config.mjs'), runtimeConfig);

  const require = createRequire(import.meta.url);
  const manifest = require.resolve('svelte-check/package.json', { paths: [packageDir] });
  const args = [
    '--config', join(workspace, 'scripts/svelte.config.typecheck.mjs'),
    '--tsconfig', 'tsconfig.json',
  ];
  const run = (script) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: caller,
      encoding: 'utf8',
    });

  const marker = join(sibling, 'runtime-vite-loaded');
  const local = run(join(dirname(manifest), 'bin/svelte-check'));
  assert.equal(local.status, 1, local.stdout + local.stderr);
  assert.match(local.stdout + local.stderr, /No Svelte configuration found/);
  assert.equal(existsSync(marker), true);
  rmSync(marker);
  const scoped = run(join(workspace, 'scripts/svelte-check-workspace.mjs'));
  assert.equal(scoped.status, 0, scoped.stdout + scoped.stderr);
  assert.doesNotMatch(scoped.stdout + scoped.stderr, /Cannot find type definition file/);
  assert.equal(existsSync(marker), false);
});
