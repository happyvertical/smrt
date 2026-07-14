#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { findUnsupportedDependencyProtocols } from './publish-artifacts-lib.mjs';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

function readOptionValue(flagName) {
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === flagName) {
      const nextArg = args[index + 1];
      if (nextArg === undefined || nextArg.startsWith('-')) {
        fail(`Missing value for ${flagName}`);
      }
      return nextArg;
    }
    if (arg.startsWith(`${flagName}=`)) {
      const value = arg.slice(flagName.length + 1);
      if (value === '') {
        fail(`Missing value for ${flagName}`);
      }
      return value;
    }
  }
  return undefined;
}

function parsePositiveIntegerOption(flagName, envName, fallback) {
  const rawValue = readOptionValue(flagName) ?? process.env[envName];
  if (rawValue === undefined) {
    return fallback;
  }

  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsedValue) || parsedValue < 1) {
    fail(
      `${flagName} / ${envName} must be a positive integer, received ${JSON.stringify(rawValue)}`,
    );
  }

  return parsedValue;
}

const repoRoot = process.cwd();
const packagesDir = resolve(repoRoot, 'packages');
const changesetConfigPath = resolve(repoRoot, '.changeset/config.json');
const shardCount = parsePositiveIntegerOption(
  '--shard-count',
  'PUBLISH_PACK_SHARD_COUNT',
  1,
);
const shardIndex = parsePositiveIntegerOption(
  '--shard-index',
  'PUBLISH_PACK_SHARD_INDEX',
  1,
);
const outputDir = resolve(
  repoRoot,
  readOptionValue('--output-dir') ??
    process.env.PUBLISH_PACK_OUTPUT_DIR ??
    '.artifacts/publish-pack',
);

if (shardIndex > shardCount) {
  fail(
    `--shard-index / PUBLISH_PACK_SHARD_INDEX must be between 1 and ${shardCount}, received ${shardIndex}`,
  );
}

if (!existsSync(packagesDir)) {
  fail(`Packages directory not found: ${packagesDir}`);
}

if (!existsSync(changesetConfigPath)) {
  fail(`Changeset config not found: ${changesetConfigPath}`);
}

const changesetConfig = JSON.parse(readFileSync(changesetConfigPath, 'utf8'));
const releasePackageNames = new Set(
  (changesetConfig.fixed ?? []).flatMap((group) =>
    Array.isArray(group) ? group : [],
  ),
);

if (releasePackageNames.size === 0) {
  fail('No fixed release package names found in .changeset/config.json');
}

// Private workspace members may sit in the fixed release group so their
// version rides the release train without ever publishing to npm (e.g.
// @happyvertical/smrt-mobile — Kotlin/Gradle, ADR 0001). Changesets versions
// them; the publish set below excludes them.
const privateWorkspacePackageNames = new Set();

