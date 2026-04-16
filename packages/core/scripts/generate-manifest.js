#!/usr/bin/env node

/**
 * Build-time manifest generator
 * Scans TypeScript source files and generates static manifest JSON
 *
 * Now uses ManifestBuilder service for consolidated, testable logic
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { register } from 'tsx/esm/api';

async function generateManifest() {
  try {
    console.log('[smrt] Generating static manifest...');

    const workspaceTsconfigPath = resolve(
      process.cwd(),
      '../../tsconfig.package-build.json',
    );
    const unregister = register(
      existsSync(workspaceTsconfigPath)
        ? { tsconfig: workspaceTsconfigPath }
        : undefined,
    );

    try {
      const { ManifestBuilder } = await import(
        pathToFileURL(resolve(process.cwd(), 'src/manifest/generator.ts')).href
      );

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
          'src/pleb.ts', // Test/prototype class - not a real framework object
        ],

        // === SCANNER CONFIGURATION ===
        baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
        followImports: false,
        loadViteConfig: false,
        discoverExternalPackages: true,
        includeExternalBaseClasses: false, // Build manifest doesn't need external base classes

        // === OUTPUT CONFIGURATION ===
        outputDir: 'src/manifest',
        outputName: 'static-manifest.json',
        generateTypeStub: true,
        stubName: 'static-manifest.ts',

        // === METADATA ===
        injectPackageInfo: true,
        moduleType: 'smrt',
      });
    } finally {
      await unregister();
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
