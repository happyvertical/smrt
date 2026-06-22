/**
 * Utility CLI Commands
 *
 * Commands for introspection, testing, and project management
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  generateDDLForEngine,
  isQualifiedName,
  ObjectRegistry,
  SchemaComparer,
} from '@happyvertical/smrt-core';
import type {
  MigrationDefinition,
  MigrationResult,
} from '@happyvertical/smrt-core/migrations';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import { configExportCommand } from './config-export.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';
import { dbDiffCommand } from './db-diff.js';
import { dbGenerateCommand } from './db-generate.js';
import { dbHistoryCommand } from './db-history.js';
import {
  getSyntheticMigrationNameForAction,
  type MigrationAction,
  partitionSchemaChanges,
  type SchemaChangeLike,
  shouldApplySchemaMigrations,
  shouldFailDbMigrate,
} from './db-migrate-actions.js';
import { dbMigrateUuidCommand } from './db-migrate-uuid.js';
import { dbRollbackCommand } from './db-rollback.js';
import { dbStatusCommand } from './db-status.js';
import { devKnowledgeCommands } from './dev-knowledge.js';
import { exportCommand } from './export.js';
import {
  runRuntimeCheckSafely,
  runtimeCheckCommand,
} from './runtime-check-command.js';
import {
  assertNoUnsupportedMigrationFiles,
  assertSchemaContract,
  evaluateSchemaContract,
  SchemaContractError,
  UnsupportedFileMigrationsError,
  UnsupportedMigrationModeError,
} from './schema-contract.js';
import {
  repairStiDiscriminatorRows,
  resolveStiDiscriminatorUpgrade,
  type StiDiscriminatorRepairConflict,
} from './sti-upgrade.js';

function formatSchemaCommandFailureHeader(
  error: unknown,
  fallback: string,
): string {
  if (error instanceof SchemaContractError) {
    return '\n❌ Schema contract failed:';
  }

  if (error instanceof UnsupportedFileMigrationsError) {
    return '\n❌ File-backed migrations are not supported:';
  }

  if (error instanceof UnsupportedMigrationModeError) {
    return '\n❌ Unsupported SMRT migration mode:';
  }

  return fallback;
}

interface SchemaMigrationLogInfo {
  successMessage: string;
  skippedMessage?: string;
}

function migrationErrorMessage(error: MigrationResult['error']): string {
  if (!error) {
    return 'migration failed';
  }

  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function migrationResultFailure(
  results: MigrationResult[],
): MigrationResult | undefined {
  return (
    results.find((result) => !result.success && !result.rolled_back) ??
    results.find((result) => !result.success)
  );
}

function migrationResultError(result: MigrationResult): Error {
  const cause = result.error instanceof Error ? result.error : undefined;
  return new Error(`${result.name}: ${migrationErrorMessage(result.error)}`, {
    cause,
  });
}

type DDLPreviewEngine = 'sqlite' | 'duckdb' | 'json' | 'postgres';

export function resolveVitestEntrypoint(fromDir = process.cwd()): string {
  const requireFromDir = createRequire(resolve(fromDir, 'package.json'));
  const vitestPackageJson = requireFromDir.resolve('vitest/package.json');
  return join(dirname(vitestPackageJson), 'vitest.mjs');
}

function resolveDDLPreviewEngine(dbType: string): DDLPreviewEngine {
  switch (dbType) {
    case 'json':
      return 'json';
    case 'duckdb':
      return 'duckdb';
    case 'postgres':
    case 'postgresql':
    case 'pg':
      return 'postgres';
    default:
      return 'sqlite';
  }
}

/**
 * Quote a SQL identifier (table name, column name, etc.)
 * Uses double quotes which is ANSI SQL standard and works across SQLite, PostgreSQL, and DuckDB
 */
function quoteIdentifier(name: string): string {
  // Escape any double quotes in the identifier by doubling them
  return `"${name.replace(/"/g, '""')}"`;
}

