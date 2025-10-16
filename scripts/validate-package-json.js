#!/usr/bin/env bun

/**
 * Package.json validation script for pre-commit hooks
 * Validates package.json files for required fields, version consistency, and Bun compatibility
 */

import { readFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

const REQUIRED_FIELDS = [
  'name',
  'version',
  'description',
  'type',
  'main',
  'scripts',
];

const ROOT_PACKAGE_FIELDS = [
  'name',
  'version',
  'description',
  'type',
  'scripts',
];

const REQUIRED_SCRIPTS = ['build', 'dev', 'test'];

/**
 * Validate a single package.json file
 * @param {string} filePath - Path to package.json file
 * @returns {Array} Array of validation errors
 */
function validatePackageJson(filePath) {
  const errors = [];

  try {
    const content = readFileSync(filePath, 'utf8');
    const pkg = JSON.parse(content);
    const packageName = basename(dirname(filePath));

    // Check required fields (different for root package vs sub-packages)
    const absolutePath = resolve(filePath);
    const isRootPackage =
      basename(absolutePath) === 'package.json' &&
      (dirname(absolutePath).endsWith('/sdk') ||
        basename(dirname(absolutePath)) === 'sdk');
    const requiredFields = isRootPackage
      ? ROOT_PACKAGE_FIELDS
      : REQUIRED_FIELDS;

    for (const field of requiredFields) {
      if (!pkg[field]) {
        errors.push(`Missing required field: ${field}`);
      }
    }

    // Validate package name format
    if (pkg.name && !pkg.name.startsWith('@have/') && packageName !== 'sdk') {
      errors.push(`Package name should start with @have/ (got: ${pkg.name})`);
    }

    // Check required scripts
    if (pkg.scripts) {
      for (const script of REQUIRED_SCRIPTS) {
        if (!pkg.scripts[script]) {
          errors.push(`Missing required script: ${script}`);
        }
      }
    }

    // Validate version format
    if (pkg.version && !/^\d+\.\d+\.\d+/.test(pkg.version)) {
      errors.push(`Invalid version format: ${pkg.version} (should be semver)`);
    }

    // Check for Node.js version consistency
    if (pkg.engines?.bun) {
      errors.push(
        `Package should not specify Bun engine (found: ${pkg.engines.bun}). Use Node.js + pnpm.`,
      );
    }

    // Check for required Node.js version in root package
    if (isRootPackage && (!pkg.engines?.node || !pkg.engines.node.startsWith('>=24'))) {
      errors.push(
        `Root package should specify Node.js version >=24.0.0 (got: ${pkg.engines?.node || 'none'})`,
      );
    }

    // Validate workspace dependencies format
    if (pkg.dependencies) {
      for (const [dep, version] of Object.entries(pkg.dependencies)) {
        if (dep.startsWith('@have/') && version !== 'workspace:*') {
          errors.push(
            `Internal dependency ${dep} should use "workspace:*" (got: ${version})`,
          );
        }
      }
    }

    // Check for proper module type
    if (!pkg.type || pkg.type !== 'module') {
      errors.push('Package should specify "type": "module"');
    }
  } catch (parseError) {
    if (parseError instanceof SyntaxError) {
      errors.push(`Invalid JSON format: ${parseError.message}`);
    } else {
      errors.push(`Failed to read file: ${parseError.message}`);
    }
  }

  return errors;
}

/**
 * Check version consistency across all package.json files
 * @param {Array} packagePaths - Array of package.json file paths
 * @returns {Array} Array of consistency errors
 */
function checkVersionConsistency(packagePaths) {
  const errors = [];
  const versions = new Map();

  for (const filePath of packagePaths) {
    try {
      const content = readFileSync(filePath, 'utf8');
      const pkg = JSON.parse(content);

      if (pkg.version) {
        const packageName = basename(dirname(filePath));
        versions.set(packageName, pkg.version);
      }
    } catch (_error) {
      // Skip files with JSON errors (handled by individual validation)
    }
  }

  // Check if all package versions match (for monorepo consistency)
  const versionValues = Array.from(versions.values());
  const uniqueVersions = new Set(versionValues);

  if (uniqueVersions.size > 1) {
    errors.push(
      `Version mismatch across packages: ${Array.from(uniqueVersions).join(', ')}`,
    );
    for (const [pkg, version] of versions) {
      errors.push(`  ${pkg}: ${version}`);
    }
  }

  return errors;
}

/**
 * Main validation function
 */
function main() {
  const filePaths = process.argv.slice(2);

  if (filePaths.length === 0) {
    console.error('No package.json files provided');
    process.exit(1);
  }

  let hasErrors = false;

  // Validate each package.json individually
  for (const filePath of filePaths) {
    const errors = validatePackageJson(filePath);

    if (errors.length > 0) {
      hasErrors = true;
      console.error(`\n❌ Validation errors in ${filePath}:`);
      for (const error of errors) {
        console.error(`  • ${error}`);
      }
    } else {
      console.log(`✅ ${filePath} is valid`);
    }
  }

  // Check version consistency across all files
  const consistencyErrors = checkVersionConsistency(filePaths);
  if (consistencyErrors.length > 0) {
    hasErrors = true;
    console.error('\n❌ Version consistency errors:');
    for (const error of consistencyErrors) {
      console.error(`  • ${error}`);
    }
  }

  if (hasErrors) {
    console.error('\n🚫 Package.json validation failed!');
    console.error('Please fix the errors above before committing.');
    process.exit(1);
  } else {
    console.log('\n✅ All package.json files are valid!');
  }
}

main();
