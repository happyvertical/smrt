import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('isolated docs installs allow required dependency build scripts', () => {
  assert.equal(
    readFileSync(
      new URL('../docs/pnpm-workspace.yaml', import.meta.url),
      'utf8',
    ),
    'allowBuilds:\n  core-js: true\n  sharp: true\n',
  );
});
