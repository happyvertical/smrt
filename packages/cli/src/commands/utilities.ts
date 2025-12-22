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
 * Column definition type for migration comparison
 */
interface ColumnDef {
  type: string;
  notNull?: boolean;
  defaultValue?: any;
  unique?: boolean;
  primaryKey?: boolean;
}

/**
 * Index definition type for migration comparison
 */
interface IndexDef {
  name: string;
  columns: string[];
  unique?: boolean;
}

/**
 * Parse expected columns from a schema definition
 * Handles both DDL string parsing and columns object format
 */
function parseExpectedColumns(schema: {
  ddl: string;
  tableName: string;
  indexes?: string[];
}): Record<string, ColumnDef> {
  const columns: Record<string, ColumnDef> = {};

  // Try to extract columns from DDL using regex
  // Match: CREATE TABLE ... ( column definitions )
  const createTableMatch = schema.ddl.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(([\s\S]+?)\)(?:\s*;)?$/im,
  );

  if (!createTableMatch) {
    return columns;
  }

  const columnSection = createTableMatch[2];

  // Split by comma, but not commas inside parentheses (for CHECK constraints)
  const parts: string[] = [];
  let depth = 0;
  let current = '';

  for (const char of columnSection) {
    if (char === '(') depth++;
    else if (char === ')') depth--;

    if (char === ',' && depth === 0) {
      parts.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim()) {
    parts.push(current.trim());
  }

  for (const part of parts) {
    // Skip foreign key constraints, primary key constraints, etc.
    if (
      /^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(part)
    ) {
      continue;
    }

    // Parse column definition: "column_name" TYPE [constraints]
    // Handle both quoted and unquoted column names
    const colMatch = part.match(
      /^["']?(\w+)["']?\s+(\w+(?:\s*\([^)]+\))?)\s*(.*)?$/i,
    );

    if (colMatch) {
      const colName = colMatch[1];
      const colType = colMatch[2].toUpperCase();
      const constraints = colMatch[3] || '';

      columns[colName] = {
        type: colType,
        notNull:
          /NOT\s+NULL/i.test(constraints) || /PRIMARY\s+KEY/i.test(constraints),
        unique: /UNIQUE/i.test(constraints),
        primaryKey: /PRIMARY\s+KEY/i.test(constraints),
      };

      // Extract default value
      const defaultMatch = constraints.match(
        /DEFAULT\s+(?:'([^']*)'|(\d+(?:\.\d+)?)|(\w+))/i,
      );
      if (defaultMatch) {
        columns[colName].defaultValue =
          defaultMatch[1] ?? defaultMatch[2] ?? defaultMatch[3];
      }
    }
  }

  return columns;
}

/**
 * Parse expected indexes from a schema definition
 * Handles index SQL strings in the indexes array
 */
