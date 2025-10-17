#!/usr/bin/env node
/**
 * Script to generate TypeDoc API documentation for each package
 * Outputs markdown files to content/api/[package-name]/
 */

import { mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { execSync } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const repoRoot = join(__dirname, '../..');
const docsRoot = join(__dirname, '..');
const packagesDir = join(repoRoot, 'packages');
const apiDocsDir = join(docsRoot, 'content', 'api');

// SMRT package names to document
const packages = [
  'types',
  'core',
  'accounts',
  'agents',
  'assets',
  'content',
  'events',
  'gnode',
  'places',
  'products',
  'profiles',
  'tags',
];

/**
 * Generate API documentation for a single package
 * @param {string} pkg - Package name
 */
async function generatePackageApiDocs(pkg) {
  const packagePath = join(packagesDir, pkg);
  const srcPath = join(packagePath, 'src');
  const outputPath = join(apiDocsDir, pkg);

  if (!existsSync(srcPath)) {
    console.warn(`⚠ Warning: ${srcPath} does not exist, skipping`);
    return false;
  }

  try {
    // Ensure output directory exists
    if (existsSync(outputPath)) {
      await rm(outputPath, { recursive: true });
    }
    await mkdir(outputPath, { recursive: true });

    // Run TypeDoc
    const typedocCmd = [
      'npx typedoc',
      `"${srcPath}/index.ts"`,
      `--tsconfig "${packagePath}/tsconfig.json"`,
      `--out "${outputPath}"`,
      '--plugin typedoc-plugin-markdown',
      '--outputFileStrategy modules',
      '--skipErrorChecking',
    ].join(' ');

    execSync(typedocCmd, {
      cwd: docsRoot,
      stdio: 'pipe',
    });

    console.log(`✓ Generated API docs for @smrt/${pkg}`);
    return true;
  } catch (error) {
    console.error(`✗ Error generating API docs for @smrt/${pkg}:`, error.message);
    return false;
  }
}

/**
 * Generate API documentation for all packages
 */
async function generateApiDocs() {
  console.log('Generating API documentation for all packages...\n');

  // Ensure api directory exists
  if (!existsSync(apiDocsDir)) {
    await mkdir(apiDocsDir, { recursive: true });
  }

  let successCount = 0;
  let failureCount = 0;

  for (const pkg of packages) {
    const success = await generatePackageApiDocs(pkg);
    if (success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  console.log(`\n✓ API documentation generation complete!`);
  console.log(`  - ${successCount} packages succeeded`);
  if (failureCount > 0) {
    console.log(`  - ${failureCount} packages failed`);
  }
}

// Run the script
generateApiDocs().catch((error) => {
  console.error('Error generating API documentation:', error);
  process.exit(1);
});