function formatStiConflictIdentity(
  conflict: StiDiscriminatorRepairConflict,
): string {
  const entries = Object.entries(conflict.conflictIdentity);
  const identity =
    entries.length > 0
      ? entries
          .map(([column, value]) => `${column}=${JSON.stringify(value)}`)
          .join(', ')
      : 'no non-_meta_type conflict columns';
  const ids =
    conflict.legacyId || conflict.qualifiedId
      ? ` (legacy id: ${conflict.legacyId ?? 'unknown'}, qualified id: ${conflict.qualifiedId ?? 'unknown'})`
      : '';

  return `${identity}${ids}`;
}

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
          for (const [_key, metadata] of registeredClasses) {
            // Issue #951: Use simple name, not qualified map key
            console.log(`  ${metadata.name || _key}`);
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
    description:
      '[DEPRECATED] Generate test manifest and run tests - use pnpm exec vitest instead',
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
      // Show deprecation warning
      console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║  ⚠️  DEPRECATED: 'smrt test' is deprecated                            ║
╠═══════════════════════════════════════════════════════════════════════╣
║  The vitest plugin now generates manifests automatically.             ║
║                                                                       ║
║  Instead, just run:                                                   ║
║    pnpm exec vitest                                                   ║
║    pnpm exec vitest run                                               ║
║    pnpm test                                                          ║
║                                                                       ║
║  Make sure vitest.config.ts includes:                                 ║
║    import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';     ║
║    plugins: [smrtVitestPlugin()]                                      ║
╚═══════════════════════════════════════════════════════════════════════╝
      `);

      console.log('🧪 Generating test manifest...\n');

      try {
        // Import ManifestBuilder (uses OXC scanner internally)
        const { ManifestBuilder } = await import(
          '@happyvertical/smrt-core/manifest'
        );

        // Discover base classes from external SMRT packages
        const { discoverBaseClasses } = await import(
          '@happyvertical/smrt-core/manifest/discover-base-classes'
        );

        const baseClasses = await discoverBaseClasses();

        console.log(
          `[smrt test] Discovered ${baseClasses.length} base classes (including ${baseClasses.length - 3} from external packages)`,
        );

        // Generate test manifest using ManifestBuilder with OXC scanner
        const builder = new ManifestBuilder();
        const manifest = await builder.generate({
          // File discovery
          include: ['src/**/*.ts'],
          exclude: ['src/**/*.d.ts', 'node_modules/**', 'dist/**', 'build/**'],

          // Scanner configuration
          baseClasses,
          followImports: true,
          loadViteConfig: true,
          discoverExternalPackages: true,
          includeExternalBaseClasses: true,
          includePrivateMethods: false,
          includeStaticMethods: true,

          // Output configuration
          outputDir: options.output || 'src/manifest',
          outputName: 'test-manifest.json',
          generateTypeStub: true,
          stubName: 'test-manifest-stub.ts',

          // Metadata
          injectPackageInfo: true,
          moduleType: 'smrt',
        });

        console.log(
          `[MANIFEST] Generated manifest with ${Object.keys(manifest.objects).length} objects`,
        );
        console.log(
          `[MANIFEST] Objects:`,
          Object.keys(manifest.objects).join(', '),
        );

        // Legacy compatibility: Still write to requested output directory if specified
        // But the primary manifest is now in .smrt/manifest.json (via ManifestManager)
        const outputDir = resolve(
          process.cwd(),
          options.output || 'src/manifest',
        );
        mkdirSync(outputDir, { recursive: true });

        // Write manifest.json to legacy location
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
        console.log(`   Unified: .smrt/manifest.json`);
        console.log(`   Legacy:  ${jsonPath}`);
        console.log(`   TS:      ${tsPath}\n`);

        // Run tests if requested
        if (!options.manifestOnly) {
          console.log('🧪 Running tests...\n');

          const { spawn } = await import('node:child_process');

          // Check if vitest is available
          try {
            const vitestEntrypoint = resolveVitestEntrypoint();

            // Run vitest with forwarded arguments (file patterns)
            const vitestArgs = [vitestEntrypoint, 'run', ...args];
            const proc = spawn(process.execPath, vitestArgs, {
              stdio: 'inherit',
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
    description:
      '[DEPRECATED] Use db:migrate instead. Initialize database schema for all registered SMRT objects',
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
      console.warn(
        '\n⚠️  db:setup is deprecated. Use "smrt db:migrate" instead.\n' +
          '   db:migrate now creates new tables automatically.\n' +
          '   db:setup will be removed in a future version.\n',
      );
      console.log('🔍 Discovering SMRT objects...\n');

      let db: any;

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

        await assertNoUnsupportedMigrationFiles(config);

        if (options.verbose) {
          console.log(`Database type: ${dbType}`);
          console.log(
            `Database URL:  ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
          );
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

        assertSchemaContract(
          await evaluateSchemaContract({
            discovered,
            schemaContract: config.schemaContract,
          }),
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
        if (options['dry-run']) {
          console.log('📋 SQL Preview (not executed):\n');

          const { generateSchema } = await import(
            '@happyvertical/smrt-core/schema/utils'
          );

          for (const className of initOrder) {
            const registered = ObjectRegistry.getClass(className);
            if (!registered) continue;

            const tableStrategy = ObjectRegistry.getTableStrategy(className);
            const stiBase = ObjectRegistry.getSTIBase(className);

            // R5-canon: `getSTIBase` returns the qualified name; compare
            // against the qualified form so an STI base isn't
            // mis-classified as a child.
            const qualifiedClassName =
              registered.qualifiedName ?? registered.name ?? className;
            const isSTIChild =
              tableStrategy === 'sti' &&
              !!stiBase &&
              stiBase !== qualifiedClassName &&
              stiBase !== className;
            if (isSTIChild) {
              console.log(
                `-- Table: ${className} (Base: ${stiBase}, Strategy: STI)`,
              );
              console.log(`-- Shares table with ${stiBase} (STI child)\n`);
              continue;
            }

            const schema = await generateSchema(
              registered.constructor,
              undefined,
              { engine: resolveDDLPreviewEngine(dbType) },
            );
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
        db = await getDatabase({ type: dbType, url: dbUrl });

        console.log(
          `✓ Connected to ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
        );

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
            process.exitCode = 1;
            return;
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
            return;
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
            // R5-canon: qualified-to-qualified STI-child detection.
            const registered = ObjectRegistry.getClass(className);
            const qualifiedClassName =
              registered?.qualifiedName ?? registered?.name ?? className;

            // Skip STI children (schema already created by base class)
            if (
              tableStrategy === 'sti' &&
              stiBase &&
              stiBase !== qualifiedClassName &&
              stiBase !== className
            ) {
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
        console.error(
          formatSchemaCommandFailureHeader(
            error,
            '\n❌ Database setup failed:',
          ),
        );
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
          if (options.verbose && error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
          }
        } else {
          console.error(error);
        }
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'db:clear-cache': {
    name: 'db:clear-cache',
    description:
      'Clear cached database connections (useful when JSON files change)',
    aliases: ['clear-cache'],
    args: [],
    options: {
      verbose: {
        type: 'boolean',
        description: 'Show detailed output',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        const { clearConnectionCache } = await import('@happyvertical/sql');
        clearConnectionCache();

        console.log('\n✅ Database connection cache cleared');
        console.log(
          '   Next database operation will create fresh connections\n',
        );

        if (options.verbose) {
          console.log('💡 This is useful when:');
          console.log('   - JSON data files have been modified');
          console.log('   - Schema has changed and you need fresh connections');
          console.log('   - Debugging connection/schema issues\n');
        }
      } catch (error) {
        console.error('❌ Failed to clear cache:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
        process.exit(1);
      }
    },
  },

  'db:validate': {
    name: 'db:validate',
    description: 'Validate JSON database integrity against manifest schema',
    aliases: ['json:validate', 'validate-db'],
    args: [],
    options: {
      data: {
        type: 'string',
        description: 'Path to data directory (auto-detected if not provided)',
        short: 'd',
      },
      quick: {
        type: 'boolean',
        description:
          'Quick validation (structure and types only, skip FK checks)',
        default: false,
        short: 'q',
      },
      json: {
        type: 'boolean',
        description: 'Output results as JSON (for CI integration)',
        default: false,
      },
      verbose: {
        type: 'boolean',
        description: 'Show detailed validation information',
        default: false,
        short: 'v',
      },
      fix: {
        type: 'boolean',
        description:
          'Attempt to fix correctable issues (e.g., missing defaults)',
        default: false,
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      const startTime = Date.now();

      try {
        const {
          resolveDataPath,
          discoverJsonFiles,
          JsonDatabaseValidator,
          displayValidationResults,
        } = await import('./json-validator.js');

        // 1. Resolve data path
        const dataPath = await resolveDataPath(options.data);

        if (!dataPath) {
          console.error('\n❌ Could not find data directory');
          console.error('\nPlease specify the data path:');
          console.error('  smrt db:validate --data ./data');
          console.error('\nOr configure it in smrt.config.js:');
          console.error('  database: { type: "json", url: "./data" }');
          process.exit(1);
        }

        if (!options.json) {
          console.log('\n🔍 Validating JSON database...\n');
          console.log(`  Data path: ${dataPath}`);
        }

        // 2. Auto-discover manifests
        const { discovered, totalObjects } = await autoDiscoverAndLoad();

        if (discovered.length === 0 && !options.json) {
          console.log('\n⚠️  No SMRT manifests found - generating...');

          // Generate manifest on the fly using ManifestBuilder (with OXC scanner)
          try {
            const { ManifestBuilder } = await import(
              '@happyvertical/smrt-core/manifest'
            );
            const { discoverBaseClasses } = await import(
              '@happyvertical/smrt-core/manifest/discover-base-classes'
            );

            const baseClasses = await discoverBaseClasses();
            const builder = new ManifestBuilder();

            await builder.generate({
              include: ['src/**/*.ts'],
              exclude: ['src/**/*.d.ts', 'node_modules/**', 'dist/**'],
              baseClasses,
              followImports: true,
              discoverExternalPackages: true,
              includePrivateMethods: false,
              includeStaticMethods: true,
              outputDir: 'src/manifest',
              outputName: 'manifest.json',
              injectPackageInfo: true,
            });

            console.log('  ✓ Generated manifest from source files');
          } catch (err) {
            if (!options.json) {
              console.warn('  ⚠️  Could not generate manifest:', err);
            }
          }
        } else if (!options.json) {
          console.log(`  Manifest: ${totalObjects} object(s) discovered`);
        }

        // 3. Discover JSON files
        const jsonFiles = await discoverJsonFiles(dataPath);

        if (jsonFiles.length === 0) {
          if (options.json) {
            console.log(
              JSON.stringify(
                {
                  timestamp: new Date().toISOString(),
                  dataPath,
                  manifestPath: null,
                  duration: Date.now() - startTime,
                  totalFiles: 0,
                  totalRecords: 0,
                  validRecords: 0,
                  invalidRecords: 0,
                  issues: { errors: 0, warnings: 1, info: 0 },
                  objectResults: [],
                },
                null,
                2,
              ),
            );
          } else {
            console.log('\n⚠️  No JSON data files found in', dataPath);
            console.log(
              '   Looking for: *.json (excluding schema/config files)\n',
            );
          }
          return;
        }

        if (!options.json) {
          console.log(`  Files: ${jsonFiles.length} JSON file(s)\n`);
        }

        // 4. Create validator and run
        const validator = new JsonDatabaseValidator({
          dataPath,
          quickMode: options.quick || false,
          verbose: options.verbose || false,
        });

        const results = await validator.validate(jsonFiles);

        // 5. Apply fixes if requested
        if (options.fix && results.fixableIssues.length > 0) {
          const fixedCount = await validator.applyFixes(results.fixableIssues);
          if (!options.json && fixedCount > 0) {
            console.log(`  🔧 Fixed ${fixedCount} issue(s)\n`);
          }
        }

        // 6. Generate and display summary
        const manifestPath = discovered.length > 0 ? discovered[0].path : null;
        const summary = validator.generateSummary(
          results,
          Date.now() - startTime,
          manifestPath,
        );

        if (options.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          displayValidationResults(summary, options.verbose || false);
        }

        // 7. Exit with appropriate code
        if (summary.issues.errors > 0) {
          process.exit(1);
        }
      } catch (error) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                timestamp: new Date().toISOString(),
                error: error instanceof Error ? error.message : String(error),
                duration: Date.now() - startTime,
              },
              null,
              2,
            ),
          );
        } else {
          console.error('\n❌ Validation failed:');
          if (error instanceof Error) {
            console.error(`   ${error.message}`);
            if (options.verbose && error.stack) {
              console.error('\nStack trace:');
              console.error(error.stack);
            }
          } else {
            console.error(error);
          }
        }
        process.exit(1);
      }
    },
  },

  'db:migrate': {
    name: 'db:migrate',
    description:
      'Synchronize database schema with registered SMRT objects (add missing columns/indexes)',
    aliases: ['migrate', 'db-migrate'],
    args: [],
    options: {
      'dry-run': {
        type: 'boolean',
        description: 'Show SQL changes without executing',
        default: false,
      },
      'postgres-safe': {
        type: 'boolean',
        description:
          'Use PostgreSQL-safe operations (CONCURRENTLY for indexes, lock_timeout)',
        default: false,
      },
      force: {
        type: 'boolean',
        description:
          'Force re-apply even if already applied (skip checksum validation)',
        default: false,
      },
      'repair-data': {
        type: 'boolean',
        description:
          'Apply safe data repairs after schema migrations (currently legacy STI discriminator rows)',
        default: false,
      },
      'upgrade-sti': {
        type: 'boolean',
        description: '[Deprecated] Use --repair-data instead',
        default: false,
      },
      'drop-indexes': {
        type: 'boolean',
        description:
          'Drop orphan indexes (in DB but not in manifest, excluding *_pkey/*_key implicit-from-constraint indexes). Off by default.',
        default: false,
      },
      verbose: {
        type: 'boolean',
        description: 'Show detailed output',
        default: false,
        short: 'v',
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔄 Migrating database schema...\n');

      let db: any;

      try {
        // 1. Load CLI config
        const { getPackageConfig } = await import('@happyvertical/smrt-config');
        const { DEFAULT_CLI_CONFIG } = await import('../config.js');
        const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

        // 2. Validate database configuration
        if (!config.database?.url || config.database.url === ':memory:') {
          console.error('❌ Database configuration required for db:migrate');
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

        await assertNoUnsupportedMigrationFiles(config);

        if (options.verbose) {
          console.log(`Database type: ${dbType}`);
          console.log(
            `Database URL:  ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
          );
        }

        // 3. Check for JSON adapter (limited support)
        // Note: JSON adapter type may not be in strict config types but could be used
        if ((dbType as string) === 'json') {
          console.log('⚠️  JSON adapter has limited migration support');
          console.log(
            '   JSON databases infer schema from data, not DDL statements.',
          );
          console.log(
            '   New columns will be available automatically when data is written.\n',
          );
          console.log('💡 To sync schema, consider:');
          console.log('   - Re-exporting data with updated schema');
          console.log('   - Using smrt db:validate --fix to check integrity\n');
          return;
        }

        // 4. Auto-discover and load manifests
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

        assertSchemaContract(
          await evaluateSchemaContract({
            discovered,
            schemaContract: config.schemaContract,
          }),
        );

        // 5. Get initialization order (topological sort respecting FK dependencies)
        const initOrder = ObjectRegistry.getInitializationOrder();

        // 6. Get all merged schemas as SchemaDefinition objects
        // This format is compatible with SchemaComparer for proper diff detection
        const manifestSchemas = ObjectRegistry.getAllSchemasAsDefinitions();

        if (options.verbose) {
          console.log('📋 Tables to check (in dependency order):');
          for (let i = 0; i < initOrder.length; i++) {
            const className = initOrder[i];
            const tableName = ObjectRegistry.getTableName(className);
            const tableStrategy = ObjectRegistry.getTableStrategy(className);
            const stiBase = ObjectRegistry.getSTIBase(className);
            // R5-canon: qualified-to-qualified STI-child detection.
            const registered = ObjectRegistry.getClass(className);
            const qualifiedClassName =
              registered?.qualifiedName ?? registered?.name ?? className;

            if (
              tableStrategy === 'sti' &&
              stiBase &&
              stiBase !== qualifiedClassName &&
              stiBase !== className
            ) {
              console.log(
                `  ${i + 1}. ${className} → ${tableName} (STI child of ${stiBase})`,
              );
            } else {
              console.log(`  ${i + 1}. ${className} → ${tableName}`);
            }
          }
          console.log();
        }

        // 7. Connect to database
        console.log('🗄️  Connecting to database...\n');

        const { getDatabase } = await import('@happyvertical/sql');
        db = await getDatabase({ type: dbType, url: dbUrl });

        // Check if adapter supports schema introspection
        if (!db.getTableSchema || !db.alterTable) {
          console.error(
            `❌ Database adapter '${dbType}' does not support schema migration`,
          );
          console.error('   Required methods: getTableSchema, alterTable');
          console.error('\n   Supported adapters: sqlite, postgres, duckdb\n');
          process.exitCode = 1;
          return;
        }

        console.log(
          `✓ Connected to ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
        );

        // 7.5. Initialize MigrationTracker for tracking applied migrations
        const { MigrationTracker, shortChecksum } = await import(
          '@happyvertical/smrt-core/migrations'
        );

        const tracker = new MigrationTracker({
          db,
          useConcurrentIndexes: options['postgres-safe'] ?? false,
        });
        await tracker.initialize();

        if (options.verbose) {
          const engine = tracker.getEngine();
          console.log(`Migration tracker initialized (engine: ${engine})`);
          if (options['postgres-safe'] && engine === 'postgres') {
            console.log(
              'PostgreSQL-safe mode enabled (CONCURRENTLY, lock_timeout)',
            );
          }
          console.log();
        }

        // 8. Compare schemas using SchemaComparer
        // This uses the same comparison logic as core (including equivalent index detection)
        const migrations: MigrationAction[] = [];
        const manualInterventions: MigrationAction[] = [];
        const tableErrorCount = 0;
        const isDryRun = options['dry-run'] ?? false;
        const applySchemaMigrations = shouldApplySchemaMigrations({
          dryRun: isDryRun,
        });
        const repairData = Boolean(
          options['repair-data'] || options['upgrade-sti'],
        );

        if (options['upgrade-sti']) {
          console.warn(
            '⚠️  --upgrade-sti is deprecated and will be removed in a future release.',
          );
          console.warn('   Use --repair-data instead.\n');
        }

        console.log('🔍 Comparing schemas...\n');

        // Use SchemaComparer from core for consistent schema diff. The
        // same-name shape drift detection is always on (unblocks issue
        // #1165 automatically); orphan-index drops are gated behind
        // --drop-indexes for safety.
        const comparer = new SchemaComparer(db, {
          includeDroppedIndexes: Boolean(options['drop-indexes']),
        });
        const diff = await comparer.compare(manifestSchemas);

        // Helper to get class name for a table (for reporting)
        const getClassForTable = (tableName: string): string => {
          for (const className of initOrder) {
            if (ObjectRegistry.getTableName(className) === tableName) {
              return className;
            }
          }
          return tableName;
        };

        // Preview new tables that don't exist yet. Actual schema changes are
        // applied below in one transaction with the generated migrations.
        if (diff.added_tables.length > 0 && isDryRun) {
          for (const schema of diff.added_tables) {
            const className = getClassForTable(schema.tableName);

            const fields = Object.keys(schema.columns).length;
            console.log(
              `  📦 ${schema.tableName} (${className}): Would create table (${fields} columns)`,
            );
            if (options.verbose && schema.ddl) {
              console.log(`     ${schema.ddl}`);
            }
          }

          console.log();
        }

        // Convert SchemaDiff changes to CLI MigrationAction format.
        const partitionedChanges = partitionSchemaChanges(
          diff.changes as SchemaChangeLike[],
          getClassForTable,
        );
        migrations.push(...partitionedChanges.migrations);
        manualInterventions.push(...partitionedChanges.manualInterventions);

        console.log();

        // 9. Report non-executable drift that still needs manual intervention
        if (manualInterventions.length > 0) {
          console.log(
            '⚠️  Schema drift detected that requires manual intervention:\n',
          );
          for (const change of manualInterventions) {
            if (!change.mismatch) continue;

            const detail =
              change.type === 'type_upgrade'
                ? `${change.tableName}.${change.mismatch.column}: expected ${change.mismatch.expected}, found ${change.mismatch.actual} (cannot auto-apply on this database engine)`
                : `${change.tableName}.${change.mismatch.column}: expected ${change.mismatch.expected}, found ${change.mismatch.actual}`;

            console.log(`   ${detail}`);
          }
          console.log();
          console.log(
            '   Manual migration required (backup, recreate, restore as needed).\n',
          );
        }

        // 10. Handle no migrations needed
        const tablesCreated = diff.added_tables.length > 0;
        const schemaUpToDate =
          migrations.length === 0 &&
          manualInterventions.length === 0 &&
          !tablesCreated;

        // 11. Preview or execute migrations
        // Note: SQL statements come from SchemaComparer via change.sql
        if (isDryRun) {
          if (schemaUpToDate && !repairData) {
            console.log(
              '✅ Database schema is up to date - no migrations needed\n',
            );
            return;
          }

          if (schemaUpToDate) {
            console.log(
              '✅ Database schema is up to date - no schema migrations needed\n',
            );
          } else {
            console.log('📋 Migration Preview (not executed):\n');

            const columnMigrations = migrations.filter(
              (m) => m.type === 'add_column',
            );
            const indexMigrations = migrations.filter(
              (m) => m.type === 'add_index',
            );
            const indexDrops = migrations.filter(
              (m) => m.type === 'drop_index',
            );

            if (columnMigrations.length > 0) {
              console.log(`  📊 Columns to add: ${columnMigrations.length}`);
              for (const m of columnMigrations) {
                console.log(
                  `     ${m.tableName}.${m.column?.name} (${m.column?.type})`,
                );
              }
              console.log();
            }

            if (indexDrops.length > 0) {
              // Drops are listed before adds because that's the execution
              // order (a shape-drift recreate emits drop+add for the same
              // name; the drop must precede the add).
              console.log(`  🗑️  Indexes to drop: ${indexDrops.length}`);
              for (const m of indexDrops) {
                console.log(`     ${m.indexName} on ${m.tableName}`);
              }
              console.log();
            }

            if (indexMigrations.length > 0) {
              console.log(`  🗂️  Indexes to add: ${indexMigrations.length}`);
              for (const m of indexMigrations) {
                console.log(`     ${m.index?.name} on ${m.tableName}`);
              }
              console.log();
            }

            console.log('  SQL Statements:\n');
            for (const m of migrations) {
              const sqlStatements = m.sqlStatements ?? (m.sql ? [m.sql] : []);
              for (const sql of sqlStatements) {
                console.log(`    ${sql};`);
              }
            }
            console.log();
          }

          if (!repairData) {
            console.log('✅ Dry-run complete (no changes made)');
            console.log('   Run without --dry-run to apply migrations\n');
            return;
          }
          // Data repair also supports dry-run mode, so continue into that
          // section after previewing schema changes.
        }

        // 13. Execute migrations with tracking
        let successCount = 0;
        let skippedCount = 0;
        let errorCount = 0;
        let stiErrorCount = 0;

        const schemaChangeCount = diff.added_tables.length + migrations.length;

        // Only show migration execution header if there are schema changes to apply
        if (applySchemaMigrations && schemaChangeCount > 0) {
          console.log(
            `🔨 Applying ${schemaChangeCount} schema change(s) atomically...\n`,
          );
        }

        if (applySchemaMigrations && schemaChangeCount > 0) {
          const migrationDefs: MigrationDefinition[] = [];
          const migrationLogs = new Map<string, SchemaMigrationLogInfo>();
          const engine = tracker.getEngine();

          for (const schema of diff.added_tables) {
            const ddl = generateDDLForEngine(schema, engine);
            const createTableSql = ddl.createTable || schema.ddl;
            if (!createTableSql?.trim()) {
              throw new Error(
                `Cannot create table ${schema.tableName}: schema definition has no generated DDL.`,
              );
            }

            const migrationName = `create_table_${schema.tableName}`;
            const fields = Object.keys(schema.columns).length;

            migrationDefs.push({
              id: migrationName,
              description: `Create table ${schema.tableName}`,
              version: '1.0.0',
              up: [createTableSql, ...ddl.indexes, ...ddl.triggers],
              down: [`DROP TABLE IF EXISTS "${schema.tableName}"`],
            });
            migrationLogs.set(migrationName, {
              successMessage: `Created table ${schema.tableName} (${fields} columns)`,
            });
          }

          for (const migration of migrations) {
            const migrationName = getSyntheticMigrationNameForAction(migration);
            if (!migrationName) {
              continue;
            }

            let migrationSql: string;
            let actionDesc: string;

            if (migration.type === 'add_column' && migration.column) {
              migrationSql = migration.sql || '';
              actionDesc = `Added column ${migration.tableName}.${migration.column.name}`;
            } else if (migration.type === 'type_upgrade' && migration.column) {
              migrationSql = migration.sql || '';
              actionDesc = `Upgraded column ${migration.tableName}.${migration.column.name} from ${migration.mismatch?.actual} to ${migration.mismatch?.expected}`;
            } else if (migration.type === 'add_index' && migration.index) {
              migrationSql = migration.sql || '';
              actionDesc = `Created index ${migration.index.name} on ${migration.tableName}`;
            } else if (migration.type === 'drop_index' && migration.indexName) {
              migrationSql = migration.sql || '';
              actionDesc = `Dropped index ${migration.indexName} on ${migration.tableName}`;
            } else {
              continue;
            }

            const migrationSqlStatements =
              migration.sqlStatements ?? (migrationSql ? [migrationSql] : []);

            migrationDefs.push({
              id: migrationName,
              description:
                migration.type === 'add_column'
                  ? `Add column ${migration.column?.name} to ${migration.tableName}`
                  : migration.type === 'type_upgrade'
                    ? `Upgrade column ${migration.column?.name} on ${migration.tableName} from ${migration.mismatch?.actual} to ${migration.mismatch?.expected}`
                    : migration.type === 'drop_index'
                      ? `Drop index ${migration.indexName} on ${migration.tableName}`
                      : `Add index ${migration.index?.name} on ${migration.tableName}`,
              version: '1.0.0',
              // Auto-migrations don't carry a DOWN script. Atomic execution
              // rolls back the surrounding transaction instead of relying on
              // per-migration DOWN SQL.
              up: migrationSqlStatements,
              down: [],
            });
            migrationLogs.set(migrationName, {
              successMessage: actionDesc,
              skippedMessage: `${migrationName} already applied`,
            });
          }

          if (
            options['postgres-safe'] &&
            engine === 'postgres' &&
            migrations.some(
              (migration) =>
                migration.type === 'add_index' ||
                migration.type === 'drop_index',
            )
          ) {
            console.warn(
              '⚠️  --postgres-safe requested, but db:migrate applies generated schema changes atomically.',
            );
            console.warn(
              '   Index DDL in this batch will run without CONCURRENTLY so PostgreSQL can roll back the full batch on failure.\n',
            );
          }

          try {
            const results = await tracker.applyAll(migrationDefs, {
              atomic: true,
              postgresSafe: false,
              force: options.force ?? false,
              // The diff was computed from the live schema moments earlier, so
              // missing columns/indexes must be repaired even if a previous
              // synthetic migration record says "completed".
              reconcile: true,
              onProgress: (result) => {
                if (!result.success) {
                  return;
                }

                const logInfo = migrationLogs.get(result.name);
                const checksum = shortChecksum(result.checksum);
                if (result.execution_time_ms === 0 || result.skipped) {
                  if (options.verbose) {
                    console.log(
                      `  ⊙ ${logInfo?.skippedMessage ?? result.name} (${checksum})`,
                    );
                  }
                  return;
                }

                console.log(
                  `  ✓ ${logInfo?.successMessage ?? result.name} (${checksum})`,
                );
              },
            });

            const failed = migrationResultFailure(results);
            if (failed) {
              throw migrationResultError(failed);
            }

            successCount += results.filter(
              (result) =>
                result.success &&
                result.applied !== false &&
                result.execution_time_ms !== 0,
            ).length;
            skippedCount += results.filter(
              (result) =>
                result.success &&
                (result.skipped ||
                  result.applied === false ||
                  result.execution_time_ms === 0),
            ).length;
          } catch (error) {
            errorCount++;
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(`  ✗ atomic schema migration failed: ${errorMsg}`);
            // Show underlying database error if available
            if (
              error instanceof Error &&
              'context' in error &&
              (error as any).context?.originalError
            ) {
              console.error(
                `     Cause: ${(error as any).context.originalError}`,
              );
            }
            if (options.verbose && error instanceof Error && error.stack) {
              console.error(`\n${error.stack}\n`);
            }
            console.error(
              '     Rolled back all schema changes from this migration batch, including any successful steps shown above.',
            );
          }
        }

        if (schemaUpToDate && !repairData) {
          console.log(
            '✅ Database schema is up to date - no migrations needed\n',
          );
        }

        // 13.5 Handle safe data repair requested via --repair-data
        if (repairData) {
          console.log(
            '\n🔄 Repairing STI discriminators to qualified names...\n',
          );

          // Get unique table names from initialization order
          const allTableNames = new Set<string>();
          for (const className of initOrder) {
            const tableName = ObjectRegistry.getTableName(className);
            if (tableName) {
              allTableNames.add(tableName);
            }
          }

          // Find all STI tables (tables with _meta_type column)
          const stiTables: string[] = [];
          for (const tableName of allTableNames) {
            const schema = await db.getTableSchema(tableName);
            if (schema?.columns._meta_type) {
              stiTables.push(tableName);
            }
          }

          if (stiTables.length === 0) {
            console.log(
              '  No STI tables found - skipping discriminator repair\n',
            );
          } else {
            if (options.verbose) {
              console.log(
                `  Found ${stiTables.length} STI table(s): ${stiTables.join(', ')}\n`,
              );
            }

            let stiSuccessCount = 0;
            let stiSkippedCount = 0;
            stiErrorCount = 0;

            for (const tableName of stiTables) {
              // Get distinct _meta_type values that are NOT qualified
              const result = await db.query(
                `SELECT DISTINCT _meta_type FROM ${quoteIdentifier(tableName)} WHERE _meta_type IS NOT NULL`,
              );

              for (const row of result.rows) {
                const metaType = row._meta_type as string;

                const resolution = resolveStiDiscriminatorUpgrade(metaType);

                if (resolution.action === 'skip') {
                  if (resolution.reason === 'ambiguous' && !options.verbose) {
                    console.warn(
                      `  ⚠ ${tableName}._meta_type="${metaType}" matches multiple registered classes; leaving it unchanged.`,
                    );
                  }

                  if (options.verbose) {
                    const detail =
                      resolution.reason === 'already-current'
                        ? 'already current'
                        : resolution.reason === 'ambiguous'
                          ? 'ambiguous class name'
                          : resolution.reason === 'unregistered'
                            ? isQualifiedName(metaType)
                              ? 'qualified type not registered'
                              : 'class not found in registry'
                            : 'class has no qualified name';
                    console.log(
                      `  ⊙ ${tableName}._meta_type="${metaType}" (${detail})`,
                    );
                  }
                  stiSkippedCount++;
                  continue;
                }

                try {
                  const repair = await repairStiDiscriminatorRows({
                    db,
                    tableName,
                    className: resolution.className,
                    legacyMetaType: metaType,
                    qualifiedMetaType: resolution.currentQualifiedName,
                    dryRun: isDryRun,
                  });

                  if (repair.conflicts.length > 0) {
                    console.error(
                      `  ✗ ${tableName}: "${metaType}" → "${repair.qualifiedMetaType}" blocked by ${repair.conflicts.length} duplicate row(s)`,
                    );
                    for (const conflict of repair.conflicts) {
                      console.error(
                        `     ${formatStiConflictIdentity(conflict)}`,
                      );
                    }
                    stiErrorCount += repair.conflicts.length;
                  }

                  if (isDryRun) {
                    if (repair.wouldUpdateRows > 0) {
                      console.log(
                        `  [DRY RUN] ${tableName}: "${metaType}" → "${repair.qualifiedMetaType}" (${repair.wouldUpdateRows} row(s) would be updated by id)`,
                      );
                      stiSuccessCount += repair.wouldUpdateRows;
                    } else if (repair.conflicts.length === 0) {
                      stiSkippedCount++;
                    }
                    continue;
                  }

                  if (repair.updatedRows > 0) {
                    console.log(
                      `  ✓ ${tableName}: "${metaType}" → "${repair.qualifiedMetaType}" (${repair.updatedRows} row(s))`,
                    );
                    stiSuccessCount += repair.updatedRows;
                  } else if (repair.conflicts.length === 0) {
                    stiSkippedCount++;
                  }
                } catch (error: any) {
                  const qualifiedName = resolution.currentQualifiedName;
                  const errorMsg =
                    error instanceof Error ? error.message : String(error);
                  const originalError = error?.context?.originalError;
                  console.error(
                    `  ✗ ${tableName}: "${metaType}" → "${qualifiedName}" failed: ${originalError || errorMsg}`,
                  );
                  stiErrorCount++;
                }
              }
            }

            console.log();
            if (stiErrorCount > 0) {
              console.log(
                `⚠️  STI repair completed with errors: ${stiSuccessCount} row(s) repaired, ${stiErrorCount} conflict/error(s)`,
              );
              if (stiSkippedCount > 0) {
                console.log(
                  `   (${stiSkippedCount} already qualified or skipped)`,
                );
              }
            } else if (stiSuccessCount === 0) {
              console.log(
                `✅ All STI discriminators already qualified (${stiSkippedCount} checked)\n`,
              );
            } else {
              console.log(
                `✅ Successfully repaired ${stiSuccessCount} STI discriminator row(s)`,
              );
              if (stiSkippedCount > 0) {
                console.log(
                  `   (${stiSkippedCount} already qualified or skipped)`,
                );
              }
            }
          }
        }

        // 14. Report summary (only for schema migrations, not data repairs)
        // Data repairs have their own summary printed above.
        if (
          applySchemaMigrations &&
          (schemaChangeCount > 0 || errorCount > 0 || skippedCount > 0)
        ) {
          console.log();
          if (errorCount > 0) {
            console.log(
              `⚠️  Migration completed with errors: ${successCount} succeeded, ${errorCount} failed`,
            );
            process.exitCode = 1;
            if (skippedCount > 0) {
              console.log(`   (${skippedCount} already applied, skipped)`);
            }
            console.log();
          } else if (successCount === 0 && skippedCount > 0) {
            console.log(
              `✅ All ${skippedCount} migration(s) already applied\n`,
            );
          } else if (successCount > 0) {
            console.log(`✅ Successfully applied ${successCount} migration(s)`);
            if (skippedCount > 0) {
              console.log(`   (${skippedCount} already applied, skipped)`);
            }
            console.log();
          } else {
            // Edge case: migrations exist but none matched expected types
            console.log(
              'ℹ️  No schema migrations were applied (none matched expected types)\n',
            );
          }
        }

        if (
          shouldFailDbMigrate({
            manualInterventionCount: manualInterventions.length,
            tableErrorCount,
            migrationErrorCount: errorCount,
            stiErrorCount,
            dryRun: isDryRun,
          })
        ) {
          process.exitCode = 1;
        }

        if (!isDryRun) {
          assertSchemaContract(
            await evaluateSchemaContract({
              discovered,
              schemaContract: config.schemaContract,
              db,
            }),
          );
        }

        console.log('💡 Next steps:');
        console.log('  - Run: smrt db:status (view migration status)');
        console.log('  - Run: smrt db:history (view migration history)');
        console.log('  - Run: smrt db:validate (verify database integrity)');
        console.log();
      } catch (error) {
        console.error(
          formatSchemaCommandFailureHeader(error, '\n❌ Migration failed:'),
        );
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
          const ctx = (error as any).context;
          if (ctx) {
            if (ctx.originalError) {
              console.error(`   Database error: ${ctx.originalError}`);
            }
            if (ctx.sql) {
              console.error(`   Failed SQL: ${ctx.sql}`);
            }
          }
          if (options.verbose && error.stack) {
            console.error('\nStack trace:');
            console.error(error.stack);
          }
        } else {
          console.error(error);
        }
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  doctor: {
    name: 'doctor',
    description: 'Diagnose and report on SMRT project health',
    aliases: ['check', 'diagnose'],
    args: [],
    options: {
      fix: {
        type: 'boolean',
        description: 'Attempt to fix issues automatically',
        default: false,
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      const { existsSync, readFileSync } = await import('node:fs');
      const { resolve, join } = await import('node:path');

      console.log('\n🩺 SMRT Doctor - Project Health Check\n');

      const cwd = process.cwd();
      const issues: string[] = [];
      const warnings: string[] = [];
      const passed: string[] = [];

      // Helper to check a condition
      const check = (
        name: string,
        condition: boolean,
        issue?: string,
        warning?: string,
      ) => {
        if (condition) {
          passed.push(name);
          console.log(`  ✅ ${name}`);
        } else if (warning) {
          warnings.push(`${name}: ${warning}`);
          console.log(`  ⚠️  ${name}: ${warning}`);
        } else {
          issues.push(`${name}: ${issue || 'Check failed'}`);
          console.log(`  ❌ ${name}: ${issue || 'Check failed'}`);
        }
      };

      // ========== Project Structure ==========
      console.log('📁 Project Structure\n');

      // 1. Check package.json
      const packageJsonPath = resolve(cwd, 'package.json');
      const hasPackageJson = existsSync(packageJsonPath);
      check('package.json exists', hasPackageJson, 'Missing package.json');

      let packageJson: any = {};
      if (hasPackageJson) {
        try {
          packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
          check('package.json is valid JSON', true);
        } catch {
          check('package.json is valid JSON', false, 'Invalid JSON format');
        }
      }

      // 2. Check for SMRT core dependency
      const hasSmrtCore =
        packageJson.dependencies?.['@happyvertical/smrt-core'] ||
        packageJson.devDependencies?.['@happyvertical/smrt-core'];
      check(
        '@happyvertical/smrt-core installed',
        hasSmrtCore,
        'Missing dependency - run: npm install @happyvertical/smrt-core',
      );

      // 3. Check for SvelteKit
      const hasSvelteKit =
        packageJson.dependencies?.['@sveltejs/kit'] ||
        packageJson.devDependencies?.['@sveltejs/kit'];
      if (hasSvelteKit) {
        check('SvelteKit detected', true);
      } else {
        check(
          'SvelteKit detected',
          false,
          undefined,
          'Not a SvelteKit project (optional)',
        );
      }

      console.log();

      const hasPublishSurface =
        packageJson.private !== true &&
        (typeof packageJson.main === 'string' ||
          typeof packageJson.module === 'string' ||
          typeof packageJson.svelte === 'string' ||
          typeof packageJson.types === 'string' ||
          (packageJson.exports &&
            typeof packageJson.exports === 'object' &&
            Object.keys(packageJson.exports).length > 0));

      if (hasPublishSurface) {
        console.log('📦 Publish Artifacts\n');

        const packedExportVerifierPath = fileURLToPath(
          new URL(
            '../../scripts/verify-package-types-exports.js',
            import.meta.url,
          ),
        );

        if (existsSync(packedExportVerifierPath)) {
          const verificationResult = spawnSync(
            process.execPath,
            [packedExportVerifierPath, cwd],
            {
              encoding: 'utf8',
              stdio: ['ignore', 'pipe', 'pipe'],
            },
          );
          const verificationOutput = [
            verificationResult.stdout,
            verificationResult.stderr,
            verificationResult.error?.message,
          ]
            .filter((chunk): chunk is string => Boolean(chunk?.trim()))
            .join('\n')
            .trim();

          if (verificationResult.status === 0) {
            check('Packed publish artifact verification', true);
          } else {
            check(
              'Packed publish artifact verification',
              false,
              verificationOutput || 'Packed artifact validation failed',
            );
          }
        } else {
          check(
            'Packed publish artifact verification',
            false,
            undefined,
            'Pack verifier is unavailable in this SMRT CLI build',
          );
        }
        console.log();
      }

      // ========== Configuration Files ==========
      console.log('⚙️  Configuration\n');

      // 4. Check smrt.config
      const smrtConfigTs = resolve(cwd, 'smrt.config.ts');
      const smrtConfigJs = resolve(cwd, 'smrt.config.js');
      const hasSmrtConfig =
        existsSync(smrtConfigTs) || existsSync(smrtConfigJs);
      check(
        'smrt.config.ts/js exists',
        hasSmrtConfig,
        'Missing config file - run: smrt init',
      );

      // 5. Check vite.config
      const viteConfigTs = resolve(cwd, 'vite.config.ts');
      const viteConfigJs = resolve(cwd, 'vite.config.js');
      const hasViteConfig =
        existsSync(viteConfigTs) || existsSync(viteConfigJs);
      check(
        'vite.config.ts/js exists',
        hasViteConfig,
        undefined,
        'Missing vite.config (optional for non-Vite projects)',
      );

      // 6. Check vite.config contains smrtPlugin
      if (hasViteConfig) {
        const viteConfigPath = existsSync(viteConfigTs)
          ? viteConfigTs
          : viteConfigJs;
        const viteConfigContent = readFileSync(viteConfigPath, 'utf-8');
        const hasSmrtPlugin = viteConfigContent.includes('smrtPlugin');
        check(
          'smrtPlugin in vite.config',
          hasSmrtPlugin,
          'Missing smrtPlugin - add: import { smrtPlugin } from "@happyvertical/smrt-core/vite-plugin"',
        );
      }

      // 7. Check tsconfig.json for decorators
      const tsconfigPath = resolve(cwd, 'tsconfig.json');
      if (existsSync(tsconfigPath)) {
        try {
          const tsconfigContent = readFileSync(tsconfigPath, 'utf-8');
          const hasDecorators = tsconfigContent.includes(
            'experimentalDecorators',
          );
          check(
            'experimentalDecorators enabled',
            hasDecorators,
            'Add "experimentalDecorators": true to tsconfig.json',
          );
        } catch {
          check(
            'tsconfig.json readable',
            false,
            'Could not read tsconfig.json',
          );
        }
      } else {
        check(
          'tsconfig.json exists',
          false,
          undefined,
          'No tsconfig.json found (optional for JavaScript projects)',
        );
      }

      console.log();

      // ========== SMRT Objects ==========
      console.log('📦 SMRT Objects\n');

      // 8. Check for objects directory
      const objectsDir = resolve(cwd, 'src/lib/objects');
      const hasObjectsDir = existsSync(objectsDir);
      check(
        'src/lib/objects/ exists',
        hasObjectsDir,
        undefined,
        'No objects directory found - create src/lib/objects/',
      );

      // 9. Check for objects index
      if (hasObjectsDir) {
        const objectsIndex = resolve(objectsDir, 'index.ts');
        const hasObjectsIndex = existsSync(objectsIndex);
        check(
          'src/lib/objects/index.ts exists',
          hasObjectsIndex,
          'Missing objects index file',
        );
      }

      // 10. Discover manifests
      try {
        const { discovered, totalObjects } = await autoDiscoverAndLoad();
        if (discovered.length > 0) {
          check(`${totalObjects} SMRT object(s) discovered`, true);
        } else {
          check(
            'SMRT objects discovered',
            false,
            undefined,
            'No manifests found - run: npm run build',
          );
        }
      } catch {
        check(
          'SMRT objects discovered',
          false,
          undefined,
          'Could not discover manifests',
        );
      }

      const runtimeCheck = await runRuntimeCheckSafely(cwd);

      // 10.5 Check consumer registration for external SMRT packages
      const projectManifestPath = resolve(cwd, '.smrt', 'manifest.json');
      const registerPath = resolve(cwd, '.smrt', 'register.js');
      if (existsSync(projectManifestPath)) {
        try {
          const projectManifest = JSON.parse(
            readFileSync(projectManifestPath, 'utf-8'),
          );
          const smrtDependencies = (
            Array.isArray(projectManifest.smrtDependencies)
              ? projectManifest.smrtDependencies
              : []
          ).filter(
            (dependency: string) => dependency !== '@happyvertical/smrt-core',
          );

          if (smrtDependencies.length > 0) {
            const hasRegisterFile = existsSync(registerPath);
            const missingRegisterFinding = runtimeCheck.findings.find(
              (finding) => finding.code === 'missing-consumer-register',
            );

            if (hasRegisterFile || missingRegisterFinding) {
              check(
                'External SMRT registrations generated',
                hasRegisterFile,
                missingRegisterFinding?.message,
              );
            }
          }
        } catch {
          check(
            'Project manifest readable',
            false,
            undefined,
            'Could not read .smrt/manifest.json to validate external registrations',
          );
        }
      }

      console.log();

      // ========== Runtime ==========
      console.log('🏃 Runtime\n');

      const runtimeErrors = runtimeCheck.findings.filter(
        (finding) => finding.severity === 'error',
      );
      const runtimeWarnings = runtimeCheck.findings.filter(
        (finding) => finding.severity === 'warning',
      );

      if (runtimeErrors.length === 0 && runtimeWarnings.length === 0) {
        check('Runtime manifest/registry hydration', true);
      } else {
        for (const finding of runtimeErrors) {
          check(`runtime: ${finding.code}`, false, finding.message);
        }

        for (const finding of runtimeWarnings) {
          check(`runtime: ${finding.code}`, false, undefined, finding.message);
        }
      }

      console.log();

      // ========== Server Configuration ==========
      console.log('🖥️  Server\n');

      // 11. Check server smrt.ts
      const serverSmrtPath = resolve(cwd, 'src/lib/server/smrt.ts');
      const hasServerSmrt = existsSync(serverSmrtPath);
      check(
        'src/lib/server/smrt.ts exists',
        hasServerSmrt,
        'Missing server config - run: smrt init',
      );

      // 12. Check database config
      try {
        const { getPackageConfig } = await import('@happyvertical/smrt-config');
        const { DEFAULT_CLI_CONFIG } = await import('../config.js');
        const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

        if (config.database?.url && config.database.url !== ':memory:') {
          check(
            `Database configured (${config.database.type || 'sqlite'})`,
            true,
          );
        } else {
          check(
            'Database configured',
            false,
            undefined,
            'Using in-memory database - set DATABASE_URL for persistence',
          );
        }
      } catch {
        check(
          'Database configuration',
          false,
          undefined,
          'Could not read database config',
        );
      }

      // 13. Check .env file
      const envPath = resolve(cwd, '.env');
      const envExamplePath = resolve(cwd, '.env.example');
      if (existsSync(envPath)) {
        check('.env file exists', true);
      } else if (existsSync(envExamplePath)) {
        check(
          '.env file exists',
          false,
          undefined,
          '.env.example exists - copy it to .env',
        );
      } else {
        check(
          '.env file exists',
          false,
          undefined,
          'No .env file - environment variables may be needed',
        );
      }

      console.log();

      // ========== Summary ==========
      console.log('━'.repeat(50));
      console.log(`\n📊 Summary\n`);
      console.log(`   ✅ Passed:   ${passed.length}`);
      console.log(`   ⚠️  Warnings: ${warnings.length}`);
      console.log(`   ❌ Issues:   ${issues.length}`);
      console.log();

      if (issues.length > 0) {
        console.log('🔧 Issues to fix:\n');
        for (const issue of issues) {
          console.log(`   • ${issue}`);
        }
        console.log();

        if (options.fix) {
          console.log(
            '💡 Auto-fix is not yet implemented. Run suggested commands manually.\n',
          );
        }
      }

      if (warnings.length > 0 && issues.length === 0) {
        console.log('👍 Project is functional with some warnings.\n');
      }

      if (issues.length === 0 && warnings.length === 0) {
        console.log('🎉 Your SMRT project is healthy!\n');
      }

      console.log('💡 Commands to try:');
      console.log('   smrt objects      - List discovered SMRT objects');
      console.log('   smrt introspect   - Detailed project analysis');
      console.log('   smrt init         - Initialize SMRT in project');
      console.log('   smrt generate-routes - Generate API routes');
      console.log();

      // Exit with error code if there are issues
      if (issues.length > 0) {
        process.exit(1);
      }
    },
  },

  'runtime:check': runtimeCheckCommand,

  ...devKnowledgeCommands,

  // Migration status and history commands (from separate modules)
  'db:status': dbStatusCommand,
  'db:history': dbHistoryCommand,
  'db:diff': dbDiffCommand,
  'db:rollback': dbRollbackCommand,
  'db:generate': dbGenerateCommand,
  'db:migrate-uuid': dbMigrateUuidCommand,

  // Configuration commands
  'config:export': configExportCommand,

  // Data export command (for static site generation)
  export: exportCommand,
};
