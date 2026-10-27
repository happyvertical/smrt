import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// `fast-glob` -> `micromatch` -> `braces` carries GHSA-vfj7-8cjw-p6xm with no
// patched release (#4206). Packages glob with `tinyglobby` (fdir + picomatch).
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FIELDS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
];

test('no workspace package.json declares fast-glob', () => {
  const offenders = [];
  const manifests = [
    join(root, 'package.json'),
    ...readdirSync(join(root, 'packages'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, 'packages', entry.name, 'package.json')),
  ];
  for (const file of manifests) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    for (const field of FIELDS) {
      if (manifest[field] && 'fast-glob' in manifest[field]) {
        offenders.push(`${file} (${field})`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});
