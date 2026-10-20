import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('discovers and executes an inherited action host from real generated startup without preregistration', () => {
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(
        new URL('./fixtures/collection-action-startup.mjs', import.meta.url),
      ),
    ],
    { encoding: 'utf8', env: process.env, timeout: 60000 },
  );
  expect(result.status, result.stderr + result.stdout).toBe(0);
  expect(result.stdout).toContain('RESULT4171=');
}, 65000);
