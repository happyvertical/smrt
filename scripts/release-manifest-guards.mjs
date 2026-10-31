#!/usr/bin/env node

/**
 * Release-time manifest guards (issue #2853).
 *
 * `verify-manifest-completeness.mjs` (#1483) and `verify-manifest-exports.mjs`
 * (#2845) used to run only from a package's opt-in `prepack` script, so a
 * publishable package without `prepack` shipped unguarded and every new
 * package started that way. `validate-publish-packages.js` — the only producer
 * of the tarballs `publish.yml` publishes, and the same validator Publish Dry
 * Run runs in the merge queue — now calls `runReleaseManifestGuards` for every
 * package it packs. Coverage therefore follows the publish inventory rather
 * than per-package wiring.
 *
 * Both guards judge what ships, not only the workspace:
 * - completeness re-scans the workspace `src/` in `--release` mode (scanner
 *   required, `@smrt()` objects without a `./manifest` export fail), and the
 *   manifest it verified must be byte-identical to the one in the tarball;
 * - the exports guard runs against the tarball installed into a scratch
 *   consumer `node_modules`, resolving through the packed `package.json`
 *   `exports` map with only the packed package's declared dependencies linked.
 *
 * The verifiers' own exemptions are unchanged: framework-infrastructure
 * packages, collection companions, and bundler-only root barrels (warning).
 * Closed API/CLI/MCP surfaces do not exempt a public model export.
 *
 * Usage: node scripts/release-manifest-guards.mjs --package-dir <dir> --tarball <file.tgz>
 */

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
export const completenessVerifierPath = join(
  scriptsDir,
  'verify-manifest-completeness.mjs',
);
export const exportsVerifierPath = join(
  scriptsDir,
  'verify-manifest-exports.mjs',
);

const MANIFEST_EXPORT_KEYS = ['./manifest', './manifest.json'];

// Every string target of an export entry. The completeness and exports
// verifiers prefer different conditions (`default` vs `import`), so binding
// both verdicts to the tarball means comparing every target either may read.
function exportTargets(entry) {
  if (typeof entry === 'string') return [entry];
  if (!entry || typeof entry !== 'object') return [];
  return [
    ...new Set(
      ['default', 'import', 'require', 'types']
        .map((condition) => entry[condition])
        .filter((target) => typeof target === 'string'),
    ),
  ];
}

