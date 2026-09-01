import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('isolated docs installs allow required dependency build scripts', () => {
  const workspace = readFileSync(
    new URL('../docs/pnpm-workspace.yaml', import.meta.url),
    'utf8',
  );

  // Asserts the allowBuilds contract this test is named for, not the whole
  // file: the documentation site keeps its own lockfile, so security overrides
  // land here too and an exact-file match breaks on every unrelated one.
  assert.match(workspace, /^allowBuilds:\n {2}core-js: true\n {2}sharp: true\n/);
});
