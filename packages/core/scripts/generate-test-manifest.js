#!/usr/bin/env node

/**
 * Test manifest generator
 * Scans test files and generates manifest for runtime field detection
 *
 * This allows test files to use TypeScript type annotations (e.g., latitude: number | null)
 * instead of requiring explicit Field helpers, maintaining consistency with production code.
 */

import { writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateTestManifest() {
  try {
    console.log('[smrt] Generating test manifest...');

    const { execSync } = await import('node:child_process');

    // Create a temporary TypeScript runner for test files
    const tsCode = `
import { ASTScanner, ManifestGenerator } from '@happyvertical/smrt-core/scanner';
import fg from 'fast-glob';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function runTestScanner() {
  // Scan ALL source files (both test files and regular source files)
  // This ensures test manifest includes classes defined outside test files
  const sourceFiles = fg.sync(['src/**/*.ts'], {
    absolute: true,
    ignore: [
      'src/**/*.d.ts',
      'node_modules/**',
    ],
  });

  if (sourceFiles.length === 0) {
    console.log('[smrt] No source files found');
    return { version: '1.0.0', timestamp: Date.now(), objects: {} };
  }

  console.log(\`[smrt] Scanning \${sourceFiles.length} source file(s)...\`);

  // Try to load vite config to get custom baseClasses
  let scannerOptions = {
    baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
    includePrivateMethods: false,
    includeStaticMethods: true,
    followImports: true, // Default true: needed for multi-package inheritance
  };

  try {
    const viteConfigPath = resolve(process.cwd(), 'vite.config.ts');
    const { existsSync } = await import('node:fs');

    console.log(\`[smrt] Checking for vite.config.ts at: \${viteConfigPath}\`);

    if (existsSync(viteConfigPath)) {
      console.log('[smrt] ✓ vite.config.ts found, attempting to load...');

      // Use vite to load config which handles TypeScript
      const { loadConfigFromFile } = await import('vite');
      const loaded = await loadConfigFromFile({ command: 'build', mode: 'test' }, viteConfigPath);

      console.log('[smrt] Vite config loaded:', loaded ? 'success' : 'failed');

      if (!loaded) {
        console.log('[smrt] ✗ loadConfigFromFile returned null/undefined');
      } else if (!loaded.config) {
        console.log('[smrt] ✗ loaded.config is null/undefined');
      } else if (!loaded.config.plugins) {
        console.log('[smrt] ✗ loaded.config.plugins is null/undefined');
      } else {
        const pluginNames = loaded.config.plugins.map(p => p?.name).filter(Boolean);
        console.log(\`[smrt] Found \${pluginNames.length} plugins:\`, pluginNames.join(', '));

        // Find smrtPlugin in plugins array (name is 'smrt-auto-service')
        const smrtPlugin = loaded.config.plugins.find(p => p?.name === 'smrt-auto-service');

        if (!smrtPlugin) {
          console.log('[smrt] ✗ smrt-auto-service plugin not found in plugins array');
          console.log('[smrt]   Available plugins:', pluginNames);
        } else {
          console.log('[smrt] ✓ Found smrt-auto-service plugin');

          // Debug plugin structure
          console.log('[smrt] Plugin keys:', Object.keys(smrtPlugin));
          console.log('[smrt] Has api property?', 'api' in smrtPlugin);
          console.log('[smrt] api type:', typeof smrtPlugin.api);

          // The plugin instance should expose its options
          // Try different ways to access options
          let opts = smrtPlugin.api?.options || smrtPlugin.options || smrtPlugin._options;

          if (!opts && typeof smrtPlugin.api === 'function') {
            console.log('[smrt] Trying to call plugin.api() function...');
            try {
              const api = smrtPlugin.api();
              opts = api?.options;
              console.log('[smrt] plugin.api() returned:', api ? 'object' : 'null/undefined');
            } catch (e) {
              console.log('[smrt] ✗ Error calling plugin.api():', e.message);
            }
          }

          if (opts) {
            console.log('[smrt] ✓ Plugin options found!');
            console.log('[smrt] Options:', JSON.stringify({
              baseClasses: opts.baseClasses,
              followImports: opts.followImports
            }, null, 2));

            if (opts.baseClasses) {
              scannerOptions.baseClasses = opts.baseClasses;
              console.log(\`[smrt] ✓ Using baseClasses from vite.config.ts: \${opts.baseClasses.join(', ')}\`);
            }
            if (opts.followImports !== undefined) {
              scannerOptions.followImports = opts.followImports;
              console.log(\`[smrt] ✓ Using followImports from vite.config.ts: \${opts.followImports}\`);
            }
          } else {
            console.log('[smrt] ✗ Could not access plugin options');
            console.log('[smrt]   Tried: smrtPlugin.api.options, smrtPlugin.options, smrtPlugin._options');
          }
        }
      }
    } else {
      console.log('[smrt] ✗ vite.config.ts not found at path');
    }
  } catch (error) {
    console.log('[smrt] ✗ Error loading vite.config.ts:', error.message);
    console.log('[smrt] Stack:', error.stack);
    console.log('[smrt] Using default baseClasses');
  }

  const scanner = new ASTScanner(sourceFiles, scannerOptions);

  const scanResults = scanner.scanFiles();
  const generator = new ManifestGenerator();
  return generator.generateManifest(scanResults);
}

runTestScanner().then(manifest => {
  // Inject package name from package.json
  try {
    const packageJsonPath = resolve(process.cwd(), 'package.json');
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    manifest.packageName = packageJson.name;
    console.log(\`[smrt] Injected package name: \${packageJson.name}\`);
  } catch (error) {
    console.warn('[smrt] Warning: Could not read package.json, packageName will be undefined');
  }

  mkdirSync('src/manifest', { recursive: true });
  writeFileSync('src/manifest/test-manifest.json', JSON.stringify(manifest, null, 2));

  const tsContent = \`/**
 * Test manifest stub
 * This file is replaced by generate-test-manifest.js during pretest
 * If tests run without pretest, this empty manifest is used
 *
 * DO NOT EDIT MANUALLY - This file is automatically generated
 */

import type { SmartObjectManifest } from '../scanner/types';

export const testManifest: SmartObjectManifest = \${JSON.stringify(manifest, null, 2)} as const;

export default testManifest;
\`;
  writeFileSync('src/manifest/test-manifest-stub.ts', tsContent);

  const objectCount = Object.keys(manifest.objects).length;
  console.log(\`[smrt] ✅ Generated test manifest with \${objectCount} object(s)\`);
}).catch(console.error);
`;

    // Write and execute the TypeScript code
    writeFileSync('temp-test-manifest-gen.ts', tsCode);

    try {
      execSync('npx tsx temp-test-manifest-gen.ts', { stdio: 'inherit' });
    } finally {
      // Clean up
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
