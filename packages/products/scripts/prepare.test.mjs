import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const packageDir = fileURLToPath(new URL('../', import.meta.url));
const products = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'));
const core = '@happyvertical/smrt-core';
const assets = '@happyvertical/smrt-assets';
const write = (path, content) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content)}\n`);
};

function fixture(t, { built = [], failure = false, signal = false, metadataOnly = [], missingArtifact, corrupt } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'products-prepare-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  write(join(root, 'package.json'), { private: true });
  write(join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'packages/*'\nlinkWorkspacePackages: true\n");
  for (const [directory, name] of [['core', core], ['assets', assets]]) {
    write(join(root, 'packages', directory, 'package.json'), {
      name, version: '1.0.0', main: 'dist/index.js', types: 'dist/index.d.ts',
      ...(directory === 'core' ? { exports: { './vite-plugin': {
        import: './dist/vite-plugin.js', types: './dist/vite-plugin.d.ts',
      } } } : {}),
      ...(corrupt && directory === 'assets' ? { scripts: { postinstall: 'node corrupt.cjs' } } : {}),
    });
    if (built.includes(directory)) {
      write(join(root, 'packages', directory, 'dist/index.js'), '');
      write(join(root, 'packages', directory, 'dist/index.d.ts'), '');
      if (directory === 'core') {
        write(join(root, 'packages/core/dist/vite-plugin.js'), '');
        write(join(root, 'packages/core/dist/vite-plugin.d.ts'), '');
        // Retain the old private path only for the original-command regression.
        write(join(root, 'packages/core/dist/vite-plugin/index.js'), '');
      }
    }
  }
  for (const directory of metadataOnly) {
    write(join(root, 'packages', directory, 'dist/manifest.json'), '{}');
  }
  if (missingArtifact) rmSync(join(root, 'packages', missingArtifact));
  if (corrupt) {
    const mutation = {
      missing: "require('node:fs').unlinkSync('package.json')",
      malformed: "require('node:fs').writeFileSync('package.json', '{broken')",
      identity: "require('node:fs').writeFileSync('package.json', JSON.stringify({name:'wrong-package'}))",
      output: "require('node:fs').writeFileSync('dist', 'not a directory')",
    }[corrupt];
    write(join(root, 'packages/assets/corrupt.cjs'), mutation);
  }
  const dir = join(root, 'packages/products');
  write(join(dir, 'package.json'), {
    name: products.name, version: '1.0.0', type: 'module',
    main: products.main, types: products.types, files: products.files,
    dependencies: { [core]: 'workspace:*', [assets]: 'workspace:*' },
    devDependencies: { '@fixture/source-only': 'workspace:*' },
    scripts: { prepare: products.scripts.prepare, build: 'node build.mjs' },
  });
  write(join(root, 'packages/source-only/package.json'), { name: '@fixture/source-only', version: '1.0.0' });
  cpSync(join(packageDir, 'scripts/prepare.mjs'), join(dir, 'scripts/prepare.mjs'));
  write(join(dir, 'build.mjs'), `
