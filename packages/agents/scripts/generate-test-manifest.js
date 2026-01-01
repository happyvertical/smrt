#!/usr/bin/env node

/**
 * Test manifest generator for SMRT packages
 * Scans source files and generates manifest for runtime field detection.
 * Now unified using ManifestBuilder and ManifestManager.
 */

import { writeFileSync } from 'node:fs';

async function generateTestManifest() {
  try {
    console.log('[smrt] Generating test manifest...');

    const { execSync } = await import('node:child_process');

    // Create a temporary TypeScript runner that uses ManifestBuilder
    const tsCode = `
import { ManifestBuilder } from '@happyvertical/smrt-core/manifest';

async function run() {
  const builder = new ManifestBuilder();
  await builder.generate({
    include: ['src/**/*.ts'],
    exclude: ['src/**/*.d.ts'],
    baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection', 'Agent'],
    followImports: true,
    discoverExternalPackages: true,
    includeExternalBaseClasses: true,
    outputDir: 'src/manifest',
    outputName: 'test-manifest.json',
    generateTypeStub: true,
    stubName: 'test-manifest-stub.ts',
    injectPackageInfo: true,
  });
}

run().catch(console.error);
`;

    // Write and execute the TypeScript code with unique name to avoid race conditions
    // when multiple builds run in parallel (see issue #631)
    const { unlinkSync } = await import('node:fs');
    const tempFile = `temp-test-manifest-gen-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`;
    writeFileSync(tempFile, tsCode);

    try {
      execSync(`npx tsx ${tempFile}`, { stdio: 'inherit' });
    } finally {
      // Clean up
      try {
        unlinkSync(tempFile);
      } catch {}
    }
  } catch (error) {
    console.error('[smrt] Failed to generate test manifest:', error);
    process.exit(1);
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  generateTestManifest();
}

export { generateTestManifest };
