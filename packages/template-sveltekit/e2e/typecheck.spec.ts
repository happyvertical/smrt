/**
 * The generated app typechecks as a consumer would run it.
 *
 * `tsc` over the package fixture never sees the template's `.svelte` files, so
 * type errors that only surface against the published component props (an
 * AppShell `user`, an `enhance` submit handler) slipped through and were first
 * hit downstream in smrt-start (#3860). This runs the copied app's own
 * `svelte-kit sync` and `svelte-check` after `app:setup` has built it, so the
 * virtual modules and manifests exist exactly as in a real project.
 */

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { expect, test } from './fixtures.js';

test('the copied app passes svelte-check', async ({ referenceApp }) => {
  test.setTimeout(240_000);
  const bin = (name: string) => join(referenceApp.appRoot, 'node_modules', '.bin', name);
  const run = (command: string, args: string[]) =>
    spawnSync(command, args, {
      cwd: referenceApp.appRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: '1' },
      timeout: 180_000,
    });

  const sync = run(bin('svelte-kit'), ['sync']);
  expect(sync.status, sync.stderr || sync.stdout).toBe(0);

  const check = run(bin('svelte-check'), [
    '--tsconfig',
    './tsconfig.json',
    '--threshold',
    'error',
    '--output',
    'machine',
  ]);
  const errors = (check.stdout ?? '')
    .split('\n')
    .filter((line) => / ERROR /.test(line));
  expect(errors, errors.join('\n')).toEqual([]);
  expect(check.status, check.stderr).toBe(0);
});
