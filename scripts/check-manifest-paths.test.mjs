import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findAbsoluteManifestPaths, isAbsoluteManifestPath } from './check-manifest-paths.mjs';

const script = fileURLToPath(new URL('./check-manifest-paths.mjs', import.meta.url));

function repoWith(manifests) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-paths-'));
  for (const [name, objects] of Object.entries(manifests)) {
    mkdirSync(join(root, 'packages', name, 'dist'), { recursive: true });
    writeFileSync(join(root, 'packages', name, 'dist', 'manifest.json'), JSON.stringify({ objects }));
  }
  return root;
}

test('accepts package-relative paths', () => {
  const root = repoWith({ a: { 'x:A': { filePath: 'src/A.ts' } }, b: {} });
  try {
    assert.deepEqual(findAbsoluteManifestPaths(root), []);
    assert.equal(spawnSync(process.execPath, [script, root]).status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('fails and names the manifest on an absolute path', () => {
  const root = repoWith({ a: { 'x:A': { filePath: '/Users/me/smrt/packages/a/src/A.ts' } } });
  try {
    const found = findAbsoluteManifestPaths(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].manifest, 'packages/a/dist/manifest.json');
    const run = spawnSync(process.execPath, [script, root], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /packages\/a\/dist\/manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('treats drive, UNC and file: paths as absolute', () => {
  for (const p of ['C:\\x\\A.ts', '\\\\h\\s\\A.ts', 'file:///x/A.ts', '/x/A.ts']) {
    assert.equal(isAbsoluteManifestPath(p), true);
  }
  assert.equal(isAbsoluteManifestPath('src/A.ts'), false);
});
