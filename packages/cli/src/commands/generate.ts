/**
 * Code Generation CLI Commands
 *
 * Commands for generating code, types, and other artifacts.
 * Includes generate-types, generate-mcp, generate-routes, and generate-register commands.
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
              const defObj = def as Record<string, unknown>;
              mergedObjects[name] = {
                ...defObj,
                // Ensure packageName is set for external packages
                packageName: defObj.packageName || manifestInfo.packageName,
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

  'generate-register': {
    name: 'generate-register',
    description:
      'Generate .smrt/register.js from discovered external SMRT packages',
    aliases: ['register', 'generate:register'],
    args: [],
    options: {
      'output-path': {
        type: 'string',
        description: 'Output path for register file',
        default: '.smrt/register.js',
        short: 'o',
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔍 Discovering external SMRT packages...\n');

      try {
        // Auto-discover manifests
        const { discovered } = await autoDiscoverAndLoad();

        // Filter to only external packages (not project manifests)
        const externalPackages = discovered.filter(
          (m) => m.source === 'package' && m.packageName,
        );

        if (externalPackages.length === 0) {
          console.warn('⚠️ No external SMRT packages found');
          console.warn('\nTo use this command:');
          console.warn('  1. Install a package with SMRT objects');
          console.warn('  2. Make sure the package has been built');
          console.warn('  3. The package must include a manifest.json\n');
          return;
        }

        console.log(`✓ Found ${externalPackages.length} external package(s)\n`);

        // Build imports and registrations from external packages
        const imports: string[] = [];
        const registrations: string[] = [];
        let externalObjectCount = 0;
        const packageSummary: Record<string, number> = {};

        // Track seen objects to deduplicate across packages.
        // When packages re-export classes from dependencies, the same object
        // appears in multiple manifests via enrichManifest() merging.
        const seenQualifiedNames = new Set<string>();
        const seenExportNames = new Set<string>();

        for (const manifestInfo of externalPackages) {
          const manifestData = await loadManifestFile(manifestInfo.path);
          if (!manifestData?.objects) continue;

          // packageName is guaranteed to exist due to filter above
          const packageName = manifestInfo.packageName as string;
          let packageObjectCount = 0;

          for (const [objectName, objectDef] of Object.entries(
            manifestData.objects,
          )) {
            const def = objectDef as any;

            // Skip test-visibility objects (test fixtures, perf tests, etc.)
            if (def.visibility === 'test') continue;

            // Deduplicate by qualifiedName (e.g. @happyvertical/smrt-profiles:Profile)
            const dedupeKey =
              def.qualifiedName ||
              `${packageName}:${def.className || objectName}`;
            if (seenQualifiedNames.has(dedupeKey)) continue;
            seenQualifiedNames.add(dedupeKey);

            // Deduplicate by exportName to prevent JS identifier collisions
            const exportName = def.exportName || def.name || objectName;
            if (seenExportNames.has(exportName)) continue;
            seenExportNames.add(exportName);

            // Check if collection export name is already taken by another object.
            // Only skip collection registration, not the object itself.
            const collectionExportName = def.collectionExportName;
            const skipCollection =
              collectionExportName && seenExportNames.has(collectionExportName);
            if (collectionExportName && !skipCollection) {
              seenExportNames.add(collectionExportName);
            }

            // Import from the object's canonical package, not the current manifest package
            const importPath = def.importPath || def.packageName || packageName;
            const hasCollection = def.hasCollection && !skipCollection;
            const tableName = def.collection || objectName.toLowerCase();
            const registrationName =
              def.className || objectName.split(':').pop() || objectName;
            const registrationPackageName = def.packageName || packageName;
            const isCollectionClass = def.extends === 'SmrtCollection';

            // Generate import statement
            if (hasCollection && collectionExportName) {
              imports.push(
                `import { ${exportName}, ${collectionExportName} } from '${importPath}';`,
              );
            } else {
              imports.push(`import { ${exportName} } from '${importPath}';`);
            }

            if (isCollectionClass) {
              externalObjectCount++;
              packageObjectCount++;
              continue;
            }

            // Generate registration calls. Keep the class name and package name
            // separate so ObjectRegistry can use package-aware collision policy.
            const registrationOptions = [
              `name: ${JSON.stringify(registrationName)}`,
              `packageName: ${JSON.stringify(registrationPackageName)}`,
            ].join(', ');
            registrations.push(
              `ObjectRegistry.register(${exportName}, { ${registrationOptions} });`,
            );

            if (hasCollection && collectionExportName) {
              registrations.push(
                `ObjectRegistry.registerCollection('${tableName}', ${collectionExportName});`,
              );
            }

            externalObjectCount++;
            packageObjectCount++;
          }

          packageSummary[packageName] = packageObjectCount;
        }

        if (externalObjectCount === 0) {
          console.warn('⚠️ No external objects found in any package');
          return;
        }

        // Generate file content
        const content = `/**
 * Auto-generated by smrt generate-register
 * DO NOT EDIT - This file is regenerated on every run
 *
 * Registers SMRT objects from external packages for CLI discovery.
 * Generated at: ${new Date().toISOString()}
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';

${imports.join('\n')}

// Register all objects (executed during module evaluation)
${registrations.join('\n')}

export function registerAll() {
  // Objects are already registered during module evaluation
  console.log('[smrt:register] Registered ${externalObjectCount} external objects');
}
`;

        // Write the file
        const { writeFile, mkdir } = await import('node:fs/promises');
        const { dirname, resolve } = await import('node:path');

        const outputPath = options['output-path'] || '.smrt/register.js';
        const fullPath = resolve(process.cwd(), outputPath);
        const dir = dirname(fullPath);

        // Create directory if needed
        await mkdir(dir, { recursive: true });

        // Write registration file
        await writeFile(fullPath, content, 'utf-8');

        // Report results
        console.log(
          `✅ Generated ${outputPath} with ${externalObjectCount} external objects\n`,
        );
        console.log('📦 Packages included:');
        for (const [pkg, count] of Object.entries(packageSummary)) {
          console.log(`   - ${pkg} (${count} objects)`);
        }
        console.log();

        console.log('💡 Next steps:');
        console.log(
          '  1. CLI commands for external packages are now available',
        );
        console.log('  2. Run: smrt help  (to see available commands)');
        console.log();
      } catch (error) {
        throw new Error(
          `Failed to generate register file: ${error instanceof Error ? error.message : 'Unknown error'}`,
        );
      }
    },
  },
};
