/**
 * db:diff Command
 *
 * Compares manifest schemas to database and generates migration files.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import { closeDatabaseConnection } from './db-command-utils.js';

export const dbDiffCommand: CLICommand = {
  name: 'db:diff',
  description: 'Compare schema to database and generate migration',
  aliases: ['diff', 'schema-diff'],
  args: [],
  options: {
    generate: {
      type: 'boolean',
      description: 'Generate migration file from diff',
      default: false,
      short: 'g',
    },
    name: {
      type: 'string',
      description: 'Migration name (required with --generate)',
      short: 'n',
    },
    format: {
      type: 'string',
      description: 'Output format: sql or ts (default: sql)',
      default: 'sql',
      short: 'f',
    },
    'with-down': {
      type: 'boolean',
      description: 'Include DOWN script in generated migration',
      default: true,
    },
    output: {
      type: 'string',
      description:
        'Output directory for generated files (default: ./migrations)',
      default: './migrations',
      short: 'o',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed output',
      default: false,
      short: 'v',
    },
  },
  handler: async (_args: string[], options: any) => {
    let db: any;

    try {
      // 1. Load CLI config
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      // 2. Validate database configuration
      if (!config.database?.url || config.database.url === ':memory:') {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Database not configured' }));
        } else {
          console.error('\n❌ Database configuration required');
          console.error('\nPlease configure database in smrt.config.js\n');
        }
        process.exit(1);
      }

      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';

      if (!options.json) {
        console.log('\n📊 Schema Diff\n');
      }

      // 3. Auto-discover and load manifests
      const { discovered, totalObjects } = await autoDiscoverAndLoad();

      if (discovered.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ error: 'No manifests found' }));
        } else {
          console.error('❌ No SMRT manifests found');
          console.error(
            '\nRun: smrt test --manifest-only (generates manifest)',
          );
        }
        process.exit(1);
      }

      if (!options.json) {
        console.log(
          `✓ Found ${totalObjects} object(s) in ${discovered.length} manifest(s)\n`,
        );
      }

      // 4. Connect to database
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      // 5. Get all merged schemas
      const allSchemas = ObjectRegistry.getAllSchemas();

      // 6. Import diff utilities
      const { SchemaComparer, MigrationGenerator, generateMigrationSequence } =
        await import('@happyvertical/smrt-core/migrations');

      // Convert merged schemas to SchemaDefinition format
      // The allSchemas is Record<tableName, { ddl, tableName, indexes }>
      // We need to convert to Record<tableName, SchemaDefinition>
      const schemaDefinitions: Record<string, any> = {};

      for (const [tableName, schema] of Object.entries(allSchemas)) {
        // Parse columns from DDL if not already provided
        const columns = parseColumnsFromDDL(schema.ddl);
        const indexes = parseIndexesFromSchema(schema.indexes || []);

        schemaDefinitions[tableName] = {
          tableName,
          ddl: schema.ddl,
          columns,
          indexes,
          triggers: [],
          foreignKeys: [],
          version: '1.0.0',
          dependencies: [],
        };
      }

      // 7. Generate diff
      const comparer = new SchemaComparer(db, {
        includeDroppedTables: false,
        includeDroppedColumns: false,
        ignoreTypeMismatches: !options.verbose,
      });

      const diff = await comparer.compare(schemaDefinitions);

      // 8. Output results
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              hasChanges: diff.has_changes,
              addedTables: diff.added_tables.map((t: any) => t.tableName),
              droppedTables: diff.dropped_tables,
              changes: diff.changes,
            },
            null,
            2,
          ),
        );
        return;
      }

      if (!diff.has_changes) {
        console.log('✅ Database schema is up to date - no changes detected\n');
        return;
      }

      // Display diff summary
      console.log('📋 Changes Detected:\n');

      if (diff.added_tables.length > 0) {
        console.log(`  📦 New tables (${diff.added_tables.length}):`);
        for (const table of diff.added_tables) {
          console.log(`     + ${table.tableName}`);
        }
        console.log();
      }

      const columnChanges = diff.changes.filter(
        (c: any) => c.type === 'add_column',
      );
      const indexChanges = diff.changes.filter(
        (c: any) => c.type === 'add_index',
      );
      const typeMismatches = diff.changes.filter(
        (c: any) => c.type === 'type_mismatch',
      );

      if (columnChanges.length > 0) {
        console.log(`  📊 New columns (${columnChanges.length}):`);
        for (const change of columnChanges) {
          console.log(`     + ${change.table}.${change.name}`);
        }
        console.log();
      }

      if (indexChanges.length > 0) {
        console.log(`  🗂️  New indexes (${indexChanges.length}):`);
        for (const change of indexChanges) {
          console.log(`     + ${change.name} on ${change.table}`);
        }
        console.log();
      }

      if (typeMismatches.length > 0) {
        console.log(`  ⚠️  Type mismatches (${typeMismatches.length}):`);
        for (const change of typeMismatches) {
          console.log(
            `     ! ${change.table}.${change.name}: ${change.mismatch?.expected} vs ${change.mismatch?.actual}`,
          );
        }
        console.log('     (Type changes require manual migration)\n');
      }

      // 9. Generate migration file if requested
      if (options.generate) {
        if (!options.name) {
          console.error('❌ --name is required when using --generate\n');
          console.error(
            'Usage: smrt db:diff --generate --name add_users_table\n',
          );
          process.exitCode = 1;
          return;
        }

        // Get existing migrations to determine sequence
        const { readdir } = await import('node:fs/promises');
        const outputDir = resolve(process.cwd(), options.output);

        let existingIds: string[] = [];
        try {
          const files = await readdir(outputDir);
          existingIds = files
            .filter((f: string) => f.endsWith('.sql') || f.endsWith('.ts'))
            .map((f: string) => f.replace(/\.(sql|ts)$/, ''));
        } catch {
          // Directory doesn't exist yet
        }

        const sequence = generateMigrationSequence(existingIds);
        const migrationId = `${sequence}_${options.name}`;

        // Determine database engine
        const engine = dbType === 'postgres' ? 'postgres' : 'sqlite';

        const generator = new MigrationGenerator({
          engine,
          format: options.format === 'ts' ? 'typescript' : 'sql',
          includeDown: options.withDown ?? true,
        });

        const migration = generator.generateFromDiff(diff, {
          name: migrationId,
          description: `Migration: ${options.name}`,
          format: options.format === 'ts' ? 'typescript' : 'sql',
        });

        // Write migration file
        await mkdir(outputDir, { recursive: true });
        const filePath = resolve(outputDir, migration.filename);
        await writeFile(filePath, migration.content, 'utf-8');

        console.log('━'.repeat(50));
        console.log(`\n✅ Generated migration: ${migration.filename}`);
        console.log(`   Path: ${filePath}`);
        console.log(`   Checksum: ${migration.checksum.substring(0, 8)}`);
        console.log(`   UP statements: ${migration.up.length}`);
        console.log(`   DOWN statements: ${migration.down.length}\n`);

        if (options.verbose) {
          console.log('Content:');
          console.log('━'.repeat(50));
          console.log(migration.content);
          console.log('━'.repeat(50));
          console.log();
        }

        console.log('💡 Next steps:');
        console.log('   smrt db:migrate      - Apply the migration');
        console.log('   smrt db:migrate --dry-run  - Preview changes');
        console.log();
      } else {
        console.log('━'.repeat(50));
        console.log('\n💡 To generate a migration file:');
        console.log('   smrt db:diff --generate --name <migration_name>\n');
      }
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to generate diff:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exitCode = 1;
      return;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

/**
 * Parse column definitions from DDL string
 */
