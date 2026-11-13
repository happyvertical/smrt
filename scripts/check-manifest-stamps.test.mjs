import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { findStaleStamps } from './check-manifest-stamps.mjs';

// The stamp of a manifest is the sorted list of its object keys, so a test can
// say what each file "describes" without the real hash.
const compute = (manifest) => Object.keys(manifest.objects).sort().join(',');

function repoWith(files) {
  const root = mkdtempSync(join(tmpdir(), 'manifest-stamps-'));
  for (const [path, manifest] of Object.entries(files)) {
    const file = join(root, 'packages', path);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, JSON.stringify(manifest));
  }
  return root;
}

test('accepts a stamp that matches its own objects, and a file with no stamp', () => {
  const root = repoWith({
    'a/dist/manifest.json': { objects: { 'x:A': {}, 'x:B': {} }, schemaFingerprint: 'x:A,x:B' },
    'b/dist/manifest.json': { objects: { 'x:C': {} } },
  });
  try {
    assert.deepEqual(findStaleStamps(root, compute), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('names a manifest filtered after generation that kept the whole app stamp', () => {
  const root = repoWith({
    // The app's merged manifest is right; the published copy kept one object
    // and the app's stamp (what the shell's publish step used to write).
    'shell/.smrt/manifest.json': { objects: { 'x:A': {}, 'y:B': {} }, schemaFingerprint: 'x:A,y:B' },
    'shell/dist/manifest.json': { objects: { 'x:A': {} }, schemaFingerprint: 'x:A,y:B' },
  });
  try {
    const stale = findStaleStamps(root, compute);
    assert.equal(stale.length, 1);
    assert.equal(stale[0].manifest, 'packages/shell/dist/manifest.json');
    assert.equal(stale[0].computed, 'x:A');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
