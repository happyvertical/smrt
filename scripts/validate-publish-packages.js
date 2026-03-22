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

if (!existsSync(packagesDir)) {
  fail(`Packages directory not found: ${packagesDir}`);
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
    if (!packageJson.publishConfig) {
      return null;
    }

    return {
      dir: packageDir,
      name: packageJson.name ?? entry.name,
    };
  })
  .filter(Boolean);

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
