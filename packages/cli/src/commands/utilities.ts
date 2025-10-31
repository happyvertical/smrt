/**
 * Utility CLI Commands
 *
 * Commands for introspection, testing, and project management
 */

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';

/**
 * Utility commands for CLI
 */
export const utilityCommands: Record<string, CLICommand> = {
  introspect: {
    name: 'introspect',
    description: 'Analyze project and discover SMRT objects',
    aliases: ['inspect', 'info'],
    args: [],
    options: {
      verbose: {
        type: 'boolean',
        description: 'Show detailed information',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔍 Introspecting SMRT project...\n');

      // Auto-discover manifests
      const { discovered, totalObjects } = await autoDiscoverAndLoad();

      if (discovered.length === 0) {
        console.log('⚠️  No SMRT manifests found in project or node_modules');
        console.log('\nTo generate a manifest:');
        console.log('  1. Build your project with SMRT objects');
        console.log('  2. Or run: smrt test (generates test manifest)');
        return;
      }

      console.log(`📦 Discovered ${discovered.length} manifest(s):\n`);

      for (const manifest of discovered) {
        const source =
          manifest.source === 'project' ? '📁 Project' : '📦 Package';
        const name = manifest.packageName ? ` (${manifest.packageName})` : '';
        console.log(`${source}${name}`);
        console.log(`  Path: ${manifest.path}`);
        console.log(`  Objects: ${manifest.objectCount}`);
        console.log();
      }

      console.log(`✨ Total objects discovered: ${totalObjects}\n`);

      if (options.verbose) {
        // Show registered objects
        const registeredClasses = ObjectRegistry.getAllClasses();
        if (registeredClasses.size > 0) {
          console.log('📋 Registered Objects:\n');
          for (const [className, metadata] of registeredClasses) {
            console.log(`  ${className}`);
            if (metadata.fields) {
              const fieldNames = Object.keys(metadata.fields);
              console.log(`    Fields: ${fieldNames.join(', ')}`);
            }
            console.log();
          }
        }
      }

      console.log('💡 Next steps:');
      console.log('  - Run: smrt objects (list all objects)');
      console.log('  - Run: smrt schema <object> (view object schema)');
      console.log('  - Run: smrt generate-mcp (generate MCP server)');
      console.log();
    },
  },

  test: {
    name: 'test',
    description: 'Generate test manifest and run tests',
    args: [],
    options: {
      'manifest-only': {
        type: 'boolean',
        description: "Only generate manifest, don't run tests",
        default: false,
      },
      output: {
        type: 'string',
        description: 'Output directory for test manifest',
        default: 'src/manifest',
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🧪 Generating test manifest...\n');

      try {
        // Import scanner and manifest generator
        const { ASTScanner, ManifestGenerator } = await import(
          '@happyvertical/smrt-core/scanner'
        );
        const fg = await import('fast-glob');
        const { writeFileSync, mkdirSync } = await import('node:fs');

        // Find test files
        const testFiles = fg.default.sync(
          ['src/**/*.test.ts', 'src/**/*.spec.ts'],
          {
            absolute: true,
            ignore: ['src/**/*.d.ts'],
          },
        );

        if (testFiles.length === 0) {
          console.log('⚠️  No test files found');
          console.log('\nSearched for: src/**/*.test.ts, src/**/*.spec.ts');
          return;
        }

        console.log(`📄 Scanning ${testFiles.length} test file(s)...\n`);

        // Scan files for SMRT objects
        const scanner = new ASTScanner(testFiles, {
          baseClasses: ['SmrtObject', 'SmrtClass', 'SmrtCollection'],
          includePrivateMethods: false,
          includeStaticMethods: true,
          followImports: false,
        });

        const scanResults = scanner.scanFiles();
        const generator = new ManifestGenerator();
        const manifest = generator.generateManifest(scanResults);

        // Read package.json for package name
        let packageName = 'unknown';
        try {
          const pkgPath = resolve(process.cwd(), 'package.json');
          const pkgContent = await readFile(pkgPath, 'utf-8');
          const pkg = JSON.parse(pkgContent);
          packageName = pkg.name || 'unknown';
          manifest.packageName = packageName;
        } catch {
          console.warn('⚠️  Could not read package.json');
        }

        // Create output directory
        const outputDir = resolve(process.cwd(), options.output);
        mkdirSync(outputDir, { recursive: true });

        // Write manifest.json
        const jsonPath = resolve(outputDir, 'test-manifest.json');
        writeFileSync(jsonPath, JSON.stringify(manifest, null, 2));

        // Write TypeScript stub
        const tsContent = `/**
 * Test manifest stub
 * This file is generated by \`smrt test\`
 *
 * DO NOT EDIT MANUALLY - This file is automatically generated
 */

import type { SmartObjectManifest } from '@happyvertical/smrt-core/scanner';

export const testManifest: SmartObjectManifest = ${JSON.stringify(manifest, null, 2)} as const;

export default testManifest;
`;
        const tsPath = resolve(outputDir, 'test-manifest-stub.ts');
        writeFileSync(tsPath, tsContent);

        const objectCount = Object.keys(manifest.objects).length;
        console.log(
          `✅ Generated test manifest with ${objectCount} test object(s)`,
        );
        console.log(`   JSON: ${jsonPath}`);
        console.log(`   TS:   ${tsPath}\n`);

        // Run tests if requested
        if (!options.manifestOnly) {
          console.log('🧪 Running tests...\n');

          const { spawn } = await import('node:child_process');

          // Check if vitest is available
          try {
            const { access } = await import('node:fs/promises');
            await access(resolve(process.cwd(), 'node_modules/.bin/vitest'));

            // Run vitest
            const proc = spawn('npx', ['vitest', 'run'], {
              stdio: 'inherit',
              shell: true,
            });

            await new Promise<void>((resolve, reject) => {
              proc.on('close', (code) => {
                if (code === 0) {
                  resolve();
                } else {
                  reject(new Error(`Tests failed with code ${code}`));
                }
              });
              proc.on('error', reject);
            });
          } catch {
            console.log('⚠️  Vitest not found, skipping test execution');
            console.log('   Install with: npm install -D vitest');
          }
        }

        console.log('\n💡 Next steps:');
        console.log('  - Run: smrt introspect (view discovered objects)');
        console.log();
      } catch (error) {
        console.error('❌ Failed to generate test manifest:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
          if (error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
          }
        } else {
          console.error(error);
        }
        process.exit(1);
      }
    },
  },
};
