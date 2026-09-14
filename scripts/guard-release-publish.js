#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

function fail(message) {
  throw new Error(message);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readEnv(name) {
  return process.env[name];
}

function requireCleanRefName(name, label) {
  if (!/^[A-Za-z0-9._/-]+$/.test(name)) {
    fail(`${label} contains unsupported characters: ${JSON.stringify(name)}`);
  }
}

export function listPublishablePackages(repoRoot = process.cwd()) {
  const packagesDir = resolve(repoRoot, 'packages');
  const changesetConfigPath = resolve(repoRoot, '.changeset/config.json');

  if (!existsSync(packagesDir)) {
    fail(`Packages directory not found: ${packagesDir}`);
  }

  if (!existsSync(changesetConfigPath)) {
    fail(`Changeset config not found: ${changesetConfigPath}`);
  }

  const changesetConfig = readJson(changesetConfigPath);
  const releasePackageNames = new Set(
    (changesetConfig.fixed ?? []).flatMap((group) =>
      Array.isArray(group) ? group : [],
    ),
  );
  const privateWorkspacePackageNames = new Set();

  const publishablePackages = readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = join(packagesDir, entry.name);
      const packageJsonPath = join(packageDir, 'package.json');

      if (!existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = readJson(packageJsonPath);
      const packageName = packageJson.name ?? entry.name;
      const isReleasePackage = releasePackageNames.has(packageName);
      const isExplicitlyPublishable = Boolean(packageJson.publishConfig);

      if (packageJson.private === true) {
        privateWorkspacePackageNames.add(packageName);
        return null;
      }

      if (!isReleasePackage && !isExplicitlyPublishable) {
        return null;
      }

      return {
        dir: packageDir,
        manifestPath: packageJsonPath,
        name: packageName,
        version: packageJson.version,
      };
    })
    .filter(Boolean)
    .sort((left, right) => left.name.localeCompare(right.name));

  const discoveredPackageNames = new Set(
    publishablePackages.map((pkg) => pkg.name),
  );
  const missingReleasePackages = [...releasePackageNames].filter(
    (packageName) =>
      !discoveredPackageNames.has(packageName) &&
      !privateWorkspacePackageNames.has(packageName),
  );

  if (missingReleasePackages.length > 0) {
    fail(
      `Release packages declared in .changeset/config.json were not found in the workspace:\n${missingReleasePackages
        .map((packageName) => `- ${packageName}`)
        .join('\n')}`,
    );
  }

  return publishablePackages;
}

export function listVersionedManifests(repoRoot, publishablePackages) {
  const rootPackageJsonPath = resolve(repoRoot, 'package.json');
  const manifests = [];

  if (existsSync(rootPackageJsonPath)) {
    const rootPackageJson = readJson(rootPackageJsonPath);
    manifests.push({
      manifestPath: rootPackageJsonPath,
      name: rootPackageJson.name ?? 'package.json',
      version: rootPackageJson.version,
    });
  }

  manifests.push(...publishablePackages);
  return manifests;
}

export function findMajorVersionOffenders(manifests) {
  return manifests.filter((manifest) => {
    const major = Number.parseInt(String(manifest.version).split('.')[0], 10);
    return Number.isInteger(major) && major >= 1;
  });
}

