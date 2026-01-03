/**
 * db:generate Command
 *
 * Creates an empty migration template file.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { CLICommand } from '../cli-generator.js';

export const dbGenerateCommand: CLICommand = {
  name: 'db:generate',
  description: 'Create an empty migration file',
  aliases: ['generate', 'migration-create', 'db:create'],
  args: ['<name>'],
  options: {
    sql: {
      type: 'boolean',
      description: 'Generate SQL format (default)',
      default: true,
    },
    ts: {
      type: 'boolean',
      description: 'Generate TypeScript format',
      default: false,
    },
    timestamp: {
      type: 'boolean',
      description: 'Use timestamp-based naming instead of sequence',
      default: false,
      short: 't',
    },
    output: {
      type: 'string',
      description: 'Output directory (default: ./migrations)',
      default: './migrations',
      short: 'o',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (args: string[], options: any) => {
    try {
      const migrationName = args[0];

      if (!migrationName) {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Migration name is required' }));
        } else {
          console.error('\n❌ Migration name is required\n');
          console.error('Usage: smrt db:generate <name>\n');
          console.error('Examples:');
          console.error('  smrt db:generate add_users_table');
          console.error('  smrt db:generate add_email_to_profiles --ts');
          console.error('  smrt db:generate fix_indexes --timestamp\n');
        }
        process.exit(1);
      }

      // Validate migration name
      if (!/^[a-z0-9_]+$/i.test(migrationName)) {
        if (options.json) {
          console.log(JSON.stringify({ error: 'Invalid migration name' }));
        } else {
          console.error('\n❌ Invalid migration name\n');
          console.error(
            'Migration names should only contain letters, numbers, and underscores.',
          );
          console.error(
            'Examples: add_users, create_profiles_table, fix_index_name\n',
          );
        }
        process.exit(1);
      }

      const format = options.ts ? 'typescript' : 'sql';
      const outputDir = resolve(process.cwd(), options.output);

      // Import generator utilities
      const {
        MigrationGenerator,
        generateMigrationSequence,
        generateMigrationTimestamp,
      } = await import('@happyvertical/smrt-core/migrations');

      // Get existing migrations to determine sequence
      let existingIds: string[] = [];
      try {
        const files = await readdir(outputDir);
        existingIds = files
          .filter((f) => f.endsWith('.sql') || f.endsWith('.ts'))
          .map((f) => f.replace(/\.(sql|ts)$/, ''));
      } catch {
        // Directory doesn't exist yet
      }

      // Generate migration ID
      let migrationId: string;
      if (options.timestamp) {
        const timestamp = generateMigrationTimestamp();
        migrationId = `${timestamp}_${migrationName}`;
      } else {
        const sequence = generateMigrationSequence(existingIds);
        migrationId = `${sequence}_${migrationName}`;
      }

      // Check for duplicates
      if (existingIds.includes(migrationId)) {
        if (options.json) {
          console.log(
            JSON.stringify({
              error: `Migration "${migrationId}" already exists`,
            }),
          );
        } else {
          console.error(`\n❌ Migration "${migrationId}" already exists\n`);
        }
        process.exit(1);
      }

      // Load CLI config for database type
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      const dbType = config.database?.type || 'sqlite';
      const engine = dbType === 'postgres' ? 'postgres' : 'sqlite';

      // Generate empty migration
      const generator = new MigrationGenerator({
        engine,
        format,
        includeDown: true,
      });

      const migration = generator.generateEmpty({
        name: migrationId,
        description: `Migration: ${migrationName}`,
        format,
      });

      // Create output directory
      await mkdir(outputDir, { recursive: true });

      // Write migration file
      const filePath = resolve(outputDir, migration.filename);
      await writeFile(filePath, migration.content, 'utf-8');

      // Output result
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              success: true,
              id: migrationId,
              filename: migration.filename,
              path: filePath,
              format,
            },
            null,
            2,
          ),
        );
      } else {
        console.log('\n✅ Created migration file:\n');
        console.log(`   ID:       ${migrationId}`);
        console.log(`   File:     ${migration.filename}`);
        console.log(`   Path:     ${filePath}`);
        console.log(
          `   Format:   ${format === 'typescript' ? 'TypeScript' : 'SQL'}`,
        );
        console.log();
        console.log('💡 Next steps:');
        console.log(
          '   1. Edit the migration file to add your UP and DOWN statements',
        );
        console.log('   2. Run: smrt db:migrate --dry-run (preview changes)');
        console.log('   3. Run: smrt db:migrate (apply changes)');
        console.log();
      }
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to create migration:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exit(1);
    }
  },
};
