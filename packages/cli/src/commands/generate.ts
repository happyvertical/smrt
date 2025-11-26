/**
 * Code Generation CLI Commands
 *
 * Commands for generating code, types, and other artifacts.
 * Includes generate-types, generate-mcp, and generate-routes commands.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import { MCPGenerator } from '@happyvertical/smrt-core/generators';
import { generateDeclarationsFromCLI } from '@happyvertical/smrt-core/prebuild';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad, loadManifestFile } from '../discovery/index.js';

/**
 * Code generation commands for CLI
 */
export const generateCommands: Record<string, CLICommand> = {
  'generate-types': {
    name: 'generate-types',
    description: 'Generate TypeScript declarations from SMRT manifest',
    aliases: ['generate-declarations'],
    args: ['manifest-path'],
    options: {
      'output-dir': {
        type: 'string',
        description: 'Output directory for generated types',
      },
    },
    handler: async (args: string[], options: any) => {
      const manifestPath = args[0];
      if (!manifestPath) {
        throw new Error(
          'Manifest path is required: smrt generate-types <manifest-path> [output-dir]',
        );
      }

      const outputDir = options['output-dir'] || args[1];

      try {
        const cliArgs = outputDir ? [manifestPath, outputDir] : [manifestPath];
        await generateDeclarationsFromCLI(cliArgs);
      } catch (error) {
        throw new Error(
          `Failed to generate types: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  },

  'generate-mcp': {
    name: 'generate-mcp',
    description: 'Generate MCP server from registered SMRT objects',
    aliases: ['generate-mcp-server', 'mcp'],
    args: [],
    options: {
      'output-path': {
        type: 'string',
        description: 'Output path for MCP server file',
        default: '.smrt/mcp-server/index.js',
      },
      name: {
        type: 'string',
        description: 'Server name',
      },
      version: {
        type: 'string',
        description: 'Server version',
        default: '1.0.0',
      },
      modular: {
        type: 'boolean',
        description:
          'Generate modular directory structure (tools/, handlers/, config.ts)',
        default: false,
      },
      debug: {
        type: 'boolean',
        description: 'Enable debug logging in generated server',
        default: false,
      },
      'no-config': {
        type: 'boolean',
        description: 'Skip Claude Desktop configuration example',
        default: false,
      },
      'no-readme': {
        type: 'boolean',
        description: 'Skip README documentation',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        // Get registered SMRT objects
        const registeredClasses = ObjectRegistry.getAllClasses();

        if (registeredClasses.size === 0) {
          console.warn(
            '⚠️ No SMRT objects found. Make sure your objects are registered with @smrt() decorator.',
          );
          console.warn(
            '   The MCP server will be generated but will have no tools.',
          );
        }

        // Determine server name from package.json or use default
        let serverName = options.name;
        if (!serverName) {
          try {
            const { readFile } = await import('node:fs/promises');
            const { resolve } = await import('node:path');
            const packageJson = JSON.parse(
              await readFile(resolve(process.cwd(), 'package.json'), 'utf-8'),
            );
            serverName = packageJson.name || 'smrt-mcp-server';
          } catch {
            serverName = 'smrt-mcp-server';
          }
        }

        // Create MCP generator
        const generator = new MCPGenerator({
          name: serverName,
          version: options.version,
          description: 'Auto-generated MCP server from SMRT objects',
        });

        console.log(`\n🔨 Generating MCP server...`);
        console.log(`   Server name: ${serverName}`);
        console.log(`   Output path: ${options['output-path']}`);
        console.log(`   Modular structure: ${options.modular ? 'yes' : 'no'}`);
        console.log(`   Registered objects: ${registeredClasses.size}`);

        // Generate server
        await generator.generateServer({
          outputPath: options['output-path'],
          serverName,
          serverVersion: options.version,
          debug: options.debug,
          generateClaudeConfigFile: !options['no-config'],
          generateReadme: !options['no-readme'],
          modular: options.modular,
        });

        console.log(`\n✅ MCP server generated successfully!`);
        console.log(`\n📝 Next steps:`);
        console.log(
          `   1. Add MCP server to your Claude Desktop configuration`,
        );
        console.log(`   2. Restart Claude Desktop`);
        console.log(`   3. Start using the auto-generated tools\n`);
      } catch (error) {
        throw new Error(
          `Failed to generate MCP server: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  },

  'generate-routes': {
    name: 'generate-routes',
    description: 'Generate SvelteKit API routes from SMRT objects',
    aliases: ['routes', 'generate:routes'],
    args: [],
    options: {
      'routes-dir': {
        type: 'string',
        description: 'Output directory for generated routes',
        default: 'src/routes/api',
        short: 'r',
      },
      'objects-dir': {
        type: 'string',
        description: 'Directory containing SMRT objects',
        default: 'src/lib/objects',
        short: 'o',
      },
      'config-path': {
        type: 'string',
        description: 'Directory for SMRT configuration',
        default: 'src/lib/server',
        short: 'c',
      },
      'config-file': {
        type: 'string',
        description: 'Configuration file name',
        default: 'smrt.ts',
      },
      force: {
        type: 'boolean',
        description: 'Overwrite existing configuration files',
        default: false,
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔍 Discovering SMRT objects...\n');

      try {
        // Auto-discover manifests
        const { discovered, totalObjects } = await autoDiscoverAndLoad();

        if (discovered.length === 0) {
          console.error('❌ No SMRT manifests found');
          console.error('\nTo generate a manifest:');
          console.error('  1. Build your project with SMRT objects');
          console.error('  2. Or run: smrt test (generates test manifest)');
          console.error('  3. Install a package with SMRT objects\n');
          process.exit(1);
        }

        console.log(
          `✓ Found ${totalObjects} object(s) in ${discovered.length} manifest(s)\n`,
        );

        // Load ALL discovered manifests and merge their objects
        console.log('📦 Loading manifests:');
        const mergedObjects: Record<string, any> = {};

        for (const manifestInfo of discovered) {
          const manifestData = await loadManifestFile(manifestInfo.path);
          if (manifestData?.objects) {
            const objectCount = Object.keys(manifestData.objects).length;
            const source = manifestInfo.packageName || 'project';
            console.log(`   ${source}: ${objectCount} object(s)`);

            // Merge objects, adding packageName if from external package
            for (const [name, def] of Object.entries(manifestData.objects)) {
              mergedObjects[name] = {
                ...def,
                // Ensure packageName is set for external packages
                packageName:
                  (def as any).packageName || manifestInfo.packageName,
              };
            }
          }
        }
        console.log();

        if (Object.keys(mergedObjects).length === 0) {
          console.error('❌ No SMRT objects found in any manifest');
          process.exit(1);
        }

        // Create merged manifest
        const manifest = {
          version: '1.0.0',
          timestamp: Date.now(),
          objects: mergedObjects,
        };

        // Import the SvelteKit route generator
        const { generateSvelteKitRoutes } = await import(
          '@happyvertical/smrt-core/vite-plugin'
        );

        const projectRoot = process.cwd();

        // Extract options with kebab-case keys (matching option definitions)
        const routesDir = options['routes-dir'] || 'src/routes/api';
        const objectsDir = options['objects-dir'] || 'src/lib/objects';
        const configPath = options['config-path'] || 'src/lib/server';
        const configFile = options['config-file'] || 'smrt.ts';

        console.log('🔨 Generating SvelteKit routes...');
        console.log(`   Routes directory: ${routesDir}`);
        console.log(`   Objects directory: ${objectsDir}`);
        console.log(`   Config path: ${configPath}`);
        console.log();

        // Generate routes
        await generateSvelteKitRoutes(projectRoot, manifest, {
          enabled: true,
          routesDir,
          objectsDir,
          configPath,
          configFileName: configFile,
        });

        // Report results
        const objectCount = Object.keys(manifest.objects).length;
        const objectNames = Object.keys(manifest.objects).join(', ');

        console.log(`\n✅ Generated routes for ${objectCount} object(s):`);
        console.log(`   ${objectNames}\n`);

        console.log('📁 Generated structure:');
        console.log(`   ${routesDir}/`);
        for (const objectDef of Object.values(manifest.objects)) {
          const collection = (objectDef as any).collection;
          console.log(`     ${collection}/+server.ts     (list, create)`);
          console.log(
            `     ${collection}/[id]/+server.ts (get, update, delete)`,
          );
        }
        console.log();

        console.log('💡 Next steps:');
        console.log('  1. Review generated routes in src/routes/api/');
        console.log('  2. Configure src/lib/server/smrt.ts with your database');
        console.log('  3. Run: npm run dev');
        console.log();
      } catch (error) {
        throw new Error(
          `Failed to generate routes: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  },
};