export function assertHeadMatchesRemote({
  baseBranch = 'main',
  repoRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  requireCleanRefName(baseBranch, 'Base branch');

  const fetchResult = spawn(
    'git',
    [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${baseBranch}:refs/remotes/origin/${baseBranch}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
  );

  if (fetchResult.error) {
    fail(`Failed to fetch origin/${baseBranch}: ${fetchResult.error.message}`);
  }

  if (fetchResult.status !== 0) {
    fail(
      `Failed to fetch origin/${baseBranch}:\n${fetchResult.stderr || fetchResult.stdout}`,
    );
  }

  const headResult = spawn('git', ['rev-parse', 'HEAD'], {
    cwd: repoRoot,
    encoding: 'utf8',
    stdio: 'pipe',
  });
  const remoteResult = spawn(
    'git',
    ['rev-parse', `refs/remotes/origin/${baseBranch}`],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
  );

  if (headResult.error) {
    fail(`Failed to read HEAD: ${headResult.error.message}`);
  }
  if (remoteResult.error) {
    fail(`Failed to read origin/${baseBranch}: ${remoteResult.error.message}`);
  }
  if (headResult.status !== 0) {
    fail(`Failed to read HEAD:\n${headResult.stderr || headResult.stdout}`);
  }
  if (remoteResult.status !== 0) {
    fail(
      `Failed to read origin/${baseBranch}:\n${remoteResult.stderr || remoteResult.stdout}`,
    );
  }

  const head = headResult.stdout.trim();
  const remoteHead = remoteResult.stdout.trim();

  if (head !== remoteHead) {
    fail(
      [
        `Refusing to publish from a stale ${baseBranch} checkout.`,
        `Workflow HEAD: ${head}`,
        `origin/${baseBranch}: ${remoteHead}`,
        'A newer merge has landed; let the newer main run compute and publish the next version.',
      ].join('\n'),
    );
  }
}

export function releaseTagExistsOnOrigin({
  releaseVersion,
  repoRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  if (!releaseVersion) {
    fail('RELEASE_VERSION is required');
  }

  requireCleanRefName(`v${releaseVersion}`, 'Release tag');

  const result = spawn(
    'git',
    [
      'ls-remote',
      '--exit-code',
      '--tags',
      'origin',
      `refs/tags/v${releaseVersion}`,
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
  );

  if (result.error) {
    fail(
      `Failed to check release tag v${releaseVersion}: ${result.error.message}`,
    );
  }

  if (result.status === 0) {
    return true;
  }

  if (result.status !== 2) {
    fail(
      `Failed to check release tag v${releaseVersion}:\n${result.stderr || result.stdout}`,
    );
  }

  return false;
}

export function npmVersionExists({
  packageName,
  version,
  repoRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  const spec = `${packageName}@${version}`;
  const result = spawn(
    'npm',
    [
      'view',
      spec,
      'version',
      '--registry=https://registry.npmjs.org',
      '--prefer-online',
      '--json',
    ],
    { cwd: repoRoot, encoding: 'utf8', stdio: 'pipe' },
  );

  if (result.error) {
    fail(`Failed to check npm package ${spec}: ${result.error.message}`);
  }

  if (result.status === 0) {
    return true;
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (
    output.includes('E404') ||
    output.includes('404 Not Found') ||
    output.includes('is not in this registry')
  ) {
    return false;
  }

  fail(`Failed to check npm package ${spec}:\n${output.trim()}`);
}

export function findPublishedPackageConflicts({
  packages,
  repoRoot = process.cwd(),
  spawn = spawnSync,
} = {}) {
  return packages.filter((pkg) =>
    npmVersionExists({
      packageName: pkg.name,
      repoRoot,
      spawn,
      version: pkg.version,
    }),
  );
}

// Computes what this run still needs to do rather than treating "someone
// already touched this version" as fatal. A prior attempt can die between
// the (irreversible) npm publish and the git commit/tag/push that records
// it — see happyvertical/smrt#2871 — and a retry of the exact same
// RELEASE_VERSION must reconcile against that state instead of refusing to
// run. Genuinely unrelated hazards (a stale checkout, a major-version bump)
// still fail hard below; they are not resumability concerns.
export function assessReleaseState({
  publishablePackages,
  releaseVersion,
  repoRoot = process.cwd(),
  skipGitCheck = false,
  skipNpmCheck = false,
  spawn = spawnSync,
} = {}) {
  const tagAlreadyPushed = skipGitCheck
    ? false
    : releaseTagExistsOnOrigin({ releaseVersion, repoRoot, spawn });

  const alreadyPublished = skipNpmCheck
    ? []
    : findPublishedPackageConflicts({
        packages: publishablePackages,
        repoRoot,
        spawn,
      });
  const alreadyPublishedNames = new Set(
    alreadyPublished.map((pkg) => pkg.name),
  );

  const fullyRecorded =
    tagAlreadyPushed &&
    alreadyPublishedNames.size === publishablePackages.length;

  return {
    alreadyPublished,
    fullyRecorded,
    packagesToPublish: publishablePackages.filter(
      (pkg) => !alreadyPublishedNames.has(pkg.name),
    ),
    tagAlreadyPushed,
  };
}

export function guardReleasePublish({
  baseBranch = readEnv('RELEASE_BASE_BRANCH') ?? 'main',
  publishMode = readEnv('PUBLISH_MODE') ?? 'artifacts',
  releaseVersion = readEnv('RELEASE_VERSION'),
  repoRoot = process.cwd(),
  skipGitCheck = readEnv('SKIP_RELEASE_GIT_GUARD') === 'true',
  skipNpmCheck = readEnv('SKIP_RELEASE_NPM_GUARD') === 'true',
  spawn = spawnSync,
} = {}) {
  if (!releaseVersion) {
    fail('RELEASE_VERSION is required');
  }

  const publishablePackages = listPublishablePackages(repoRoot);
  const majorOffenders = findMajorVersionOffenders(
    listVersionedManifests(repoRoot, publishablePackages),
  );

  if (majorOffenders.length > 0) {
    fail(
      `Refusing to publish a major version release:\n${majorOffenders
        .map((offender) => `- ${offender.manifestPath}: ${offender.version}`)
        .join('\n')}`,
    );
  }

  // Compute tag/npm state BEFORE the HEAD-staleness check. push-release-refs.mjs
  // pushes the release commit and the tag atomically to `main`, so a rerun
  // after that succeeded checks out the *original*, now-superseded SHA —
  // origin/main has legitimately moved on, by this run's own prior success.
  // Running assertHeadMatchesRemote() first would reject that as "a newer
  // merge landed" and make the fullyRecorded no-op below unreachable for
  // the exact case it exists to handle (publish + push succeeded, only
  // `gh release create` failed). Staleness only matters when there is
  // still real publish work to do, so check it after, not before.
  const state = assessReleaseState({
    publishablePackages,
    releaseVersion,
    repoRoot,
    skipGitCheck,
    skipNpmCheck,
    spawn,
  });

  if (state.fullyRecorded) {
    console.log(
      `Release v${releaseVersion} is already fully published and recorded (tag pushed, all ${publishablePackages.length} package(s) on npm); nothing left to do.`,
    );
    return { ...state, publishablePackages };
  }

  // A stale checkout racing a newer, unrelated merge is unrelated to
  // resuming this exact release and stays a hard failure: let the newer
  // main run compute and publish the next version instead.
  if (!skipGitCheck) {
    assertHeadMatchesRemote({ baseBranch, repoRoot, spawn });
  }

  if (state.alreadyPublished.length > 0) {
    // Only the artifacts-mode publisher (publish-validated-artifacts.mjs)
    // skips already-published packages per package. The `changesets`
    // emergency fallback (`pnpm run changeset:publish`) has no such
    // resume logic and will attempt its ordinary publish flow, which fails
    // outright on a version that already exists. Resuming a conflicted
    // release is only safe in artifacts mode; keep the original hard
    // refusal for every other mode so an in-flight emergency fallback run
    // doesn't fail partway through instead of failing fast and clearly.
    if (publishMode !== 'artifacts') {
      fail(
        `Refusing to publish because package versions already exist on npm:\n${state.alreadyPublished
          .map((pkg) => `- ${pkg.name}@${pkg.version}`)
          .join(
            '\n',
          )}\nAn earlier attempt may already have performed the irreversible npm publish. publish-mode=${publishMode} has no per-package resume logic (only publish-mode=artifacts does) — bump a new version instead of retrying this one in this mode.`,
      );
    }

    console.log(
      `↪ Resuming v${releaseVersion}: ${state.alreadyPublished.length} of ${publishablePackages.length} package(s) already exist on npm and will be skipped:\n${state.alreadyPublished
        .map((pkg) => `  - ${pkg.name}@${pkg.version}`)
        .join('\n')}`,
    );
  }

  console.log(
    `Release publish guard passed for v${releaseVersion} (${publishablePackages.length} package(s), ${state.packagesToPublish.length} pending publish).`,
  );

  return { ...state, publishablePackages };
}

function writeGithubOutput(name, value) {
  const outputPath = readEnv('GITHUB_OUTPUT');
  if (!outputPath) return;
  writeFileSync(outputPath, `${name}=${value}\n`, { flag: 'a' });
}

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  try {
    const state = guardReleasePublish();
    writeGithubOutput(
      'already-recorded',
      state.fullyRecorded ? 'true' : 'false',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
