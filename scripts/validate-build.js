#!/usr/bin/env node

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Validates that all packages referenced in the build script actually exist
 */
async function validateBuild() {
  try {
    // Read package.json
    const packageJsonPath = path.join(process.cwd(), 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf8');
    const packageJson = JSON.parse(packageJsonContent);

    // Extract build script
    const buildScript = packageJson.scripts?.build;
    if (!buildScript) {
      console.error('❌ No build script found in package.json');
      process.exit(1);
    }

    // Extract package names from build script using regex
    const packageMatches = buildScript.match(/--filter @have\/\w+/g) || [];
    const referencedPackages = packageMatches.map((match) =>
      match.replace('--filter @have/', ''),
    );

    console.log('📦 Packages referenced in build script:', referencedPackages);

    // Check if packages directory exists
    const packagesDir = path.join(process.cwd(), 'packages');
    try {
      await fs.access(packagesDir);
    } catch {
      console.error('❌ packages directory not found');
      process.exit(1);
    }

    // Get actual package directories
    const packageDirs = await fs.readdir(packagesDir, { withFileTypes: true });
    const existingPackages = packageDirs
      .filter((dirent) => dirent.isDirectory())
      .map((dirent) => dirent.name);

    console.log('📁 Existing packages:', existingPackages);

    // Check for missing packages
    const missingPackages = referencedPackages.filter(
      (pkg) => !existingPackages.includes(pkg),
    );

    if (missingPackages.length > 0) {
      console.error(
        '❌ Missing packages referenced in build script:',
        missingPackages,
      );
      console.error(
        '   Either create these packages or remove them from the build script',
      );
      process.exit(1);
    }

    // Check for extra packages not in build script
    const extraPackages = existingPackages.filter(
      (pkg) => !referencedPackages.includes(pkg),
    );

    if (extraPackages.length > 0) {
      console.warn('⚠️  Packages exist but not in build script:', extraPackages);
      console.warn(
        '   Consider adding them to the build script if they need building',
      );

      // Validate that each package has a package.json
      for (const pkg of extraPackages) {
        const pkgJsonPath = path.join(packagesDir, pkg, 'package.json');
        try {
          await fs.access(pkgJsonPath);
          const pkgContent = await fs.readFile(pkgJsonPath, 'utf8');
          const pkgJson = JSON.parse(pkgContent);
          if (pkgJson.scripts?.build) {
            console.warn(
              `   📦 ${pkg} has a build script but is not in the main build`,
            );
          }
        } catch {
          console.warn(`   ❌ ${pkg} missing package.json`);
        }
      }
    }

    console.log('✅ Build validation passed - all referenced packages exist');
    return true;
  } catch (error) {
    console.error('❌ Error during build validation:', error.message);
    process.exit(1);
  }
}

validateBuild();