function parseExpectedIndexes(schema: {
  ddl: string;
  tableName: string;
  indexes?: string[];
}): IndexDef[] {
  const indexes: IndexDef[] = [];

  if (!schema.indexes || schema.indexes.length === 0) {
    return indexes;
  }

  for (const indexSQL of schema.indexes) {
    // Parse: CREATE [UNIQUE] INDEX index_name ON table_name (columns)
    const match = indexSQL.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s+ON\s+["']?\w+["']?\s*\(([^)]+)\)/i,
    );

    if (match) {
      const isUnique = !!match[1];
      const indexName = match[2];
      const columnsStr = match[3];
      const columns = columnsStr
        .split(',')
        .map((c) => c.trim().replace(/["']/g, ''));

      indexes.push({
        name: indexName,
        columns,
        unique: isUnique,
      });
    }
  }

  return indexes;
}

/**
 * Quote a SQL identifier (table name, column name, etc.)
 * Uses double quotes which is ANSI SQL standard and works across SQLite, PostgreSQL, and DuckDB
 */
function quoteIdentifier(name: string): string {
  // Escape any double quotes in the identifier by doubling them
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Normalize SQL types for comparison
 * Different databases use different type names for the same logical type
 */
function normalizeType(type: string): string {
  const upper = type.toUpperCase().trim();

  // Normalize integer types
  if (/^(INTEGER|INT|BIGINT|SMALLINT|TINYINT)$/i.test(upper)) {
    return 'INTEGER';
  }

  // Normalize text types
  if (/^(TEXT|VARCHAR|CHAR|STRING|CLOB)/i.test(upper)) {
    return 'TEXT';
  }

  // Normalize decimal/float types
  if (/^(REAL|FLOAT|DOUBLE|DECIMAL|NUMERIC|NUMBER)/i.test(upper)) {
    return 'REAL';
  }

  // Normalize boolean types
  if (/^(BOOLEAN|BOOL)/i.test(upper)) {
    return 'BOOLEAN';
  }

  // Normalize date/time types
  if (/^(DATETIME|TIMESTAMP|DATE|TIME)/i.test(upper)) {
    return 'DATETIME';
  }

  // Normalize blob types
  if (/^(BLOB|BINARY|BYTEA)/i.test(upper)) {
    return 'BLOB';
  }

  // Normalize JSON types
  if (/^(JSON|JSONB)/i.test(upper)) {
    return 'JSON';
  }

  return upper;
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

        // Generate manifest WITH external dependencies upfront
        // This ensures STI classes inherit correct tableName from external bases
        const generator = new ManifestGenerator();
        const manifest = generator.generateManifest(scanResults, {
          packageName,
          smrtDependencies:
            smrtDependencies.length > 0 ? smrtDependencies : undefined,
        });

        if (smrtDependencies.length > 0) {
          console.log(
            '[smrt test] Manifest generated with external package support',
          );
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

          // Generate manifest on the fly (like smrt test does)
          try {
            const { ASTScanner, ManifestGenerator } = await import(
              '@happyvertical/smrt-core/scanner'
            );
            const fg = await import('fast-glob');

            const sourceFiles = fg.default.sync(['src/**/*.ts'], {
              absolute: true,
              ignore: ['src/**/*.d.ts', 'node_modules/**', 'dist/**'],
            });

            if (sourceFiles.length > 0) {
              const { discoverBaseClasses } = await import(
                '@happyvertical/smrt-core/manifest/discover-base-classes'
              );
              const baseClasses = await discoverBaseClasses();

              const scanner = new ASTScanner(sourceFiles, {
                baseClasses,
                includePrivateMethods: false,
                includeStaticMethods: true,
              });

              const scanResults = scanner.scanFiles();
              const generator = new ManifestGenerator();
              generator.generateManifest(scanResults, {});

              console.log('  ✓ Generated manifest from source files');
            }
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
      verbose: {
        type: 'boolean',
        description: 'Show detailed output',
        default: false,
        short: 'v',
      },
      force: {
        type: 'boolean',
        description: 'Skip confirmation prompt for destructive operations',
        default: false,
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      console.log('\n🔄 Migrating database schema...\n');

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

        if (options.verbose) {
          console.log(`Database type: ${dbType}`);
          console.log(`Database URL:  ${dbUrl}\n`);
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

        // 5. Get initialization order (topological sort respecting FK dependencies)
        const initOrder = ObjectRegistry.getInitializationOrder();

        // 6. Get all merged schemas (handles STI column merging)
        const allSchemas = ObjectRegistry.getAllSchemas();

        if (options.verbose) {
          console.log('📋 Tables to check (in dependency order):');
          for (let i = 0; i < initOrder.length; i++) {
            const className = initOrder[i];
            const tableName = ObjectRegistry.getTableName(className);
            const tableStrategy = ObjectRegistry.getTableStrategy(className);
            const stiBase = ObjectRegistry.getSTIBase(className);

            if (tableStrategy === 'sti' && stiBase && stiBase !== className) {
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
        const db = await getDatabase({ type: dbType, url: dbUrl });

        // Check if adapter supports schema introspection
        if (!db.getTableSchema || !db.alterTable) {
          console.error(
            `❌ Database adapter '${dbType}' does not support schema migration`,
          );
          console.error('   Required methods: getTableSchema, alterTable');
          console.error('\n   Supported adapters: sqlite, postgres, duckdb\n');
          process.exit(1);
        }

        console.log(`✓ Connected to ${dbType}://${dbUrl}\n`);

        // 8. Compare schemas and collect migrations
        type MigrationAction = {
          type: 'add_column' | 'add_index' | 'type_mismatch';
          tableName: string;
          className: string;
          column?: {
            name: string;
            type: string;
            notNull?: boolean;
            defaultValue?: any;
            unique?: boolean;
          };
          index?: {
            name: string;
            columns: string[];
            unique?: boolean;
          };
          mismatch?: {
            column: string;
            expected: string;
            actual: string;
          };
          sql?: string;
        };

        const migrations: MigrationAction[] = [];
        const typeMismatches: MigrationAction[] = [];
        const tablesProcessed = new Set<string>();

        console.log('🔍 Comparing schemas...\n');

        for (const className of initOrder) {
          const tableName = ObjectRegistry.getTableName(className);
          if (!tableName) continue;

          // Skip if we've already processed this table (STI children share tables)
          if (tablesProcessed.has(tableName)) {
            if (options.verbose) {
              console.log(
                `  ⊙ ${className} → ${tableName} (already processed)`,
              );
            }
            continue;
          }
          tablesProcessed.add(tableName);

          // Get current schema from database
          const currentSchema = await db.getTableSchema(tableName);

          if (!currentSchema) {
            // Table doesn't exist - use db:setup instead
            console.log(
              `  ⚠️  ${tableName}: Table does not exist (use db:setup to create)`,
            );
            continue;
          }

          // Get expected schema (merged for STI)
          const expectedSchema = allSchemas[tableName];
          if (!expectedSchema) {
            if (options.verbose) {
              console.log(`  ⊙ ${tableName}: No schema definition found`);
            }
            continue;
          }

          // Parse expected columns from DDL or columns definition
          const expectedColumns = parseExpectedColumns(expectedSchema);

          // Compare columns
          const currentColumnNames = new Set(
            Object.keys(currentSchema.columns),
          );
          let hasChanges = false;

          for (const [colName, colDef] of Object.entries(expectedColumns)) {
            if (!currentColumnNames.has(colName)) {
              // Missing column - add migration
              migrations.push({
                type: 'add_column',
                tableName,
                className,
                column: {
                  name: colName,
                  type: colDef.type,
                  notNull: colDef.notNull,
                  defaultValue: colDef.defaultValue,
                  unique: colDef.unique,
                },
              });
              hasChanges = true;
            } else {
              // Column exists - check for type mismatch
              const currentCol = currentSchema.columns[colName];
              const normalizedExpected = normalizeType(colDef.type);
              const normalizedActual = normalizeType(currentCol.type);

              if (normalizedExpected !== normalizedActual) {
                typeMismatches.push({
                  type: 'type_mismatch',
                  tableName,
                  className,
                  mismatch: {
                    column: colName,
                    expected: colDef.type,
                    actual: currentCol.type,
                  },
                });
              }
            }
          }

          // Compare indexes
          const currentIndexNames = new Set(
            currentSchema.indexes.map((idx) => idx.name),
          );
          const expectedIndexes = parseExpectedIndexes(expectedSchema);

          for (const idx of expectedIndexes) {
            if (!currentIndexNames.has(idx.name)) {
              migrations.push({
                type: 'add_index',
                tableName,
                className,
                index: idx,
              });
              hasChanges = true;
            }
          }

          if (options.verbose) {
            if (hasChanges) {
              console.log(`  📝 ${tableName}: Changes detected`);
            } else {
              console.log(`  ✓ ${tableName}: Up to date`);
            }
          }
        }

        console.log();

        // 9. Report type mismatches (these require manual intervention)
        if (typeMismatches.length > 0) {
          console.log(
            '⚠️  Type mismatches detected (require manual intervention):\n',
          );
          for (const mm of typeMismatches) {
            if (mm.mismatch) {
              console.log(
                `   ${mm.tableName}.${mm.mismatch.column}: expected ${mm.mismatch.expected}, found ${mm.mismatch.actual}`,
              );
            }
          }
          console.log();
          console.log(
            '   Type changes require manual migration (backup, recreate, restore).\n',
          );
        }

        // 10. Handle no migrations needed
        if (migrations.length === 0) {
          console.log(
            '✅ Database schema is up to date - no migrations needed\n',
          );
          return;
        }

        // 11. Generate SQL statements for preview
        // Use proper identifier quoting for safety (ANSI SQL double quotes)
        for (const migration of migrations) {
          if (migration.type === 'add_column' && migration.column) {
            const col = migration.column;
            const parts: string[] = [quoteIdentifier(col.name), col.type];
            if (col.notNull) parts.push('NOT NULL');
            if (col.unique) parts.push('UNIQUE');
            if (col.defaultValue !== undefined) {
              const defaultVal =
                typeof col.defaultValue === 'string'
                  ? `'${col.defaultValue.replace(/'/g, "''")}'`
                  : String(col.defaultValue);
              parts.push(`DEFAULT ${defaultVal}`);
            }
            migration.sql = `ALTER TABLE ${quoteIdentifier(migration.tableName)} ADD COLUMN ${parts.join(' ')}`;
          } else if (migration.type === 'add_index' && migration.index) {
            const idx = migration.index;
            const uniqueStr = idx.unique ? 'UNIQUE ' : '';
            const quotedColumns = idx.columns
              .map((c) => quoteIdentifier(c))
              .join(', ');
            migration.sql = `CREATE ${uniqueStr}INDEX ${quoteIdentifier(idx.name)} ON ${quoteIdentifier(migration.tableName)} (${quotedColumns})`;
          }
        }

        // 12. Preview or execute migrations
        if (options.dryRun) {
          console.log('📋 Migration Preview (not executed):\n');

          const columnMigrations = migrations.filter(
            (m) => m.type === 'add_column',
          );
          const indexMigrations = migrations.filter(
            (m) => m.type === 'add_index',
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

          if (indexMigrations.length > 0) {
            console.log(`  🗂️  Indexes to add: ${indexMigrations.length}`);
            for (const m of indexMigrations) {
              console.log(`     ${m.index?.name} on ${m.tableName}`);
            }
            console.log();
          }

          console.log('  SQL Statements:\n');
          for (const m of migrations) {
            if (m.sql) {
              console.log(`    ${m.sql};`);
            }
          }
          console.log();

          console.log('✅ Dry-run complete (no changes made)');
          console.log('   Run without --dry-run to apply migrations\n');
          return;
        }

        // 13. Execute migrations
        console.log(`🔨 Applying ${migrations.length} migration(s)...\n`);

        let successCount = 0;
        let errorCount = 0;

        for (const migration of migrations) {
          try {
            if (migration.type === 'add_column' && migration.column) {
              await db.alterTable.addColumn(migration.tableName, {
                name: migration.column.name,
                type: migration.column.type,
                notNull: migration.column.notNull,
                defaultValue: migration.column.defaultValue,
                unique: migration.column.unique,
              });
              console.log(
                `  ✓ Added column ${migration.tableName}.${migration.column.name}`,
              );
              successCount++;
            } else if (migration.type === 'add_index' && migration.index) {
              await db.alterTable.addIndex(
                migration.tableName,
                migration.index,
              );
              console.log(
                `  ✓ Created index ${migration.index.name} on ${migration.tableName}`,
              );
              successCount++;
            }
          } catch (error) {
            errorCount++;
            const errorMsg =
              error instanceof Error ? error.message : String(error);
            console.error(`  ✗ ${migration.type} failed: ${errorMsg}`);
            if (options.verbose && error instanceof Error && error.stack) {
              console.error(`\n${error.stack}\n`);
            }
          }
        }

        // 14. Report summary
        console.log();
        if (errorCount > 0) {
          console.log(
            `⚠️  Migration completed with errors: ${successCount} succeeded, ${errorCount} failed\n`,
          );
        } else {
          console.log(`✅ Successfully applied ${successCount} migration(s)\n`);
        }

        console.log('💡 Next steps:');
        console.log('  - Run: smrt db:validate (verify database integrity)');
        console.log('  - Run: smrt introspect (view discovered objects)');
        console.log();
      } catch (error) {
        console.error('\n❌ Migration failed:');
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
};
