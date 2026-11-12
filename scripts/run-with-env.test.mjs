import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { parseRunWithEnvArgs } from './run-with-env.mjs';

const script = fileURLToPath(new URL('./run-with-env.mjs', import.meta.url));

test('parses assignments and the command after "--"', () => {
  assert.deepEqual(
    parseRunWithEnvArgs([
      'SMRT_PACKAGE_BUILD=1',
      'EMPTY=',
      '--',
      'svelte-package',
      '-i',
      'src/svelte',
      '--tsconfig',
      'tsconfig.svelte.json',
    ]),
    {
      env: { SMRT_PACKAGE_BUILD: '1', EMPTY: '' },
      command: 'svelte-package -i src/svelte --tsconfig tsconfig.svelte.json',
    },
  );
});

test('rejects a missing separator, assignment or command', () => {
  assert.throws(() => parseRunWithEnvArgs(['A=1', 'vite']), /missing "--"/);
  assert.throws(() => parseRunWithEnvArgs(['--', 'vite']), /no NAME=value/);
  assert.throws(() => parseRunWithEnvArgs(['A=1', '--']), /missing command/);
  assert.throws(
    () => parseRunWithEnvArgs(['1A=1', '--', 'vite']),
    /not a NAME=value/,
  );
});

test('rejects arguments the platform shell would re-split or interpret', () => {
  for (const word of ['a b', 'a&&b', 'a|b', '$HOME', '"x"', 'a;b', '%PATH%^']) {
    assert.throws(
      () => parseRunWithEnvArgs(['A=1', '--', 'echo', word]),
      /needs shell quoting/,
      word,
    );
  }
});

test('runs the command with the variables set and forwards its exit code', () => {
  // Relative to cwd so the probe path never needs quoting.
  const run = (...args) =>
    spawnSync(process.execPath, [script, ...args], {
      cwd: fileURLToPath(new URL('.', import.meta.url)),
      encoding: 'utf8',
    });
  const probe = ['--', 'node', 'fixtures/run-with-env-probe.mjs'];

  assert.equal(run('RUN_WITH_ENV_PROBE=yes', ...probe).status, 0);
  assert.equal(run('RUN_WITH_ENV_PROBE=no', ...probe).status, 3);
  assert.equal(run('--', 'node', '-e', 'a b').status, 2, 'usage errors exit 2');
});
