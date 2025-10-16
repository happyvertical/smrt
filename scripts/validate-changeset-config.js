#!/usr/bin/env node

/**
 * Changeset configuration validation script for pre-commit hooks
 * Validates changeset configuration for proper monorepo publishing setup
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Validate changeset configuration file
 * @returns {Array} Array of validation errors
 */
function validateChangesetConfig() {
  const errors = [];
  const configPath = '.changeset/config.json';

  if (!existsSync(configPath)) {
    errors.push('Missing .changeset/config.json configuration file');
    return errors;
  }

  try {
    const content = readFileSync(configPath, 'utf8');
    const config = JSON.parse(content);

    // Required fields validation
    const requiredFields = ['changelog', 'commit', 'access', 'baseBranch'];
    for (const field of requiredFields) {
      if (config[field] === undefined) {
        errors.push(`Missing required field in changeset config: ${field}`);
      }
    }

    // Validate access configuration
    if (config.access && !['restricted', 'public'].includes(config.access)) {
      errors.push(
        `Invalid access value: ${config.access} (should be "restricted" or "public")`,
      );
    }

    // Validate base branch
    if (
      config.baseBranch &&
      config.baseBranch !== 'master' &&
      config.baseBranch !== 'main'
    ) {
      errors.push(
        `Base branch should be "master" or "main" (got: ${config.baseBranch})`,
      );
    }

    // Validate updateInternalDependencies
    if (
      config.updateInternalDependencies &&
      !['patch', 'minor', 'major'].includes(config.updateInternalDependencies)
    ) {
      errors.push(
        `Invalid updateInternalDependencies: ${config.updateInternalDependencies}`,
      );
    }

    // Validate schema if present
    if (config.$schema && !config.$schema.includes('@changesets/config')) {
      errors.push('Invalid schema reference in changeset config');
    }
  } catch (parseError) {
    if (parseError instanceof SyntaxError) {
      errors.push(
        `Invalid JSON in .changeset/config.json: ${parseError.message}`,
      );
    } else {
      errors.push(`Failed to read changeset config: ${parseError.message}`);
    }
  }

  return errors;
}

/**
 * Validate workspace packages are properly configured for changesets
 * @returns {Array} Array of validation errors
 */
function validateWorkspacePackages() {
  const errors = [];

  try {
    // Read workspace configuration
    const _workspaceContent = readFileSync('pnpm-workspace.yaml', 'utf8');

    // Get package paths using fs instead of glob
    const packagePaths = [];
    if (existsSync('packages')) {
      const packageDirs = readdirSync('packages', { withFileTypes: true })
        .filter((dirent) => dirent.isDirectory())
        .map((dirent) => dirent.name);

      for (const dir of packageDirs) {
        const pkgPath = join('packages', dir, 'package.json');
        if (existsSync(pkgPath)) {
          packagePaths.push(pkgPath);
        }
      }
    }

    // Check each package has proper changeset configuration
    for (const packagePath of packagePaths) {
      try {
        const pkgContent = readFileSync(packagePath, 'utf8');
        const pkg = JSON.parse(pkgContent);

        // Check if package is publishable (has name and not private)
        if (pkg.name && !pkg.private) {
          // Validate package name format for publishing
          if (!pkg.name.startsWith('@have/')) {
            errors.push(
              `Package ${pkg.name} should use @have/ namespace for publishing`,
            );
          }

          // Check for required publishing fields
          if (!pkg.version) {
            errors.push(`Publishing package ${pkg.name} missing version field`);
          }

          if (!pkg.description) {
            errors.push(
              `Publishing package ${pkg.name} missing description field`,
            );
          }

          // Validate main/exports for publishing
          if (!pkg.main && !pkg.exports) {
            errors.push(
              `Publishing package ${pkg.name} missing main or exports field`,
            );
          }
        }
      } catch (pkgError) {
        errors.push(
          `Failed to read package.json at ${packagePath}: ${pkgError.message}`,
        );
      }
    }
  } catch (workspaceError) {
    errors.push(
      `Failed to read workspace configuration: ${workspaceError.message}`,
    );
  }

  return errors;
}

/**
 * Validate changeset CLI integration
 * @returns {Array} Array of validation errors
 */
