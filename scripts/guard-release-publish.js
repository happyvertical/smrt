#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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

export function assertReleaseTagIsUnused({
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
    fail(
      `Refusing to publish because release tag v${releaseVersion} already exists on origin.`,
    );
  }

  if (result.status !== 2) {
    fail(
      `Failed to check release tag v${releaseVersion}:\n${result.stderr || result.stdout}`,
    );
  }
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

export function guardReleasePublish({
  baseBranch = readEnv('RELEASE_BASE_BRANCH') ?? 'main',
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

  if (!skipGitCheck) {
    assertHeadMatchesRemote({ baseBranch, repoRoot, spawn });
    assertReleaseTagIsUnused({ releaseVersion, repoRoot, spawn });
  }

  if (!skipNpmCheck) {
    const conflicts = findPublishedPackageConflicts({
      packages: publishablePackages,
      repoRoot,
      spawn,
    });

    if (conflicts.length > 0) {
      fail(
        `Refusing to publish because package versions already exist on npm:\n${conflicts
          .map((pkg) => `- ${pkg.name}@${pkg.version}`)
          .join(
            '\n',
          )}\nAn earlier job may already have performed the irreversible npm publish. Bump a new version instead of retagging this one.`,
      );
    }
  }

  console.log(
    `Release publish guard passed for v${releaseVersion} (${publishablePackages.length} package(s)).`,
  );
}

const isCli =
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isCli) {
  try {
    guardReleasePublish();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
