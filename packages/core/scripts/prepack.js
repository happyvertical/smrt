#!/usr/bin/env node

/**
 * Core prepack entrypoint.
 *
 * In CI the release workflow already performs a clean repo-wide build before
 * `changeset publish`. Rebuilding core inside `prepack` empties `dist/` again,
 * which can make sibling package publishes observe a half-missing shared core
 * build. Reuse the existing artifacts in CI when they are present, but still
 * recover by rebuilding if a CI job reaches `prepack` before core has been
 * built.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

function run(script) {
  execFileSync('npm', ['run', script], {
    stdio: 'inherit',
    env: process.env,
  });
}

function hasReusableBuildArtifacts() {
  return [
    'dist/index.js',
    'dist/vite-plugin.js',
    'dist/scanner.js',
    'dist/consumer-plugin.js',
  ].every((relativePath) => existsSync(resolve(relativePath)));
}

const runningInCi = process.env.CI === 'true' || process.env.CI === '1';

if (runningInCi && hasReusableBuildArtifacts()) {
  console.log(
    '[smrt-core prepack] Reusing existing CI build artifacts to avoid deleting shared dist/ during publish.',
  );
  run('verify:exports');
  run('verify:consumer-plugin');
} else {
  if (runningInCi) {
    console.log(
      '[smrt-core prepack] CI build artifacts are incomplete; running build:fresh so packaging can recover.',
    );
  }
  run('build:fresh');
}
