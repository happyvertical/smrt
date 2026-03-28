#!/usr/bin/env node

/**
 * Build-time manifest generator
 * Scans TypeScript source files and generates static manifest JSON
 *
 * Now uses ManifestBuilder service for consolidated, testable logic
 */

import { execFileSync } from 'node:child_process';

async function generateManifest() {
  try {
    console.log('[smrt] Generating static manifest...');

    // Use ManifestBuilder via the tsx loader to handle TypeScript imports
    const tsCode = `
import { ManifestBuilder } from './src/manifest/generator.js';

const builder = new ManifestBuilder();

await builder.generate({
  // === FILE DISCOVERY ===
  include: ['src/**/*.ts'],
  exclude: [
    'src/**/*.test.ts',
    'src/**/*.spec.ts',
    'src/**/__tests__/**/*.ts',
    'src/**/*.d.ts',
    'src/scanner/**/*.ts',
    'src/vite-plugin/**/*.ts',
    'src/pleb.ts',  // Test/prototype class - not a real framework object
  ],

  // === SCANNER CONFIGURATION ===
  baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
  followImports: false,
  loadViteConfig: false,
  discoverExternalPackages: true,
  includeExternalBaseClasses: false,  // Build manifest doesn't need external base classes

  // === OUTPUT CONFIGURATION ===
  outputDir: 'src/manifest',
  outputName: 'static-manifest.json',
  generateTypeStub: true,
  stubName: 'static-manifest.ts',

  // === METADATA ===
  injectPackageInfo: true,
  moduleType: 'smrt',
});
`;

    // Write temporary TypeScript file
    const { writeFileSync, unlinkSync } = await import('node:fs');
    writeFileSync('temp-manifest-gen.ts', tsCode);

    try {
      // Execute the temporary TypeScript module without shelling out through npm/npx.
      execFileSync(
        process.execPath,
        ['--import', 'tsx', 'temp-manifest-gen.ts'],
        {
          stdio: 'inherit',
        },
      );
    } finally {
      try {
        unlinkSync('temp-manifest-gen.ts');
      } catch {}
    }
  } catch (error) {
    console.error('[smrt] ❌ Failed to generate manifest:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateManifest();
}

export { generateManifest };
