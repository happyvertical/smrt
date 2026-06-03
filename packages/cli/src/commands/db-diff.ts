/**
 * db:diff Command
 *
 * Compares manifest schemas to database.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import { closeDatabaseConnection } from './db-command-utils.js';

const UNSUPPORTED_GENERATE_MESSAGE =
  'File-backed SMRT migrations are not supported. SMRT schema migrations are manifest-driven; update @smrt object definitions and run smrt db:migrate.';

export const dbDiffCommand: CLICommand = {
  name: 'db:diff',
  description: 'Compare manifest schema to database',
  aliases: ['diff', 'schema-diff'],
  args: [],
  options: {
    generate: {
      type: 'boolean',
      description: 'Unsupported: file-backed migrations are not supported',
      default: false,
      short: 'g',
    },
    name: {
      type: 'string',
      description: 'Unsupported: file-backed migrations are not supported',
      short: 'n',
    },
    format: {
      type: 'string',
      description: 'Unsupported: file-backed migrations are not supported',
      short: 'f',
    },
    'with-down': {
      type: 'boolean',
      description: 'Unsupported: file-backed migrations are not supported',
      default: false,
    },
    output: {
      type: 'string',
      description: 'Unsupported: file-backed migrations are not supported',
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
    'drop-indexes': {
      type: 'boolean',
      description:
        'Include orphan-index drops in the diff (indexes in DB but not in the manifest, excluding *_pkey/*_key implicit-from-constraint indexes). Off by default for safety.',
      default: false,
    },
  },
  handler: async (_args: string[], options: any) => {
    let db: any;

    try {
      const unsupportedFileOptions = [
        'generate',
        'name',
        'format',
        'with-down',
        'output',
      ].filter(
        (option) => options[option] !== undefined && options[option] !== false,
      );

      if (unsupportedFileOptions.length > 0) {
        const message = `${UNSUPPORTED_GENERATE_MESSAGE} Unsupported option(s): ${unsupportedFileOptions
          .map((option) => `--${option}`)
          .join(', ')}.`;
        if (options.json) {
          console.log(JSON.stringify({ error: message }));
        } else {
          console.error(`\n❌ ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }

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

      // 5. Get all merged schemas.
      //
      // Parity (#1335): use the SAME schema source as db:migrate
      // (`getAllSchemasAsDefinitions()`) rather than re-deriving columns by
      // regex-parsing the generated DDL string. The old DDL-reparse path
      // (`getAllSchemas()` + `parseColumnsFromDDL`) could and did diverge from
      // the structured column definitions migrate uses — db:diff would report a
      // different change set than db:migrate applied. The diff must be an exact
      // preview of what migrate will do, so both commands must feed the
      // SchemaComparer identical column metadata.
      const schemaDefinitions = ObjectRegistry.getAllSchemasAsDefinitions();

      // 6. Import diff utilities
      const { SchemaComparer } = await import(
        '@happyvertical/smrt-core/migrations'
      );

      // 7. Generate diff.
      //
      // Parity (#1335): mirror db:migrate's comparer options exactly. Previously
      // `ignoreTypeMismatches: !options.verbose` meant a non-verbose db:diff
      // silently dropped `type_mismatch` rows that db:migrate (which never sets
      // that flag) would still surface — another way the two commands disagreed.
      // `--verbose` now only controls how much DETAIL we print, never which
      // changes are computed. The full change set (including type_mismatch and
      // type_upgrade) is always rendered below so the diff is an honest preview
      // of what migrate will do.
      const comparer = new SchemaComparer(db, {
        includeDroppedTables: false,
        includeDroppedColumns: false,
        includeDroppedIndexes: Boolean(options['drop-indexes']),
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
      const indexDrops = diff.changes.filter(
        (c: any) => c.type === 'drop_index',
      );
      const typeUpgrades = diff.changes.filter(
        (c: any) => c.type === 'type_upgrade',
      );
      const typeMismatches = diff.changes.filter(
        (c: any) => c.type === 'type_mismatch',
      );

      // Identify shape-drift recreate pairs (drop+add on same name) so the
      // operator sees them as a single repair action rather than two
      // disconnected events. Issue #1165.
      const recreateNames = new Set<string>();
      const dropNames = new Set(indexDrops.map((c: any) => c.name));
      for (const add of indexChanges) {
        if (add.name && dropNames.has(add.name)) {
          recreateNames.add(add.name);
        }
      }

      if (columnChanges.length > 0) {
        console.log(`  📊 New columns (${columnChanges.length}):`);
        for (const change of columnChanges) {
          console.log(`     + ${change.table}.${change.name}`);
        }
        console.log();
      }

      if (recreateNames.size > 0) {
        console.log(`  ♻️  Indexes to recreate (${recreateNames.size}):`);
        for (const name of recreateNames) {
          const add = indexChanges.find((c: any) => c.name === name);
          const cols = add?.index?.columns?.join(', ') ?? '?';
          const unique = add?.index?.unique ? 'UNIQUE ' : '';
          console.log(`     ↻ ${name} → ${unique}(${cols})`);
        }
        console.log(
          '     (each recreate is a drop_index followed by add_index)\n',
        );
      }

      const orphanDrops = indexDrops.filter(
        (c: any) => !recreateNames.has(c.name),
      );
      if (orphanDrops.length > 0) {
        console.log(`  🗑️  Indexes to drop (${orphanDrops.length}):`);
        for (const change of orphanDrops) {
          console.log(`     - ${change.name} on ${change.table}`);
        }
        console.log();
      }

      const newIndexes = indexChanges.filter(
        (c: any) => !recreateNames.has(c.name),
      );
      if (newIndexes.length > 0) {
        console.log(`  🗂️  New indexes (${newIndexes.length}):`);
        for (const change of newIndexes) {
          console.log(`     + ${change.name} on ${change.table}`);
        }
        console.log();
      }

      // Type upgrades are auto-applied by db:migrate. They MUST appear in the
      // human diff too — otherwise db:diff and db:migrate report different
      // change sets (#1335: db:diff showed 31 changes while db:migrate computed
      // 32 and aborted on an upgrade the operator never saw). The diff is a
      // preview of what migrate will do; an applied change that the preview
      // hides is a parity bug.
      if (typeUpgrades.length > 0) {
        console.log(`  🔁 Type upgrades (${typeUpgrades.length}):`);
        for (const change of typeUpgrades) {
          console.log(
            `     ⤴ ${change.table}.${change.name}: ${change.mismatch?.actual} → ${change.mismatch?.expected}`,
          );
        }
        console.log('     (auto-applied by smrt db:migrate)\n');
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

      console.log('━'.repeat(50));
      console.log('\n💡 Schema migrations are manifest-driven.');
      console.log(
        '   Update @smrt object definitions, then run smrt db:migrate.\n',
      );
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
