/**
 * Regression coverage for #2954: consumer tests resolve sibling workspace
 * packages through source, never through a stale or missing `dist`.
 *
 * - Every exact JavaScript subpath any workspace package exports from
 *   `dist/` is aliased to the source file it is built from. The aliases are
 *   derived from each package's own `exports` map, so a newly exported
 *   subpath is covered without editing the plugin; this test fails if one
 *   cannot be derived.
 * - A module loaded from a sibling's `dist/` fails the consumer suite (a
 *   real nested Vitest run proves the guard fires in a forked worker).
 *
 * @see https://github.com/happyvertical/smrt/issues/2954
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { Plugin } from 'vitest/config';
import {
  createWorkspaceDistGuard,
  getWorkspaceExportSources,
  getWorkspaceViteAliases,
  smrtVitestPlugin,
} from '../index.js';

const repoRoot = resolve(__dirname, '../../../..');
const packagesDir = join(repoRoot, 'packages');

function workspacePackages(): Array<{ name: string; root: string }> {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name))
    .filter((root) => existsSync(join(root, 'package.json')))
    .map((root) => ({
      name: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        .name as string,
      root,
    }));
}

describe('issue #2954: workspace subpaths resolve to source', () => {
  it('aliases every dist-built export of every workspace package to an existing source file', () => {
    const aliases = getWorkspaceViteAliases(repoRoot);
    const unresolved: string[] = [];
    let checked = 0;
    for (const { name, root } of workspacePackages()) {
      for (const { subpath, target } of getWorkspaceExportSources(root)) {
        // A target outside dist/ is itself source (e.g. template entries).
        if (!target.startsWith('./dist/')) continue;
        checked++;
        const specifier = subpath === '.' ? name : `${name}${subpath.slice(1)}`;
        const alias = aliases.find((entry) => entry.find.test(specifier));
        if (
          !alias ||
          alias.replacement.includes('/dist/') ||
          !existsSync(alias.replacement)
        ) {
          unresolved.push(`${specifier} -> ${target}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(300);
    expect(unresolved).toEqual([]);
  });

  it('derives aliases from the exports map, including svelte-package src/lib layouts', () => {
    const aliases = getWorkspaceViteAliases(repoRoot);
    const replacementFor = (specifier: string) =>
      aliases.find((entry) => entry.find.test(specifier))?.replacement;
    // Previously unaliased: resolved to dist/ai.js while the package root
    // resolved to source (the issue's concrete instance).
    expect(replacementFor('@happyvertical/smrt-web/ai')).toMatch(
      /packages\/smrt-web\/src\/ai\.ts$/,
    );
    expect(replacementFor('@happyvertical/smrt-planner/core')).toMatch(
      /packages\/planner\/src\/lib\/core\/index\.ts$/,
    );
  });

  it('flags a sibling dist module, but not the package under test or deliberate published entries', () => {
    const vitestRoot = join(packagesDir, 'vitest');
    const coreDist = join(
      realpathSync(join(packagesDir, 'core')),
      'dist/index.js',
    );
    const ownDist = join(realpathSync(vitestRoot), 'dist/index.js');
    const guard = createWorkspaceDistGuard(vitestRoot);
    expect(guard(coreDist)).toMatch(
      /built output of workspace package @happyvertical\/smrt-core/,
    );
    expect(guard(`${coreDist}?v=1`)).not.toBeNull();
    expect(
      guard(join(realpathSync(join(packagesDir, 'core')), 'src/index.ts')),
    ).toBeNull();
    expect(guard(ownDist)).toBeNull();
    expect(
      createWorkspaceDistGuard(
        vitestRoot,
        new Set(['@happyvertical/smrt-core']),
      )(coreDist),
    ).toBeNull();
  });

  it('maps unaliased workspace subpaths to source and fails one that can only resolve to dist', async () => {
    const plugin = smrtVitestPlugin({
      root: join(packagesDir, 'vitest'),
      generateManifest: false,
    });
    (plugin.config as (config: unknown) => unknown)({});
    const resolveId = plugin.resolveId as unknown as (
      source: string,
      importer: string | undefined,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    // A pattern export subpath with a source file resolves to it.
    expect(
      await resolveId(
        '@happyvertical/smrt-ui/utils/import-optional.js',
        undefined,
        {},
      ),
    ).toMatch(/packages\/smrt-ui\/src\/utils\/import-optional\.ts$/);
    // One whose exports-map target is built JavaScript with no source fails,
    // whether or not that dist file exists (stale or missing).
    await expect(
      resolveId(
        '@happyvertical/smrt-ui/utils/no-such-source.js',
        undefined,
        {},
      ),
    ).rejects.toThrow(
      /built output of workspace package @happyvertical\/smrt-ui/,
    );
    // Non-workspace specifiers are never touched.
    expect(await resolveId('some-third-party', undefined, {})).toBeNull();
  });

  it('leaves packages a consumer resolves to published entries on purpose alone', async () => {
    const plugin = smrtVitestPlugin({
      root: join(packagesDir, 'vitest'),
      generateManifest: false,
      aliasFilter: ({ find }) => !find.startsWith('@happyvertical/smrt-ui'),
    });
    (plugin.config as (config: unknown) => unknown)({});
    const resolveId = plugin.resolveId as unknown as (
      source: string,
      importer: string | undefined,
      options: Record<string, unknown>,
    ) => Promise<unknown>;
    expect(
      await resolveId(
        '@happyvertical/smrt-ui/utils/no-such-source.js',
        undefined,
        {},
      ),
    ).toBeNull();
  });

  it('maps workspace setupFiles specifiers to source, which Vitest resolves outside resolve.alias', () => {
    const plugin = smrtVitestPlugin({
      root: join(packagesDir, 'users'),
      generateManifest: false,
    }) as Plugin;
    const config = (
      plugin.config as (config: unknown) => { test: { setupFiles: string[] } }
    )({ test: { setupFiles: ['@happyvertical/smrt-vitest/svelte-setup'] } });
    expect(config.test.setupFiles[0]).toMatch(
      /packages\/vitest\/src\/svelte-setup\.ts$/,
    );
  });

  it('resolves sibling specifiers to the source modules in a forked consumer worker', () => {
    const fixtureRoot = fileURLToPath(
      new URL('./fixtures/issue-2954-dist-guard-fixture', import.meta.url),
    );
    const vitestBin = fileURLToPath(
      new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
    );
    const reportPath = join(fixtureRoot, 'vitest-report.json');
    rmSync(join(fixtureRoot, '.smrt'), { recursive: true, force: true });
    rmSync(reportPath, { force: true });
    try {
      execFileSync(
        process.execPath,
        [vitestBin, 'run', '--reporter=json', `--outputFile=${reportPath}`],
        {
          cwd: fixtureRoot,
          encoding: 'utf8',
          env: { ...process.env },
          timeout: 120_000,
          killSignal: 'SIGKILL',
        },
      );
    } catch (error) {
      const err = error as { stdout?: string; stderr?: string };
      throw new Error(
        `nested vitest run failed:\nstdout:\n${err.stdout}\nstderr:\n${err.stderr}`,
      );
    } finally {
      rmSync(join(fixtureRoot, '.smrt'), { recursive: true, force: true });
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    rmSync(reportPath, { force: true });
    expect(report.success).toBe(true);
    expect(report.numPassedTests).toBe(report.numTotalTests);
    expect(report.numTotalTests).toBeGreaterThan(0);
  }, 150_000);
});
