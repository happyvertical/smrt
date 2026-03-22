#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function fail(message) {
  console.error(`❌ ${message}`);
  process.exit(1);
}

const repoRoot = process.cwd();
const packagesDir = resolve(repoRoot, 'packages');
const changesetConfigPath = resolve(repoRoot, '.changeset/config.json');

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

if (publishablePackages.length === 0) {
  console.log('ℹ️ No publishable packages found');
  process.exit(0);
}

for (const pkg of publishablePackages) {
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
}

console.log(
  `✅ Validated publish lifecycle for ${publishablePackages.length} package(s)`,
);
