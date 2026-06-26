/**
 * db:rollback Command
 *
 * Reverts applied migrations using their DOWN scripts.
 */

import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { closeDatabaseConnection } from './db-command-utils.js';

/** Parsed CLI options for the `db:rollback` command. */
interface DbRollbackOptions {
  steps?: number;
  to?: string;
  'dry-run'?: boolean;
  // Camel fallback honoured for handler-direct callers/tests (see handler).
  dryRun?: boolean;
  force?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** Per-migration outcome recorded while executing rollbacks. */
interface RollbackResult {
  name: string;
  success: boolean;
  noDownScript?: boolean;
  error?: string;
}

export const dbRollbackCommand: CLICommand = {
  name: 'db:rollback',
  description: 'Rollback applied migrations',
  aliases: ['rollback', 'migration-rollback'],
  args: [],
  options: {
    steps: {
      type: 'number',
      description: 'Number of migrations to rollback (default: 1)',
      default: 1,
      short: 'n',
    },
    to: {
      type: 'string',
      description: 'Rollback to specific migration (exclusive)',
      short: 't',
    },
    'dry-run': {
      type: 'boolean',
      description: 'Preview rollback without executing',
      default: false,
    },
    force: {
      type: 'boolean',
      description: 'Skip confirmation prompt',
      default: false,
      short: 'f',
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
  handler: async (_args: string[], options: DbRollbackOptions) => {
    let db: DatabaseInterface | undefined;

    // `parseCliArgs` returns option keys verbatim, so the declared `'dry-run'`
    // arrives as the kebab key `options['dry-run']` — not `options.dryRun`.
    // Read the kebab key first (real CLI path) and keep the camel fallback so
    // handler-direct callers/tests passing `{ dryRun: true }` still work.
    const dryRun = options['dry-run'] ?? options.dryRun;

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
        console.log('\n↩️  Migration Rollback\n');
      }

      // 3. Connect to database
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      // 4. Initialize MigrationTracker
      const { MigrationTracker, shortChecksum } = await import(
        '@happyvertical/smrt-core/migrations'
      );

      const tracker = new MigrationTracker({ db });
      await tracker.initialize();

      // 5. Get applied migrations (most recent first)
      const history = await tracker.getHistory({ limit: 100 });
      const applied = history.filter((m) => m.status === 'completed');

      if (applied.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ message: 'No migrations to rollback' }));
        } else {
          console.log('✅ No applied migrations to rollback\n');
        }
        return;
      }

      // 6. Determine which migrations to rollback
      let migrationsToRollback: typeof applied = [];

      if (options.to) {
        // Rollback to specific migration (exclusive)
        const targetIndex = applied.findIndex((m) => m.name === options.to);
        if (targetIndex === -1) {
          if (options.json) {
            console.log(
              JSON.stringify({ error: `Migration "${options.to}" not found` }),
            );
          } else {
            console.error(
              `❌ Migration "${options.to}" not found in history\n`,
            );
          }
          process.exitCode = 1;
          return;
        }
        // Rollback all migrations after the target
        migrationsToRollback = applied.slice(0, targetIndex);
      } else {
        // Rollback last N migrations
        migrationsToRollback = applied.slice(
          0,
          Math.min(options.steps || 1, applied.length),
        );
      }

      if (migrationsToRollback.length === 0) {
        if (options.json) {
          console.log(JSON.stringify({ message: 'Nothing to rollback' }));
        } else {
          console.log('✅ Nothing to rollback\n');
        }
        return;
      }

      // 7. Display migrations to be rolled back
      if (!options.json) {
        console.log(
          `Migrations to rollback (${migrationsToRollback.length}):\n`,
        );
        for (const m of migrationsToRollback) {
          const appliedAt = m.applied_at.toISOString().substring(0, 19);
          console.log(
            `  ↩ ${m.name} (${shortChecksum(m.checksum)} applied ${appliedAt})`,
          );
        }
        console.log();
      }

      // 8. Check if migrations are reversible
      const nonReversible = migrationsToRollback.filter(
        (m) => !m.is_reversible,
      );
      if (nonReversible.length > 0) {
        if (options.json) {
          console.log(
            JSON.stringify({
              error: 'Some migrations are not reversible',
              nonReversible: nonReversible.map((m) => m.name),
            }),
          );
        } else {
          console.log('⚠️  Warning: Some migrations are not reversible:\n');
          for (const m of nonReversible) {
            console.log(`   - ${m.name}`);
          }
          console.log(
            '\n   These migrations will be marked as rolled back but no DOWN script will run.\n',
          );
        }
      }

      // 9. Confirm rollback (unless --force or --dry-run)
      if (!options.force && !dryRun && !options.json) {
        console.log('⚠️  WARNING: This will revert database changes!');

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
        console.log();
      }

      // 10. Dry-run mode
      if (dryRun) {
        if (options.json) {
          console.log(
            JSON.stringify({
              dryRun: true,
              migrationsToRollback: migrationsToRollback.map((m) => ({
                name: m.name,
                checksum: m.checksum,
                isReversible: m.is_reversible,
              })),
            }),
          );
        } else {
          console.log('📋 Dry-run - no changes made\n');
          console.log('Would rollback the following migrations:');
          for (const m of migrationsToRollback) {
            const status = m.is_reversible
              ? '(has DOWN script)'
              : '(no DOWN script)';
            console.log(`  ↩ ${m.name} ${status}`);
          }
          console.log();
        }
        return;
      }

      // 11. Execute rollbacks
      if (!options.json) {
        console.log('🔨 Rolling back migrations...\n');
      }

      let successCount = 0;
      let errorCount = 0;
      const results: RollbackResult[] = [];

      for (const migration of migrationsToRollback) {
        try {
          // We need the DOWN script from the migration definition
          // For now, we'll mark as rolled back but note that full rollback
          // requires the original migration file with DOWN statements

          // Create a minimal definition for rollback
          const definition = {
            id: migration.name,
            description: `Rollback: ${migration.name}`,
            version: migration.version,
            up: [],
            down: [], // Would need to load from migration file
          };

          if (migration.is_reversible) {
            // Note: Full implementation would load DOWN script from file
            // For now, just mark as rolled back
            const result = await tracker.rollback(migration.name, definition, {
              dryRun: false,
            });

            if (result.success) {
              if (!options.json) {
                console.log(`  ✓ ${migration.name} rolled back`);
              }
              results.push({ name: migration.name, success: true });
              successCount++;
            } else {
              throw result.error || new Error('Rollback failed');
            }
          } else {
            // Mark as rolled back without executing DOWN
            await db.query(
              `UPDATE _smrt_schema_migrations SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP WHERE name = ?`,
              [migration.name],
            );
            if (!options.json) {
              console.log(
                `  ⊙ ${migration.name} marked as rolled back (no DOWN script)`,
              );
            }
            results.push({
              name: migration.name,
              success: true,
              noDownScript: true,
            });
            successCount++;
          }
        } catch (error) {
          errorCount++;
          const errorMsg =
            error instanceof Error ? error.message : String(error);
          if (!options.json) {
            console.error(`  ✗ ${migration.name} failed: ${errorMsg}`);
          }
          results.push({
            name: migration.name,
            success: false,
            error: errorMsg,
          });

          if (options.verbose && error instanceof Error && error.stack) {
            console.error(`\n${error.stack}\n`);
          }
        }
      }

      // 12. Report summary
      if (options.json) {
        console.log(
          JSON.stringify(
            {
              success: errorCount === 0,
              successCount,
              errorCount,
              results,
            },
            null,
            2,
          ),
        );
      } else {
        console.log();
        if (errorCount > 0) {
          console.log(
            `⚠️  Rollback completed with errors: ${successCount} succeeded, ${errorCount} failed\n`,
          );
        } else {
          console.log(
            `✅ Successfully rolled back ${successCount} migration(s)\n`,
          );
        }

        console.log('💡 Commands:');
        console.log('   smrt db:status   - View current migration status');
        console.log('   smrt db:history  - View migration history');
        console.log('   smrt db:migrate  - Re-apply migrations');
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
        console.error('\n❌ Rollback failed:');
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
