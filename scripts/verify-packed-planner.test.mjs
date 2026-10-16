import assert from 'node:assert/strict';
import test from 'node:test';
import { plannerTarballProblems } from './verify-packed-planner.mjs';

const entries = [
  'package/package.json',
  'package/AGENTS.md',
  'package/README.md',
  'package/app/index.html',
  'package/app/404.html',
  'package/app/mcp.html',
  'package/dist/index.js',
  'package/dist/core/index.js',
  'package/dist/catalog/catalog.json',
  'package/dist/smrt-version.js',
];

function fixture({ files = entries, catalogVersion = '1.2.3', registry } = {}) {
  const json = {
    'package/package.json': { version: '1.2.3' },
    'package/dist/catalog/catalog.json': {
      registry: registry ?? 'https://npm.happyvertical.com',
      packages: [{ packageName: '@happyvertical/smrt-tags', version: catalogVersion }],
    },
  };
  const text = {
    'package/dist/smrt-version.js': "export const SMRT_VERSION = '1.2.3';",
    'package/app/mcp.html': '<script id="smrt-planner-entry"></script>',
  };
  return {
    entries: files,
    readJson: (entry) => json[entry],
    readText: (entry) => text[entry],
  };
}

test('accepts a planner packed from this release', () => {
  assert.deepEqual(plannerTarballProblems(fixture()), []);
});

test('rejects a catalog generated from another release', () => {
  assert.deepEqual(plannerTarballProblems(fixture({ catalogVersion: '1.2.2' })), [
    'catalog @happyvertical/smrt-tags@1.2.2 is not this release (1.2.3)',
  ]);
});

test('rejects a catalog that records a checkout path', () => {
  assert.match(
    plannerTarballProblems(fixture({ registry: 'file:///home/runner/smrt' }))[0],
    /not a release registry/,
  );
});

test('rejects a tarball without the app or widget', () => {
  const files = entries.filter((entry) => !entry.startsWith('package/app/'));
  assert.deepEqual(plannerTarballProblems(fixture({ files })), [
    'missing package/app/index.html',
    'missing package/app/404.html',
    'missing package/app/mcp.html',
  ]);
});
