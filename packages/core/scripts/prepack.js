#!/usr/bin/env node

/**
 * Core prepack entrypoint.
 *
 * In CI the release workflow already performs a clean repo-wide build before
 * `changeset publish`. Rebuilding core inside `prepack` empties `dist/` again,
 * which can make sibling package publishes observe a half-missing shared core
 * build. Reuse the existing artifacts in CI and verify them instead.
 */

import { execFileSync } from 'node:child_process';

function run(script) {
  execFileSync('npm', ['run', script], {
    stdio: 'inherit',
    env: process.env,
  });
}

const runningInCi = process.env.CI === 'true' || process.env.CI === '1';

if (runningInCi) {
  console.log(
    '[smrt-core prepack] Reusing existing CI build artifacts to avoid deleting shared dist/ during publish.',
  );
  run('verify:exports');
  run('verify:consumer-plugin');
} else {
  run('build:fresh');
}
