import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MCP_WIDGET_BYTES_BUDGET,
  PACKED_BYTES_BUDGET,
} from './planner-size-budgets.mjs';
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

function fixture({
  files = entries,
  catalogVersion = '1.2.3',
  registry,
  core = "import { readFileSync } from 'node:fs';\nexport const recipes = [];",
  widget = '<script id="smrt-planner-entry"></script>',
  packedBytes = 1000,
} = {}) {
  const json = {
    'package/package.json': { version: '1.2.3' },
    'package/dist/catalog/catalog.json': {
      registry: registry ?? 'https://npm.happyvertical.com',
      packages: [{ packageName: '@happyvertical/smrt-tags', version: catalogVersion }],
    },
  };
  const text = {
    'package/dist/smrt-version.js': "export const SMRT_VERSION = '1.2.3';",
    'package/app/mcp.html': widget,
    'package/dist/core/index.js': core,
  };
  return {
    entries: files,
    packedBytes,
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

test('rejects a ./core entry that imports installed packages (#4238)', () => {
  assert.deepEqual(
    plannerTarballProblems(
      fixture({
        core: [
          "import { a } from 'node:path';",
          "export { b } from '@happyvertical/smrt-core/cookbook/engine';",
          "const c = await import('@happyvertical/smrt-ui/currency');",
        ].join('\n'),
      }),
    ),
    [
      'dist/core/index.js is not self-contained (imports @happyvertical/smrt-core/cookbook/engine, @happyvertical/smrt-ui/currency)',
    ],
  );
});

test('rejects a planner that grew past its size budgets (#5707)', () => {
  const widget = `<script id="smrt-planner-entry">"data:application/wasm;base64,"</script>${' '.repeat(MCP_WIDGET_BYTES_BUDGET)}`;
  const wasm = 'package/app/_app/immutable/assets/ort.wasm';
  const problems = plannerTarballProblems(
    fixture({
      widget,
      files: [...entries, wasm],
      packedBytes: PACKED_BYTES_BUDGET + 1,
    }),
  );
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^app\/mcp\.html is \d+ bytes, over/);
  assert.equal(problems[1], 'app/mcp.html inlines a WebAssembly binary');
  assert.match(problems[2], /^tarball is \d+ bytes, over/);
  assert.equal(problems[3], `${wasm}: the planner ships no WebAssembly`);
});
