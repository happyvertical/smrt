import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { checkDistSvelte, unresolvedImports } from './check-svelte-dist-imports.mjs';

function dist(files) {
  const root = mkdtempSync(join(tmpdir(), 'svelte-dist-'));
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

test('a component importing a module that dist does not contain is reported', () => {
  const root = dist({
    'svelte/components/Card.svelte': "import { plan } from '../../publish-policy.js';\n",
    'svelte/i18n.js': 'export const M = {};\n',
  });
  try {
    const problems = checkDistSvelte(join(root, 'svelte'));
    assert.deepEqual(problems.map((p) => p.specifier), ['../../publish-policy.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('imports that resolve, bare packages and type-only files pass', () => {
  const root = dist({
    'publish-policy.js': 'export const plan = 1;\n',
    'svelte/components/Card.svelte':
      "import { plan } from '../../publish-policy.js';\nimport { M } from '../i18n.js';\nimport { Button } from '@happyvertical/smrt-ui/ui';\n",
    'svelte/i18n.js': 'export const M = {};\n',
  });
  try {
    assert.deepEqual(checkDistSvelte(join(root, 'svelte')), []);
    assert.deepEqual(unresolvedImports(join(root, 'svelte/i18n.js'), "export * from './nope.js';"), ['./nope.js']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