const publishablePackages = readdirSync(packagesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const packageDir = join(packagesDir, entry.name);
    const packageJsonPath = join(packageDir, 'package.json');

    if (!existsSync(packageJsonPath)) {
      return null;
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
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
      name: packageName,
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

const publishableSmrtPackagesMissingFixedGroup = publishablePackages
  .filter(
    (pkg) =>
      pkg.name.startsWith('@happyvertical/smrt-') &&
      !releasePackageNames.has(pkg.name),
  )
  .map((pkg) => pkg.name);

if (publishableSmrtPackagesMissingFixedGroup.length > 0) {
  fail(
    `Publishable SMRT packages must be declared in .changeset/config.json fixed release group:\n${publishableSmrtPackagesMissingFixedGroup
      .map((packageName) => `- ${packageName}`)
      .join('\n')}`,
  );
}

if (publishablePackages.length === 0) {
  console.log('ℹ️ No publishable packages found');
  process.exit(0);
}

const shardPackages = publishablePackages.filter(
  (_pkg, index) => index % shardCount === shardIndex - 1,
);

if (shardCount > 1) {
  console.log(
    `🧩 Validating shard ${shardIndex}/${shardCount} (${shardPackages.length} of ${publishablePackages.length} publishable packages)`,
  );
}

if (shardPackages.length === 0) {
  console.log(
    `ℹ️ No publishable packages assigned to shard ${shardIndex}/${shardCount}`,
  );
  process.exit(0);
}

mkdirSync(outputDir, { recursive: true });
const artifacts = [];

for (const pkg of shardPackages) {
  console.log(`📦 Creating and validating publish artifact for ${pkg.name}`);
  const before = new Set(
    readdirSync(outputDir).filter((entry) => entry.endsWith('.tgz')),
  );
  const result = spawnSync('pnpm', ['pack', '--pack-destination', outputDir], {
    cwd: pkg.dir,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    fail(`Failed to run pnpm pack for ${pkg.name}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`pnpm pack failed for ${pkg.name}`);
  }

  const created = readdirSync(outputDir).filter(
    (entry) => entry.endsWith('.tgz') && !before.has(entry),
  );
  if (created.length !== 1) {
    fail(
      `Expected exactly one tarball for ${pkg.name}, found ${created.length}`,
    );
  }
  const filename = created[0];
  const tarballPath = join(outputDir, filename);

  const packedManifestResult = spawnSync(
    'tar',
    ['-xOf', tarballPath, 'package/package.json'],
    {
      encoding: 'utf8',
      env: process.env,
    },
  );
  if (packedManifestResult.error || packedManifestResult.status !== 0) {
    const details = [
      `status=${packedManifestResult.status ?? 'unknown'}`,
      packedManifestResult.error
        ? `error=${packedManifestResult.error.message}`
        : '',
      packedManifestResult.stderr?.trim()
        ? `stderr=${packedManifestResult.stderr.trim()}`
        : '',
    ]
      .filter(Boolean)
      .join('; ');
    fail(`Failed to inspect packed manifest for ${pkg.name}: ${details}`);
  }

  const packedManifest = JSON.parse(packedManifestResult.stdout);
  const unsupportedProtocols =
    findUnsupportedDependencyProtocols(packedManifest);
  if (unsupportedProtocols.length > 0) {
    fail(
      `Packed manifest for ${pkg.name} contains unresolved dependency protocols:\n${unsupportedProtocols
        .map((entry) => `- ${entry}`)
        .join('\n')}`,
    );
  }

  const verifyResult = spawnSync(
    process.execPath,
    [
      join(repoRoot, 'scripts', 'verify-package-types-exports.js'),
      pkg.dir,
      '--tarball',
      tarballPath,
    ],
    {
      cwd: repoRoot,
      stdio: 'inherit',
      env: process.env,
    },
  );

  if (verifyResult.error) {
    fail(
      `Failed to verify packed exports for ${pkg.name}: ${verifyResult.error.message}`,
    );
  }

  if (verifyResult.status !== 0) {
    fail(`Packed export verification failed for ${pkg.name}`);
  }

  if (pkg.name === '@happyvertical/smrt-profiles') {
    const registerImportResult = spawnSync(
      process.execPath,
      [
        join(repoRoot, 'scripts', 'verify-generated-register-import.mjs'),
        '--package-dir',
        pkg.dir,
        '--tarball',
        tarballPath,
      ],
      {
        cwd: repoRoot,
        stdio: 'inherit',
        env: process.env,
      },
    );

    if (registerImportResult.error) {
      fail(
        `Failed to verify generated registration for ${pkg.name}: ${registerImportResult.error.message}`,
      );
    }

    if (registerImportResult.status !== 0) {
      fail(`Generated registration verification failed for ${pkg.name}`);
    }
  }

  const packageJson = JSON.parse(
    readFileSync(join(pkg.dir, 'package.json'), 'utf8'),
  );
  artifacts.push({
    name: pkg.name,
    version: packageJson.version,
    filename,
    sha256: createHash('sha256')
      .update(readFileSync(tarballPath))
      .digest('hex'),
  });
}

const releaseVersions = new Set(artifacts.map((artifact) => artifact.version));
if (releaseVersions.size !== 1) {
  fail(
    `Pack shard contains inconsistent versions: ${[...releaseVersions].join(', ')}`,
  );
}

const manifestPath = join(
  outputDir,
  `manifest-${shardIndex}-of-${shardCount}.json`,
);
writeFileSync(
  manifestPath,
  `${JSON.stringify(
    {
      schemaVersion: 1,
      releaseVersion: artifacts[0].version,
      packages: artifacts,
    },
    null,
    2,
  )}\n`,
);

console.log(
  shardCount > 1
    ? `✅ Validated publish lifecycle for ${shardPackages.length} package(s) in shard ${shardIndex}/${shardCount}`
    : `✅ Validated publish lifecycle for ${publishablePackages.length} package(s)`,
);
