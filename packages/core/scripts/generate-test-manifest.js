#!/usr/bin/env node

/**
 * Test manifest generator
 * Scans test files and generates manifest for runtime field detection
 *
 * This allows test files to use TypeScript type annotations (e.g., latitude: number | null)
 * instead of requiring explicit Field helpers, maintaining consistency with production code.
 *
 * Now uses ManifestBuilder service for consolidated, testable logic
 */

import { execSync } from 'node:child_process';

async function generateTestManifest() {
  try {
    console.log('[smrt] Generating test manifest...');

    // Use ManifestBuilder via npx tsx to handle TypeScript imports
    const tsCode = `
import { ManifestBuilder } from '@happyvertical/smrt-core/manifest/generator';

const builder = new ManifestBuilder();

await builder.generate({
  // === FILE DISCOVERY ===
  // Scan all source files including test files for test manifest
  // Test classes defined inline need to be in the manifest for proper field detection
  include: ['src/**/*.ts'],
  exclude: ['src/**/*.d.ts', 'node_modules/**'],

  // === SCANNER CONFIGURATION ===
  baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
  followImports: true,  // Needed for multi-package inheritance (e.g., Meeting extends Event from external package)
  loadViteConfig: true,  // Use custom baseClasses from vite.config.ts if present
  discoverExternalPackages: true,
  includeExternalBaseClasses: true,  // Test manifest needs external base classes

  // === OUTPUT CONFIGURATION ===
  outputDir: 'src/manifest',
  outputName: 'test-manifest.json',
  generateTypeStub: true,
  stubName: 'test-manifest-stub.ts',

  // === METADATA ===
  injectPackageInfo: true,
  moduleType: 'smrt',
});
`;

    // Write temporary TypeScript file
    const { writeFileSync } = await import('node:fs');
    writeFileSync('temp-test-manifest-gen.ts', tsCode);

    try {
      // Execute with tsx
      execSync('npx tsx temp-test-manifest-gen.ts', { stdio: 'inherit' });
    } finally {
      // Clean up temporary file
      try {
        execSync('rm temp-test-manifest-gen.ts');
      } catch {}
    }
  } catch (error) {
    console.error('[smrt] ❌ Failed to generate test manifest:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateTestManifest();
}

export { generateTestManifest };
