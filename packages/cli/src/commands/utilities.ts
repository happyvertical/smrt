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

      // Read package.json to get package name
      let packageName = 'unknown';
      try {
        const pkgPath = resolve(process.cwd(), 'package.json');
        const pkgContent = await readFile(pkgPath, 'utf-8');
        const pkg = JSON.parse(pkgContent);
        packageName = pkg.name || 'unknown';
      } catch {
        console.warn('⚠️  Could not read package.json');
      }

      // For now, point users to use the existing script approach
      console.log(
        'To generate test manifest, add a pretest script to your package.json:',
      );
      console.log('\n{');
      console.log('  "scripts": {');
      console.log('    "pretest": "node scripts/generate-test-manifest.js"');
      console.log('  }');
      console.log('}\n');
      console.log(
        'See packages/profiles/scripts/generate-test-manifest.js for example',
      );
      console.log();

      if (!options.manifestOnly) {
        console.log('🧪 Running tests...\n');

        // Import and run test command
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
    },
  },
};
