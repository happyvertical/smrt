#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

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

    if (
      packageJson.private === true ||
      (!isReleasePackage && !isExplicitlyPublishable)
    ) {
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
  (packageName) => !discoveredPackageNames.has(packageName),
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

for (const pkg of shardPackages) {
  console.log(`📦 Validating publish dry-run for ${pkg.name}`);
  const result = spawnSync('npm', ['pack', '--dry-run'], {
    cwd: pkg.dir,
    stdio: 'inherit',
    env: process.env,
  });

  if (result.error) {
    fail(`Failed to run npm pack for ${pkg.name}: ${result.error.message}`);
  }

  if (result.status !== 0) {
    fail(`npm pack --dry-run failed for ${pkg.name}`);
  }

  const verifyResult = spawnSync(
    process.execPath,
    [join(repoRoot, 'scripts', 'verify-package-types-exports.js'), pkg.dir],
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
}

console.log(
  shardCount > 1
    ? `✅ Validated publish lifecycle for ${shardPackages.length} package(s) in shard ${shardIndex}/${shardCount}`
    : `✅ Validated publish lifecycle for ${publishablePackages.length} package(s)`,
);
