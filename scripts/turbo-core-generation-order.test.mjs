import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { packageManager } = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));

test('core test generation runs after the production pair writer and never overwrites it, including cached runs (#2760)', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-core-generation-order-'));
  const core = join(root, 'packages/core');
  const write = (path, content) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  try {
    write(join(root, 'package.json'), JSON.stringify({ name: 'core-order-fixture', private: true, packageManager }));
    write(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n');
    write(join(root, 'turbo.json'), readFileSync(join(repository, 'turbo.json'), 'utf8'));
    const coreConfig = join(repository, 'packages/core/turbo.json');
    if (existsSync(coreConfig)) write(join(core, 'turbo.json'), readFileSync(coreConfig, 'utf8'));
    write(join(core, 'package.json'), JSON.stringify({ name: '@happyvertical/smrt-core', version: '1.0.0', scripts: {
      build: 'node build.mjs', 'generate:test': 'node test-manifest.mjs', typecheck: 'node check.mjs',
    } }));
    // Integration tests use real packages; this fixture isolates core's
    // artifact writers with lightweight providers for their task prerequisites.
    for (const dependency of ['approvals', 'smrt-web']) {
      const { name, version } = JSON.parse(readFileSync(join(repository, 'packages', dependency, 'package.json'), 'utf8'));
      write(join(root, 'packages', dependency, 'package.json'), JSON.stringify({ name, version, scripts: { build: 'node -e ""' } }));
    }
    write(join(core, 'build.mjs'), `
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('.smrt', { recursive: true });
      writeFileSync('.smrt/manifest.json', 'production');
      await new Promise(resolve => setTimeout(resolve, 300));
      writeFileSync('.smrt/smrt-knowledge.json', 'production');
      mkdirSync('dist', { recursive: true });
      writeFileSync('dist/ready', 'production complete');
    `);
    // generate:test owns only src/manifest/test-manifest.json (its declared
    // Turbo output); the .smrt pair is production output that it must leave
    // alone (#2760), so a cached replay restores the test manifest and the
    // production pair keeps the bytes the build wrote.
    write(join(core, 'test-manifest.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
      assert.ok(existsSync('dist/ready'), 'test manifest writer ran before production completed');
      mkdirSync('src/manifest', { recursive: true });
      writeFileSync('src/manifest/test-manifest.json', 'test');
    `);
    write(join(core, 'check.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      assert.equal(readFileSync('.smrt/manifest.json', 'utf8'), 'production');
      assert.equal(readFileSync('.smrt/smrt-knowledge.json', 'utf8'), 'production');
      assert.equal(readFileSync('src/manifest/test-manifest.json', 'utf8'), 'test');
    `);
    execFileSync('pnpm', ['install'], { cwd: root, stdio: 'pipe', timeout: 30000 });
    // Own the cache and never read the remote one: the fixture is byte-identical
    // on every run, so in CI a remote hit would replay every task without
    // executing build.mjs, and `.smrt/` is not a declared output to restore.
    const cacheArguments = [`--cache-dir=${join(root, '.turbo/cache')}`, '--cache=local:rw'];
    const run = (task) => execFileSync(join(repository, 'node_modules/.bin/turbo'), ['run', task, ...cacheArguments], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
    const plan = JSON.parse(execFileSync(join(repository, 'node_modules/.bin/turbo'), ['run', 'generate:test', '--filter=@happyvertical/smrt-core', '--dry=json'], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    }));
    const generation = plan.tasks.find(({ taskId }) => taskId === '@happyvertical/smrt-core#generate:test');
    assert.ok(generation.dependencies.includes('@happyvertical/smrt-core#build'));
    assert.ok(generation.dependencies.includes('@happyvertical/smrt-approvals#build'));
    assert.ok(generation.dependencies.includes('@happyvertical/smrt-web#build'));
    run('typecheck');
    run('build');
    const replay = run('typecheck');
    assert.match(replay, /cache hit/);
    run('build');
    execFileSync(process.execPath, ['check.mjs'], { cwd: core });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
