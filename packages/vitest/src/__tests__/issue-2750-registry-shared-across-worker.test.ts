/**
 * Regression test for #2750.
 *
 * `smrtVitestPlugin()`'s manifest registration runs inside `configResolved()`,
 * a Vite hook that only ever executes in Vitest's main/orchestrator process.
 * Consumers set `pool: 'forks'` (the framework's documented default), so test
 * files run in a separate forked child process with its own module graph —
 * `ObjectRegistry`, a `globalThis` singleton, is therefore NOT shared between
 * the process that registered manifests and the process running the test.
 * `getTestDatabase()` then silently created only `_smrt_*` system tables.
 *
 * The fix passes the plugin's manifest-registration options to every worker
 * process via `SMRT_VITEST_SETUP_OPTIONS_ENV_KEY`; `./setup.ts` (which does
 * run inside the worker, via `setupFiles`) reads it and re-runs
 * `setupSmrtManifests()` in-process.
 *
 * This test proves the fix the same way the issue's own reproducer does: by
 * actually running a real, consumer-shaped Vitest process (plugin + setup
 * file + `pool: 'forks'` + `singleFork: true`) against a fixture package
 * whose model is registered only through the manifest — never imported
 * directly by the spec — and asserting the nested run passes. Reverting the
 * fix reproduces the issue's exact symptoms against this fixture: an empty
 * `ObjectRegistry` in the spec's process and no `widgets` table.
 *
 * @see https://github.com/happyvertical/smrt/issues/2750
 */

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/issue-2750-registry-fixture', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);

function cleanGeneratedArtifacts(): void {
  for (const dir of ['.smrt', 'dist', 'node_modules']) {
    rmSync(join(fixtureRoot, dir), { recursive: true, force: true });
  }
}

describe('issue #2750: ObjectRegistry is shared with the pool: "forks" worker process', () => {
  beforeEach(() => {
    cleanGeneratedArtifacts();
  });

  afterEach(() => {
    cleanGeneratedArtifacts();
  });

  it('a consumer-shaped fixture (smrtVitestPlugin() + setup + pool: forks + singleFork) sees manifest-registered classes in the test worker', () => {
    expect(existsSync(vitestBin)).toBe(true);

    let stdout = '';
    let failed = false;
    // A nested `vitest run` spawn can transiently fail with ENOENT under
    // heavy parallel load (observed sporadically when this file runs
    // alongside the rest of the package's suite) even though
    // `process.execPath` is always valid -- retry a couple of times before
    // treating it as a real failure, the same way `smrtVitestPlugin()`
    // itself retries CI-only spawn/timing flakes (see AGENTS.md's "CI
    // retry" section).
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      failed = false;
      try {
        stdout = execFileSync(process.execPath, [vitestBin, 'run'], {
          cwd: fixtureRoot,
          encoding: 'utf-8',
          env: { ...process.env },
          timeout: 60_000,
        });
        break;
      } catch (error) {
        failed = true;
        stdout =
          (error as { stdout?: string }).stdout ??
          (error instanceof Error ? error.message : String(error));
        const isTransientSpawnFailure =
          (error as { code?: string }).code === 'ENOENT';
        if (!isTransientSpawnFailure || attempt === maxAttempts) {
          break;
        }
      }
    }

    expect(stdout, `nested vitest run failed:\n${stdout}`).toContain(
      'Test Files  1 passed (1)',
    );
    expect(failed, `nested vitest run failed:\n${stdout}`).toBe(false);
  }, 90_000);
});