/** Relative targets of every manifest export, keyed by `<subpath> <target>`. */
function manifestTargets(packageJson) {
  const targets = {};
  for (const key of MANIFEST_EXPORT_KEYS) {
    for (const target of exportTargets(packageJson.exports?.[key])) {
      targets[`${key} ${target}`] = target;
    }
  }
  return targets;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function output(result) {
  return [result.stdout, result.stderr]
    .filter((value) => typeof value === 'string' && value.trim())
    .join('\n')
    .trim();
}

function runVerifier(path, args, env) {
  const result = spawnSync(process.execPath, [path, ...args], {
    encoding: 'utf8',
    env,
  });
  if (result.error) {
    return { ok: false, log: `could not run ${path}: ${result.error.message}` };
  }
  return { ok: result.status === 0, log: output(result) };
}

/**
 * Extract a tarball into `<consumer>/node_modules/<name>` and link the packed
 * package's declared runtime dependencies from the workspace package's own
 * `node_modules`, so imports resolve the way an installed consumer's would.
 */
function installTarball({ packageDir, tarballPath, consumerDir }) {
  const listed = spawnSync('tar', ['-xzOf', tarballPath, 'package/package.json'], {
    encoding: 'utf8',
  });
  if (listed.error || listed.status !== 0) {
    throw new Error(
      `could not read package/package.json from ${tarballPath}: ${listed.error?.message ?? output(listed)}`,
    );
  }
  const packedPackageJson = JSON.parse(listed.stdout);
  if (!packedPackageJson.name) {
    throw new Error(`packed package.json in ${tarballPath} has no name`);
  }

  const installedDir = join(
    consumerDir,
    'node_modules',
    ...packedPackageJson.name.split('/'),
  );
  mkdirSync(installedDir, { recursive: true });
  const extracted = spawnSync(
    'tar',
    ['-xzf', tarballPath, '--strip-components=1', '-C', installedDir],
    { encoding: 'utf8' },
  );
  if (extracted.error || extracted.status !== 0) {
    throw new Error(
      `could not extract ${tarballPath}: ${extracted.error?.message ?? output(extracted)}`,
    );
  }

  const optional = new Set([
    ...Object.keys(packedPackageJson.optionalDependencies ?? {}),
    ...Object.entries(packedPackageJson.peerDependenciesMeta ?? {})
      .filter(([, meta]) => meta?.optional === true)
      .map(([name]) => name),
  ]);
  const declared = new Set([
    ...Object.keys(packedPackageJson.dependencies ?? {}),
    ...Object.keys(packedPackageJson.optionalDependencies ?? {}),
    ...Object.keys(packedPackageJson.peerDependencies ?? {}),
  ]);
  for (const name of [...declared].sort()) {
    const source = join(packageDir, 'node_modules', ...name.split('/'));
    if (!existsSync(source)) {
      if (optional.has(name)) continue;
      throw new Error(
        `declared dependency ${name} is not installed for ${packedPackageJson.name} (looked in ${source})`,
      );
    }
    const link = join(consumerDir, 'node_modules', ...name.split('/'));
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(realpathSync(source), link, 'dir');
  }

  return { installedDir, packedPackageJson };
}

/**
 * The completeness guard reads the workspace manifest; bind that verdict to the
 * tarball by requiring every packed manifest export to ship the same bytes.
 */
function compareManifests({ packageDir, installedDir, packedPackageJson }) {
  const workspaceTargets = manifestTargets(
    readJson(join(packageDir, 'package.json')),
  );
  const packedTargets = manifestTargets(packedPackageJson);
  const problems = [];
  const keys = [
    ...new Set([...Object.keys(workspaceTargets), ...Object.keys(packedTargets)]),
  ].sort();
  for (const key of keys) {
    const workspaceTarget = workspaceTargets[key];
    const packedTarget = packedTargets[key];
    if (!workspaceTarget && !packedTarget) continue;
    if (!workspaceTarget || !packedTarget) {
      problems.push(
        `"${key}" export is ${packedTarget ? 'only in the packed' : 'only in the workspace'} package.json`,
      );
      continue;
    }
    const workspaceFile = resolve(packageDir, workspaceTarget);
    const packedFile = resolve(installedDir, packedTarget);
    const workspaceExists = existsSync(workspaceFile);
    const packedExists = existsSync(packedFile);
    if (!workspaceExists && !packedExists) continue;
    if (!packedExists) {
      problems.push(`"${key}" target ${packedTarget} is not in the tarball`);
      continue;
    }
    if (
      !workspaceExists ||
      !readFileSync(workspaceFile).equals(readFileSync(packedFile))
    ) {
      problems.push(
        `"${key}" target ${packedTarget} in the tarball differs from the verified workspace ${workspaceTarget}`,
      );
    }
  }
  return problems;
}

/**
 * Run both manifest guards for one packed package. Never throws for a guard
 * verdict; returns `{ ok, failures, logs }` so the caller can fail the release.
 */
export function runReleaseManifestGuards({
  packageDir,
  tarballPath,
  env = process.env,
}) {
  const resolvedPackageDir = resolve(packageDir);
  const resolvedTarball = resolve(tarballPath);
  const failures = [];
  const logs = [];

  const completeness = runVerifier(
    completenessVerifierPath,
    [resolvedPackageDir, '--release'],
    env,
  );
  logs.push(completeness.log);
  if (!completeness.ok) failures.push('manifest completeness (#1483)');

  const consumerDir = mkdtempSync(join(tmpdir(), 'smrt-release-guard-'));
  try {
    const { installedDir, packedPackageJson } = installTarball({
      packageDir: resolvedPackageDir,
      tarballPath: resolvedTarball,
      consumerDir,
    });

    const manifestProblems = compareManifests({
      packageDir: resolvedPackageDir,
      installedDir,
      packedPackageJson,
    });
    if (manifestProblems.length > 0) {
      failures.push('packed manifest identity');
      logs.push(
        ...manifestProblems.map(
          (problem) => `[release-manifest-guards] ❌ ${problem}`,
        ),
      );
    }

    const exportsResult = runVerifier(exportsVerifierPath, [installedDir], env);
    logs.push(exportsResult.log);
    if (!exportsResult.ok) failures.push('manifest exports (#2845)');
  } catch (error) {
    failures.push('packed install');
    logs.push(
      `[release-manifest-guards] ❌ ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(consumerDir, { recursive: true, force: true });
  }

  return { ok: failures.length === 0, failures, logs: logs.filter(Boolean) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  const option = (flag) => {
    const index = args.indexOf(flag);
    const value = index === -1 ? undefined : args[index + 1];
    if (!value || value.startsWith('-')) {
      console.error(
        'Usage: release-manifest-guards.mjs --package-dir <dir> --tarball <file.tgz>',
      );
      process.exit(1);
    }
    return value;
  };
  const result = runReleaseManifestGuards({
    packageDir: option('--package-dir'),
    tarballPath: option('--tarball'),
  });
  for (const log of result.logs) console.log(log);
  if (!result.ok) {
    console.error(
      `❌ Release manifest guards failed: ${result.failures.join(', ')}`,
    );
    process.exit(1);
  }
}
