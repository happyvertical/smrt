import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { packageManager } = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'));

test('core test generation waits for its production pair writer, including cached runs', () => {
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
    write(join(core, 'build.mjs'), `
      import { mkdirSync, writeFileSync } from 'node:fs';
      mkdirSync('.smrt', { recursive: true });
      writeFileSync('.smrt/manifest.json', 'production');
      await new Promise(resolve => setTimeout(resolve, 300));
      writeFileSync('.smrt/smrt-knowledge.json', 'production');
      mkdirSync('dist', { recursive: true });
      writeFileSync('dist/ready', 'production complete');
    `);
    write(join(core, 'test-manifest.mjs'), `
      import assert from 'node:assert/strict';
      import { existsSync, writeFileSync } from 'node:fs';
      assert.ok(existsSync('dist/ready'), 'test pair writer ran before production completed');
      writeFileSync('.smrt/manifest.json', 'test');
      writeFileSync('.smrt/smrt-knowledge.json', 'test');
    `);
    write(join(core, 'check.mjs'), `
      import assert from 'node:assert/strict';
      import { readFileSync } from 'node:fs';
      assert.equal(readFileSync('.smrt/manifest.json', 'utf8'), 'test');
      assert.equal(readFileSync('.smrt/smrt-knowledge.json', 'utf8'), 'test');
    `);
    execFileSync('pnpm', ['install'], { cwd: root, stdio: 'pipe', timeout: 30000 });
    const run = (task) => execFileSync(join(repository, 'node_modules/.bin/turbo'), ['run', task], {
      cwd: root, encoding: 'utf8', timeout: 30000,
    });
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
