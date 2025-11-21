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
    args: ['[pattern...]'],
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
    handler: async (args: string[], options: any) => {
      console.log('\n🧪 Generating test manifest...\n');

      try {
        // Import scanner and manifest generator
        const { ASTScanner, ManifestGenerator } = await import(
          '@happyvertical/smrt-core/scanner'
        );
        const fg = await import('fast-glob');
        const { writeFileSync, mkdirSync } = await import('node:fs');

        // Scan source files (including test files for packages that define fixtures there)
        const testFiles = fg.default.sync(
          [
            'src/**/*.ts', // Include all source files for SMRT object definitions
          ],
          {
            absolute: true,
            ignore: ['src/**/*.d.ts', 'node_modules/**', 'dist/**', 'build/**'],
          },
        );

        if (testFiles.length === 0) {
          console.log('⚠️  No test files found');
          console.log('\nSearched for: src/**/*.ts');
          return;
        }

        console.log(`📄 Scanning ${testFiles.length} file(s)...\n`);

        // Discover base classes from external SMRT packages
        const { discoverBaseClasses } = await import(
          '@happyvertical/smrt-core/manifest/discover-base-classes'
        );

        const baseClasses = await discoverBaseClasses();

        console.log(
          `[smrt test] Discovered ${baseClasses.length} base classes (including ${baseClasses.length - 3} from external packages)`,
        );

        // Scan files for SMRT objects
        const scanner = new ASTScanner(testFiles, {
          baseClasses,
          includePrivateMethods: false,
          includeStaticMethods: true,
          followImports: true,
        });

        const scanResults = scanner.scanFiles();

        // Read package.json for package name
        let packageName: string | undefined;
        try {
          const pkgPath = resolve(process.cwd(), 'package.json');
          const pkgContent = await readFile(pkgPath, 'utf-8');
          const pkg = JSON.parse(pkgContent);
          packageName = pkg.name || undefined;
        } catch {
          console.warn('⚠️  Could not read package.json');
        }

        // Discover external SMRT packages for field inheritance
        console.log('[smrt test] Discovering external SMRT packages...');
        const { discoverSmrtPackages } = await import(
          '@happyvertical/smrt-core/manifest/discover-smrt-packages'
        );
        const smrtDependencies = discoverSmrtPackages();

        if (smrtDependencies.length > 0) {
          console.log(
            `[smrt test] Found ${smrtDependencies.length} external SMRT package(s): ${smrtDependencies.join(', ')}`,
          );
        } else {
          console.log('[smrt test] No external SMRT packages found');
        }

        // Generate manifest - first pass without external dependencies
        const generator = new ManifestGenerator();
        const manifest = generator.generateManifest(scanResults, {
          packageName,
        });

        // Add smrtDependencies to manifest
        if (smrtDependencies.length > 0) {
          manifest.smrtDependencies = smrtDependencies;

          // Re-run field inheritance merging now that we have external dependencies
          console.log(
            '[smrt test] Re-merging fields with external package support...',
          );
          (generator as any).mergeInheritedFields(manifest);
        }

        console.log(
          `[MANIFEST] Generated manifest with ${Object.keys(manifest.objects).length} objects`,
        );
        console.log(
          `[MANIFEST] Objects:`,
          Object.keys(manifest.objects).join(', '),
        );

        // Create output directory
        const outputDir = resolve(
          process.cwd(),
          options.output || 'src/manifest',
        );
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

            // Run vitest with forwarded arguments (file patterns)
            const vitestArgs = ['vitest', 'run', ...args];
            const proc = spawn('npx', vitestArgs, {
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

  'db:setup': {
    name: 'db:setup',
    description: 'Initialize database schema for all registered SMRT objects',
    aliases: ['db-setup', 'setup-db'],
    args: [],
    options: {
      drop: {
        type: 'boolean',
        description: 'Drop existing tables before creating (destructive)',
        default: false,
      },
      'dry-run': {
        type: 'boolean',
        description: 'Show SQL DDL without executing',
        default: false,
      },
      verbose: {
        type: 'boolean',
        description: 'Show detailed output',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔍 Discovering SMRT objects...\n');

      try {
        // 1. Load CLI config
        const { getPackageConfig } = await import('@happyvertical/smrt-config');
        const { DEFAULT_CLI_CONFIG } = await import('../config.js');
        const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

        // 2. Validate database configuration
        if (!config.database?.url || config.database.url === ':memory:') {
          console.error('❌ Database configuration required for db:setup');
          console.error('\nPlease configure database in smrt.config.js:');
          console.error('\n  export default {');
          console.error('    packages: {');
          console.error('      cli: {');
          console.error('        database: {');
          console.error("          type: 'sqlite',");
          console.error("          url: './dev.db'");
          console.error('        }');
          console.error('      }');
          console.error('    }');
          console.error('  }\n');
          process.exit(1);
        }

        const dbUrl = config.database.url;
        const dbType = config.database.type || 'sqlite';

        if (options.verbose) {
          console.log(`Database type: ${dbType}`);
          console.log(`Database URL:  ${dbUrl}\n`);
        }

        // 3. Auto-discover and load manifests
        const { discovered, totalObjects } = await autoDiscoverAndLoad();

        if (discovered.length === 0) {
          console.error('❌ No SMRT manifests found');
          console.error('\nTo generate a manifest:');
          console.error('  1. Build your project with SMRT objects');
          console.error('  2. Or run: smrt test (generates test manifest)\n');
          process.exit(1);
        }

        console.log(
          `✓ Found ${totalObjects} object(s) in ${discovered.length} manifest(s)\n`,
        );

        // 4. Get initialization order (topological sort respecting FK dependencies)
        const initOrder = ObjectRegistry.getInitializationOrder();

        if (options.verbose) {
          console.log('📋 Initialization order (respecting dependencies):');
          for (let i = 0; i < initOrder.length; i++) {
            const className = initOrder[i];
            const inheritanceChain =
              ObjectRegistry.getInheritanceChain(className);
            const chain =
              inheritanceChain.length > 1
                ? ` → ${inheritanceChain.slice(0, -1).join(' → ')}`
                : '';
            console.log(`  ${i + 1}. ${className}${chain}`);
          }
          console.log();
        }

        // 5. Dry-run mode: Show SQL without executing
        if (options.dryRun) {
          console.log('📋 SQL Preview (not executed):\n');

          const { generateSchema } = await import(
            '@happyvertical/smrt-core/schema/utils'
          );

          for (const className of initOrder) {
            const registered = ObjectRegistry.getClass(className);
            if (!registered) continue;

            const tableStrategy = ObjectRegistry.getTableStrategy(className);
            const stiBase = ObjectRegistry.getSTIBase(className);

            // Skip STI children (they share the base class table)
            if (tableStrategy === 'sti' && stiBase && stiBase !== className) {
              console.log(
                `-- Table: ${className} (Base: ${stiBase}, Strategy: STI)`,
              );
              console.log(`-- Shares table with ${stiBase} (STI child)\n`);
              continue;
            }

            const schema = await generateSchema(registered.constructor);
            if (schema && schema.trim() !== '') {
              const tableName = ObjectRegistry.getTableName(className);
              const strategy = tableStrategy === 'sti' ? 'STI' : 'CTI';
              console.log(
                `-- Table: ${tableName} (Class: ${className}, Strategy: ${strategy})`,
              );
              console.log(schema);
              console.log();
            }
          }

          console.log('✅ Dry-run complete (no changes made)\n');
          return;
        }

        // 6. Create database connection
        console.log('🗄️  Connecting to database...\n');

        const { getDatabase } = await import('@happyvertical/sql');
        const db = await getDatabase({ type: dbType, url: dbUrl });

        console.log(`✓ Connected to ${dbType}://${dbUrl}\n`);

        // 7. Drop tables if requested
        if (options.drop) {
          console.log(
            '⚠️  WARNING: --drop will DELETE ALL DATA in existing tables',
          );

          // In non-interactive mode, fail fast
          if (!config.interactive) {
            console.error('❌ Cannot use --drop in non-interactive mode');
            console.error(
              '   Set interactive: true in config or run without --drop\n',
            );
            process.exit(1);
          }

          // Prompt for confirmation
          const readline = await import('node:readline/promises');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await rl.question('Continue? (y/N): ');
          rl.close();

          if (answer.toLowerCase() !== 'y' && answer.toLowerCase() !== 'yes') {
            console.log('\n❌ Cancelled by user\n');
            process.exit(0);
          }

          console.log('\n🗑️  Dropping existing tables...\n');

          // Drop in reverse order (children before parents)
          const dropOrder = [...initOrder].reverse();

          for (const className of dropOrder) {
            const tableName = ObjectRegistry.getTableName(className);
            if (!tableName) continue;

            try {
              await db.execute`DROP TABLE IF EXISTS ${tableName}`;
              console.log(`  ✓ Dropped ${tableName}`);
            } catch (error) {
              if (options.verbose) {
                console.log(`  ⚠️  Could not drop ${tableName}: ${error}`);
              }
            }
          }

          console.log();
        }

        // 8. Create tables
        console.log('🔨 Creating tables...\n');

        const { ensureSchema } = await import(
          '@happyvertical/smrt-core/schema/utils'
        );

        let tablesCreated = 0;
        let tablesSkipped = 0;

        for (const className of initOrder) {
          try {
            const tableStrategy = ObjectRegistry.getTableStrategy(className);
            const stiBase = ObjectRegistry.getSTIBase(className);

            // Skip STI children (schema already created by base class)
            if (tableStrategy === 'sti' && stiBase && stiBase !== className) {
              tablesSkipped++;
              if (options.verbose) {
                console.log(`  ⊙ ${className} (shares table with ${stiBase})`);
              }
              continue;
            }

            await ensureSchema(db, className);

            const tableName = ObjectRegistry.getTableName(className);
            const fields = ObjectRegistry.getFields(className);
            const fieldCount = fields?.size || 0;

            console.log(`  ✓ ${tableName} (${fieldCount} columns)`);
            tablesCreated++;
          } catch (error) {
            console.error(`  ✗ ${className}: ${error}`);
            if (options.verbose && error instanceof Error && error.stack) {
              console.error(`\n${error.stack}\n`);
            }
          }
        }

        // 9. Report summary
        console.log();
        if (tablesSkipped > 0) {
          console.log(
            `  (${tablesSkipped} STI child class(es) share parent tables)`,
          );
          console.log();
        }
        console.log(`✅ Successfully initialized ${tablesCreated} table(s)\n`);

        console.log('💡 Next steps:');
        console.log('  - Your SMRT objects are ready to use!');
        console.log('  - Run: smrt introspect (view discovered objects)');
        console.log();
      } catch (error) {
        console.error('\n❌ Database setup failed:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
          if (options.verbose && error.stack) {
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
