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
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/issue-2750-registry-fixture', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const jsonReportPath = join(fixtureRoot, 'vitest-report.json');

interface VitestJsonReport {
  numTotalTestSuites: number;
  numPassedTestSuites: number;
  numTotalTests: number;
  numPassedTests: number;
  success: boolean;
}

// The nested `vitest run` spawns its own worker pool; a slow/loaded CI
// runner needs materially more wall-clock time than this repo's usual
// per-test budget. Keep the outer `it()` timeout comfortably above the
// spawn's own timeout so a genuine spawn timeout (not the outer `it()`
// timer) is always what fails the test and produces the captured
// stdout/stderr, rather than vitest's own timeout racing it and hiding
// the child process's output.
const SPAWN_TIMEOUT_MS = 120_000;
const TEST_TIMEOUT_MS = SPAWN_TIMEOUT_MS + 30_000;

function cleanGeneratedArtifacts(): void {
  for (const dir of ['.smrt', 'dist', 'node_modules']) {
    rmSync(join(fixtureRoot, dir), { recursive: true, force: true });
  }
  rmSync(jsonReportPath, { force: true });
}

describe('issue #2750: ObjectRegistry is shared with the pool: "forks" worker process', () => {
  beforeEach(() => {
    cleanGeneratedArtifacts();
  });

  afterEach(() => {
    cleanGeneratedArtifacts();
  });

  it(
    'a consumer-shaped fixture (smrtVitestPlugin() + setup + pool: forks + singleFork) sees manifest-registered classes in the test worker',
    () => {
      expect(existsSync(vitestBin)).toBe(true);

      let stdout = '';
      let stderr = '';
      let failed = false;

      // A nested `vitest run` spawn can transiently fail with ENOENT under
      // heavy parallel load (observed sporadically when this file runs
      // alongside the rest of the package's suite) even though
      // `process.execPath` is always valid. Retry only in CI and only for
      // that specific transient spawn failure, matching this repo's
      // documented CI retry policy (packages/vitest/AGENTS.md "CI retry":
      // retry only under `process.env.CI`, 0 locally, "so flakes surface
      // during development" -- a local retry here would silently mask a
      // genuine ENOENT regression instead of surfacing it). This is
      // independent of, and in addition to, this package's own
      // `vitest.config.ts` `retry` policy on the outer test itself, which
      // does not distinguish transient spawn errors from a real failure of
      // the nested run.
      const maxAttempts = process.env.CI ? 3 : 1;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        failed = false;
        try {
          stdout = execFileSync(
            process.execPath,
            [
              vitestBin,
              'run',
              '--reporter=json',
              `--outputFile=${jsonReportPath}`,
            ],
            {
              cwd: fixtureRoot,
              encoding: 'utf-8',
              env: { ...process.env },
              timeout: SPAWN_TIMEOUT_MS,
              killSignal: 'SIGKILL',
            },
          );
          break;
        } catch (error) {
          failed = true;
          const err = error as {
            stdout?: string;
            stderr?: string;
            signal?: string | null;
            code?: string;
          };
          stdout =
            err.stdout ??
            (error instanceof Error ? error.message : String(error));
          stderr = err.stderr ?? '';
          const isTransientSpawnFailure = err.code === 'ENOENT';
          if (!isTransientSpawnFailure || attempt === maxAttempts) {
            break;
          }
          console.warn(
            `[issue-2750 fixture] retrying nested vitest spawn after ENOENT (attempt ${attempt}/${maxAttempts})`,
          );
        }
      }

      // Fail fast with the captured child output rather than letting a hang
      // surface only as an opaque outer-test timeout with no diagnostics.
      expect(
        failed,
        `nested vitest run failed:\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(false);
      expect(
        existsSync(jsonReportPath),
        `nested vitest run produced no JSON report; stdout:\n${stdout}\nstderr:\n${stderr}`,
      ).toBe(true);

      // Assert on the machine-readable report rather than matching the
      // human-readable reporter's formatted summary string, which is coupled
      // to Vitest's own reporter output and would break on an unrelated
      // formatting change on upgrade (vitest is pinned as a devDependency but
      // the package's peerDependency range is `>=2.1.9`).
      const report = JSON.parse(
        readFileSync(jsonReportPath, 'utf-8'),
      ) as VitestJsonReport;
      expect(report.success, `nested vitest run report:\n${stdout}`).toBe(true);
      expect(report.numTotalTestSuites).toBeGreaterThan(0);
      expect(report.numPassedTestSuites).toBe(report.numTotalTestSuites);
      expect(report.numTotalTests).toBeGreaterThan(0);
      expect(report.numPassedTests).toBe(report.numTotalTests);
    },
    TEST_TIMEOUT_MS,
  );
});