function validateChangesetCLI() {
  const errors = [];

  try {
    const rootPkgPath = 'package.json';
    if (!existsSync(rootPkgPath)) {
      errors.push('Missing root package.json');
      return errors;
    }

    const content = readFileSync(rootPkgPath, 'utf8');
    const pkg = JSON.parse(content);

    // Check for changeset in devDependencies
    if (!pkg.devDependencies || !pkg.devDependencies['@changesets/cli']) {
      errors.push('Missing @changesets/cli in devDependencies');
    }

    // Check for changeset scripts
    if (!pkg.scripts) {
      errors.push('Missing scripts section in root package.json');
      return errors;
    }

    const requiredScripts = {
      changeset: '@changesets/cli changeset',
      'version-packages': '@changesets/cli version',
      release: '@changesets/cli publish',
    };

    for (const [scriptName, _expectedCommand] of Object.entries(
      requiredScripts,
    )) {
      if (!pkg.scripts[scriptName]) {
        errors.push(`Missing changeset script: ${scriptName}`);
      } else if (!pkg.scripts[scriptName].includes('@changesets/cli')) {
        errors.push(`Script ${scriptName} should use @changesets/cli`);
      }
    }
  } catch (error) {
    errors.push(`Failed to validate changeset CLI: ${error.message}`);
  }

  return errors;
}

/**
 * Validate gitignore configuration for changesets
 * @returns {Array} Array of validation errors
 */
function validateGitignore() {
  const errors = [];

  try {
    if (!existsSync('.gitignore')) {
      errors.push('Missing .gitignore file');
      return errors;
    }

    const content = readFileSync('.gitignore', 'utf8');
    const lines = content.split('\n').map((line) => line.trim());

    // Check for changeset temp files
    const requiredIgnores = [
      '.changeset/*.md',
      '!.changeset/README.md',
      '!.changeset/config.json',
    ];

    for (const ignore of requiredIgnores) {
      if (!lines.includes(ignore)) {
        errors.push(`Missing gitignore entry: ${ignore}`);
      }
    }
  } catch (error) {
    errors.push(`Failed to validate gitignore: ${error.message}`);
  }

  return errors;
}

/**
 * Main validation function
 */
function main() {
  console.log('🔍 Validating changeset configuration...\n');

  let hasErrors = false;

  // Validate changeset config file
  const configErrors = validateChangesetConfig();
  if (configErrors.length > 0) {
    hasErrors = true;
    console.error('❌ Changeset configuration errors:');
    for (const error of configErrors) {
      console.error(`  • ${error}`);
    }
    console.error('');
  } else {
    console.log('✅ Changeset configuration is valid');
  }

  // Validate workspace packages
  const packageErrors = validateWorkspacePackages();
  if (packageErrors.length > 0) {
    hasErrors = true;
    console.error('❌ Workspace package errors:');
    for (const error of packageErrors) {
      console.error(`  • ${error}`);
    }
    console.error('');
  } else {
    console.log('✅ Workspace packages are properly configured');
  }

  // Validate changeset CLI integration
  const cliErrors = validateChangesetCLI();
  if (cliErrors.length > 0) {
    hasErrors = true;
    console.error('❌ Changeset CLI errors:');
    for (const error of cliErrors) {
      console.error(`  • ${error}`);
    }
    console.error('');
  } else {
    console.log('✅ Changeset CLI is properly integrated');
  }

  // Validate gitignore
  const gitignoreErrors = validateGitignore();
  if (gitignoreErrors.length > 0) {
    hasErrors = true;
    console.error('❌ Gitignore configuration errors:');
    for (const error of gitignoreErrors) {
      console.error(`  • ${error}`);
    }
    console.error('');
  } else {
    console.log('✅ Gitignore is properly configured for changesets');
  }

  if (hasErrors) {
    console.error('🚫 Changeset validation failed!');
    console.error('Please fix the errors above before committing.');
    process.exit(1);
  } else {
    console.log('\n✅ All changeset configuration is valid!');
  }
}

try {
  main();
} catch (error) {
  console.error('💥 Validation script failed:', error.message);
  process.exit(1);
}
