#!/usr/bin/env node
/**
 * Script to copy package READMEs to docs/content directory
 * This maintains a single source of truth for documentation.
 */

import { copyFile, mkdir } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Paths
const repoRoot = join(__dirname, '../..');
const docsRoot = join(__dirname, '..');
const contentDir = join(docsRoot, 'content');
const packagesDir = join(repoRoot, 'packages');

// SMRT package names to copy
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

async function copyPackageReadmes() {
  try {
    // Ensure content directory exists
    if (!existsSync(contentDir)) {
      await mkdir(contentDir, { recursive: true });
    }

    console.log('Copying package READMEs to docs/content...');

    // Copy index.md from backup if it exists, otherwise from main docs
    const indexSource = existsSync(join(docsRoot, 'docs.backup/index.md'))
      ? join(docsRoot, 'docs.backup/index.md')
      : join(docsRoot, 'content/index.md');

    if (existsSync(indexSource)) {
      await copyFile(indexSource, join(contentDir, 'index.md'));
      console.log('✓ Copied index.md');
    }

    // Copy each package README
    for (const pkg of packages) {
      const sourcePath = join(packagesDir, pkg, 'README.md');
      const destPath = join(contentDir, `${pkg}.md`);

      if (!existsSync(sourcePath)) {
        console.warn(`⚠ Warning: ${sourcePath} does not exist, skipping`);
        continue;
      }

      await copyFile(sourcePath, destPath);
      console.log(`✓ Copied ${pkg}.md`);
    }

    console.log('\nAll package READMEs copied successfully!');
  } catch (error) {
    console.error('Error copying READMEs:', error);
    process.exit(1);
  }
}

// Run the script
copyPackageReadmes();
