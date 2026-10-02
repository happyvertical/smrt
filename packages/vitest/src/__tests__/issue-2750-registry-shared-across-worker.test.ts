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
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDomainKnowledgeManifest } from '@happyvertical/smrt-core/knowledge';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const fixtureRoot = fileURLToPath(
  new URL('./fixtures/issue-2750-registry-fixture', import.meta.url),
);
const vitestBin = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const jsonReportPath = join(fixtureRoot, 'vitest-report.json');
const knowledgeConfigPath = join(fixtureRoot, 'smrt.config.json');

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
    rmSync(knowledgeConfigPath, { force: true });
  });

  it(
    'refreshes canonical paired knowledge after the consumer plugin generates a test manifest (#3205)',
    () => {
      const smrtDir = join(fixtureRoot, '.smrt');
      const manifestPath = join(smrtDir, 'manifest.json');
      const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
      const agentSurface: NonNullable<
        Parameters<typeof buildDomainKnowledgeManifest>[0]['agentSurface']
      > = {
        intents: [
          {
            id: 'widgets.next_page',
            description: 'Advance the widget table by one page',
            capability: { effect: 'read', idempotent: false, openWorld: false },
            target: { registry: 'dataSurface', controlId: 'next-page' },
            hasInputSchema: false,
            planes: ['browser'],
            sourceFile: 'src/registry-probe.spec.ts',
          },
        ],
        playbooks: [],
        diagnostics: [],
      };
      const staleAgentSurface = {
        ...agentSurface,
        intents: [
          {
            ...agentSurface.intents[0],
            description: 'Stale declaration that must not be rehashed',
          },
        ],
      };
      const staleManifestHash = 'sha256:stale-production-manifest';
      writeFileSync(
        knowledgeConfigPath,
        JSON.stringify({ knowledge: { tags: ['file-fallback'] } }),
      );
      // Seed the production pair that #3205 left stale after the plugin
      // rewrote the canonical test manifest.
      rmSync(smrtDir, { recursive: true, force: true });
      mkdirSync(smrtDir, { recursive: true });
      writeFileSync(manifestPath, JSON.stringify({ objects: {} }), {
        encoding: 'utf8',
        flag: 'w',
      });
      writeFileSync(
        knowledgePath,
        JSON.stringify({
          sourceHashes: {
            manifest: staleManifestHash,
            'agentSurface:src/registry-probe.spec.ts': 'old-agent-source-hash',
          },
          agentSurface: staleAgentSurface,
        }),
      );

      execFileSync(
        process.execPath,
        [vitestBin, 'run', '--reporter=json', `--outputFile=${jsonReportPath}`],
        {
          cwd: fixtureRoot,
          encoding: 'utf-8',
          env: { ...process.env },
          timeout: SPAWN_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );

      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
      const knowledge = JSON.parse(readFileSync(knowledgePath, 'utf8'));
      const expected = buildDomainKnowledgeManifest({
        manifest,
        rootDir: fixtureRoot,
        manifestPath,
        config: { enabled: true, tags: ['producer-inline'] },
        agentSurface,
      });
      expect(Object.keys(manifest.objects)).not.toHaveLength(0);
      expect(knowledge.sourceHashes.manifest).toBe(
        expected.sourceHashes.manifest,
      );
      expect(knowledge.sourceHashes.manifest).not.toBe(staleManifestHash);
      expect(knowledge.agentSurface).toEqual(agentSurface);
      expect(knowledge.agentSurface).not.toEqual(staleAgentSurface);
      expect(knowledge.tags).toEqual(['producer-inline']);
    },
    TEST_TIMEOUT_MS,
  );

  it(
    'removes stale knowledge when the producer disables it while keeping test registration',
    () => {
      const smrtDir = join(fixtureRoot, '.smrt');
      const knowledgePath = join(smrtDir, 'smrt-knowledge.json');
      mkdirSync(smrtDir, { recursive: true });
      writeFileSync(knowledgePath, JSON.stringify({ stale: true }));
      execFileSync(
        process.execPath,
        [vitestBin, 'run', '--reporter=json', `--outputFile=${jsonReportPath}`],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: { ...process.env, SMRT_FIXTURE_KNOWLEDGE_ENABLED: 'false' },
          timeout: SPAWN_TIMEOUT_MS,
          killSignal: 'SIGKILL',
        },
      );
      expect(existsSync(knowledgePath)).toBe(false);
      const manifest = JSON.parse(
        readFileSync(join(smrtDir, 'manifest.json'), 'utf8'),
      );
      expect(Object.keys(manifest.objects)).not.toHaveLength(0);
      expect(JSON.parse(readFileSync(jsonReportPath, 'utf8')).success).toBe(
        true,
      );
    },
    TEST_TIMEOUT_MS,
  );

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
