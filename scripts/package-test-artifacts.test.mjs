import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { assertNoPackedTests, isTestArtifact } from './package-test-artifacts.mjs';

const prune = resolve('scripts/prune-svelte-package-artifacts.js');

test('pruning removes compiled tests and their declarations/maps but preserves library output', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-package-tests-'));
  try {
    const removed = ['nested/panel.test.js', 'nested/panel.test.d.ts', 'nested/panel.test.d.ts.map',
      'nested/panel.spec.js.map', '__tests__/fixture.svelte', 'test-stubs/mock.js'];
    const kept = ['Panel.svelte', 'Panel.svelte.d.ts', 'index.js.map', 'test-support.js'];
    for (const file of [...removed, ...kept]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), '');
    }
    for (let run = 0; run < 2; run++) {
      const result = spawnSync(process.execPath, [prune, root], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      for (const file of removed) assert.equal(existsSync(join(root, file)), false, file);
      for (const file of kept) assert.equal(existsSync(join(root, file)), true, file);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('publish gate checks actual tar paths, including declarations and files outside dist', () => {
  const root = mkdtempSync(join(tmpdir(), 'smrt-packed-tests-'));
  try {
    const content = join(root, 'content');
    mkdirSync(join(content, 'package', 'dist'), { recursive: true });
    writeFileSync(join(content, 'package', 'dist', 'index.js'), 'export {};');
    const tarball = join(root, 'package.tgz');
    const pack = () => {
      const result = spawnSync('tar', ['-czf', tarball, '-C', content, 'package'], { encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    };
    pack();
    assert.doesNotThrow(() => assertNoPackedTests(tarball));
    writeFileSync(join(content, 'package', 'outside.spec.d.ts.map'), '{}');
    pack();
    assert.throws(() => assertNoPackedTests(tarball), /outside.spec.d.ts.map/);
    writeFileSync(tarball, 'not a tarball');
    assert.throws(() => assertNoPackedTests(tarball), /Cannot inspect/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('artifact detection supports normalized paths without removing runtime helpers', () => {
  for (const file of ['dist/x.test.js', 'dist/x.spec.d.ts', 'dist/x.test.js.map', 'dist/__tests__/fixture.js', 'dist/test-stubs/x.js']) {
    assert.equal(isTestArtifact(file), true, file);
    assert.equal(isTestArtifact(file.replaceAll('/', String.fromCharCode(92))), true, file);
  }
  for (const file of ['dist/test-support.js', 'dist/testing.js', 'dist/Panel.svelte.d.ts', 'dist/specification.js']) {
    assert.equal(isTestArtifact(file), false, file);
  }
});

test('every Svelte library build prunes test artifacts', () => {
  for (const entry of readdirSync('packages', { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifest = join('packages', entry.name, 'package.json');
    if (!existsSync(manifest)) continue;
    const { scripts = {} } = JSON.parse(readFileSync(manifest, 'utf8'));
    for (const [name, command] of Object.entries(scripts)) {
      if (!name.startsWith('build') || !command.includes('svelte-package')) continue;
      assert.match(command, /svelte-package.*&& node \.\.\/\.\.\/scripts\/prune-svelte-package-artifacts\.js dist(?:\/svelte)?$/, `${entry.name}:${name}`);
    }
  }
});