function parseColumnsFromDDL(ddl: string): Record<string, any> {
  const columns: Record<string, any> = {};

  // Try to extract columns from CREATE TABLE statement
  const createTableMatch = ddl.match(
    /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?["']?(\w+)["']?\s*\(([\s\S]+?)\)(?:\s*;)?$/im,
  );

  if (!createTableMatch) {
    return columns;
  }

  const columnSection = createTableMatch[2];

  // Split by comma, respecting parentheses
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
    // Skip constraints
    if (
      /^\s*(FOREIGN\s+KEY|PRIMARY\s+KEY|UNIQUE|CHECK|CONSTRAINT)/i.test(part)
    ) {
      continue;
    }

    // Parse column: "column_name" TYPE [constraints]
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
    }
  }

  return columns;
}

/**
 * Parse index definitions from schema indexes array
 */
function parseIndexesFromSchema(indexes: string[]): any[] {
  const result: any[] = [];

  for (const indexSQL of indexes) {
    const match = indexSQL.match(
      /CREATE\s+(UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:"([^"]+)"|'([^']+)'|(\w+))\s+ON\s+(?:"[^"]+"|'[^']+'|\w+)\s*\(([^)]+)\)/i,
    );

    if (match) {
      const isUnique = !!match[1];
      const indexName = match[2] ?? match[3] ?? match[4];
      const columnsStr = match[5];
      const columns = columnsStr
        .split(',')
        .map((c: string) => c.trim().replace(/["']/g, ''));

      result.push({
        name: indexName,
        columns,
        unique: isUnique,
      });
    }
  }

  return result;
}