import { accessSync, mkdirSync, writeFileSync } from 'node:fs';
for (const name of ${JSON.stringify([core, assets])}) {
  accessSync('node_modules/' + name + '/dist/index.js');
  accessSync('node_modules/' + name + '/dist/index.d.ts');
}
accessSync('node_modules/${core}/dist/vite-plugin.js');
accessSync('node_modules/${core}/dist/vite-plugin.d.ts');
console.log('fixture real build invoked');
${signal ? "process.kill(process.pid, 'SIGTERM');" : failure ? "console.error('fixture build failed deliberately'); process.exit(23);" : "mkdirSync('dist/lib', {recursive:true}); writeFileSync('dist/lib/index.js', 'export {};'); writeFileSync('dist/lib/index.d.ts', 'export {};');"}
`);
  return { root, dir };
}

function run(root, args) {
  const result = spawnSync('pnpm', args, { cwd: root, encoding: 'utf8', timeout: 60_000 });
  assert.ifError(result.error);
  return { ...result, output: `${result.stdout}\n${result.stderr}` };
}
const install = (root) => run(root, ['install', '--offline', '--reporter=append-only']);

for (const [label, built, absent] of [
  ['cold', [], [core, assets]],
  ['core-only', ['core'], [assets]],
]) {
  test(`normal pnpm install defers ${label} workspace and names missing prerequisites`, (t) => {
    const { root, dir } = fixture(t, { built });
    const result = install(root);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Deferring products build/);
    for (const name of absent) assert.ok(result.output.includes(`${name}/dist`), result.output);
    assert.doesNotMatch(result.output, /fixture real build invoked/);
    assert.equal(existsSync(join(dir, products.main)), false);
  });
}

for (const [label, options, absent] of [
  ['metadata-only dist directories', { built: ['core'], metadataOnly: ['assets'] }, `${assets}/dist/index.js`],
  ['missing dependency types', { built: ['core', 'assets'], missingArtifact: 'assets/dist/index.d.ts' }, `${assets}/dist/index.d.ts`],
  ['missing public plugin import', { built: ['core', 'assets'], missingArtifact: 'core/dist/vite-plugin.js' }, `${core}/dist/vite-plugin.js`],
  ['missing public plugin types', { built: ['core', 'assets'], missingArtifact: 'core/dist/vite-plugin.d.ts' }, `${core}/dist/vite-plugin.d.ts`],
]) {
  test(`normal pnpm install defers ${label} until compiled prerequisites exist`, (t) => {
    const { root, dir } = fixture(t, options);
    const result = install(root);
    assert.equal(result.status, 0, result.output);
    assert.match(result.output, /Deferring products build/);
    assert.ok(result.output.includes(absent), result.output);
    assert.doesNotMatch(result.output, /fixture real build invoked/);
    assert.equal(existsSync(join(dir, products.main)), false);
  });
}

test('normal pnpm install builds when production workspace outputs exist, without requiring dev output', (t) => {
  const { root, dir } = fixture(t, { built: ['core', 'assets'] });
  const result = install(root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /fixture real build invoked/);
  assert.equal(existsSync(join(dir, products.main)), true);
});

test('normal pnpm install propagates a real build failure', (t) => {
  const { root, dir } = fixture(t, { built: ['core', 'assets'], failure: true });
  const result = install(root);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /fixture build failed deliberately/);
  assert.match(result.output, /23/);
  assert.equal(existsSync(join(dir, products.main)), false);
});

test('normal pnpm install propagates build termination', (t) => {
  const { root } = fixture(t, { built: ['core', 'assets'], signal: true });
  const result = install(root);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /fixture real build invoked/);
  // pnpm normalizes the child's signal into its lifecycle failure.
  assert.match(result.output, /ELIFECYCLE/);
  assert.doesNotMatch(result.output, /Deferring products build/);
});

for (const [corrupt, message] of [
  ['missing', /ENOENT/],
  ['malformed', /SyntaxError|ERR_PNPM_JSON_PARSE/],
  ['identity', /expected installed workspace dependency/],
  ['output', /must be a build output directory/],
]) {
  test(`normal pnpm install rejects ${corrupt} dependency state even while core output is absent`, (t) => {
    const { root } = fixture(t, { corrupt });
    const result = install(root);
    assert.notEqual(result.status, 0, result.output);
    assert.match(result.output, message);
    assert.doesNotMatch(result.output, /Deferring products build/);
  });
}

test('pnpm pack ships prepare helper and preserves compiled consumer behavior', (t) => {
  const { root, dir } = fixture(t, { built: ['core', 'assets'] });
  const installed = install(root);
  assert.equal(installed.status, 0, installed.output);
  const packed = run(dir, ['pack', '--out', join(root, 'products.tgz')]);
  assert.equal(packed.status, 0, packed.output);
  rmSync(dir, { recursive: true });
  mkdirSync(dir);
  const extracted = spawnSync('tar', ['-xzf', join(root, 'products.tgz'), '--strip-components=1', '-C', dir], { encoding: 'utf8' });
  assert.equal(extracted.status, 0, extracted.stderr);
  assert.equal(existsSync(join(dir, 'scripts/prepare.mjs')), true);
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  assert.equal(manifest.dependencies[core].includes('workspace:'), false);
  // pnpm removes prepare when packing; other packers may retain it.
  assert.equal(manifest.scripts.prepare, undefined);
  rmSync(join(root, 'pnpm-lock.yaml'), { force: true });
  rmSync(join(root, 'node_modules'), { recursive: true, force: true });
  const consumer = install(root);
  assert.equal(consumer.status, 0, consumer.output);
  assert.doesNotMatch(consumer.output, /fixture real build invoked/);
});

for (const complete of [true, false]) {
  test(`normal pnpm install of non-workspace manifest ${complete ? 'uses compiled artifacts without rebuilding' : 'rejects missing compiled artifacts'}`, (t) => {
    const { root, dir } = fixture(t);
    const path = join(dir, 'package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    manifest.dependencies = { [core]: '1.0.0', [assets]: '1.0.0' };
    write(path, manifest);
    write(join(dir, products.main), 'export {};');
    if (complete) write(join(dir, products.types), 'export {};');
    const result = install(root);
    assert.equal(result.status === 0, complete, result.output);
    assert.doesNotMatch(result.output, /fixture real build invoked|Deferring products build/);
    if (!complete) assert.match(result.output, /missing compiled types artifact/);
  });
}
