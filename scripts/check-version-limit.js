#!/usr/bin/env node

/**
 * Version Check - Prevents major version bumps past 0.x.x
 *
 * This script validates that no package version goes to 1.0.0 or higher.
 * The SMRT framework intentionally stays in 0.x.x versioning until
 * the API is stable and production-ready.
 *
 * Run this as a preversion hook or manually before releasing.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

let hasErrors = false;

function checkPackageVersion(pkgJsonPath, pkgName) {
  try {
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
    const version = pkgJson.version;

    if (!version) {
      return; // No version field
    }

    const [major] = version.split('.').map(Number);

    if (major >= 1) {
      console.error(`❌ ${pkgName}: Version ${version} exceeds 0.x.x limit`);
      console.error(
        `   The framework must stay in 0.x.x until explicitly ready for 1.0.0`,
      );
      hasErrors = true;
    } else {
      console.log(`✅ ${pkgName}: ${version}`);
    }
  } catch (_err) {
    // Skip packages without package.json
  }
}

console.log('🔍 Checking version limits...\n');

// Check root package
checkPackageVersion('package.json', 'root');

// Check all packages
const packagesDir = 'packages';
if (readdirSync(packagesDir)) {
  const packages = readdirSync(packagesDir);

  for (const pkg of packages) {
    const pkgJsonPath = join(packagesDir, pkg, 'package.json');
    checkPackageVersion(pkgJsonPath, pkg);
  }
}

console.log('');

if (hasErrors) {
  console.error('❌ Version check failed!');
  console.error('');
  console.error('One or more packages would exceed version 0.x.x.');
  console.error('The SMRT framework intentionally stays in 0.x.x versioning');
  console.error('until the API is stable and production-ready.');
  console.error('');
  console.error('To release 1.0.0, this check must be explicitly disabled.');
  process.exit(1);
}

console.log('✅ All versions within 0.x.x limit');
