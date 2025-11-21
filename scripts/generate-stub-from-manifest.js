#!/usr/bin/env node

/**
 * Generates test-manifest-stub.ts from dist/manifest.json
 * Run after build to keep stub in sync with generated manifest
 *
 * Usage: node ../../scripts/generate-stub-from-manifest.js
 * (Run from package directory)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const packageRoot = process.cwd();

try {
  // Determine if this is core package or another package
  const packageJson = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf-8'),
  );
  const isCore = packageJson.name === '@happyvertical/smrt-core';

  const manifestPath = join(packageRoot, 'dist/manifest.json');
  const stubPath = join(packageRoot, 'src/manifest/test-manifest-stub.ts');

  if (!existsSync(manifestPath)) {
    console.log(
      '[stub-gen] No dist/manifest.json found, skipping stub generation',
    );
    process.exit(0);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));

  // Use relative import for core, package import for other packages
  const importPath = isCore
    ? '../scanner/types'
    : '@happyvertical/smrt-core/scanner';

  const stub = `/**
 * Auto-generated test manifest stub
 * DO NOT EDIT - Generated from dist/manifest.json by generate-stub-from-manifest.js
 */

import type { SmartObjectManifest } from '${importPath}';

export const testManifest: SmartObjectManifest = ${JSON.stringify(manifest, null, 2)} as const;

export default testManifest;
`;

  // Ensure manifest directory exists
  const manifestDir = join(packageRoot, 'src/manifest');
  if (!existsSync(manifestDir)) {
    mkdirSync(manifestDir, { recursive: true });
  }

  writeFileSync(stubPath, stub);
  console.log(`[stub-gen] Generated ${stubPath}`);
} catch (error) {
  console.error('[stub-gen] Error:', error.message || error);
  process.exit(1);
}
