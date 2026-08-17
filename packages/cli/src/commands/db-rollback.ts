/**
 * db:rollback Command
 *
 * Reverts applied migrations by executing the DOWN script that produced them —
 * or refuses, loudly and with a non-zero exit, when no DOWN script exists.
 *
 * SMRT schema migrations are diff-driven: `db:migrate` derives them from the
 * manifest at run time and stores no SQL in `_smrt_schema_migrations`, so the
 * only DOWN this command can honour is the deterministic one `db:migrate`
 * records for `create_table_<table>` migrations. Everything else is refused
 * rather than flipped to `rolled_back` with the schema untouched (#2378).
 * `--mark-only` is the explicit, honestly-labelled opt-in for the record-only
 * flip an operator who reverted the schema by hand actually wants.
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
  'mark-only'?: boolean;
  markOnly?: boolean;
  force?: boolean;
  json?: boolean;
  verbose?: boolean;
}

/** Per-migration outcome recorded while executing rollbacks. */
interface RollbackResult {
  name: string;
  success: boolean;
  /** DOWN statements that were executed (absent on the record-only path). */
  statements?: string[];
  /** Record-only flip: the tracking row moved, the schema did not. */
  markedOnly?: boolean;
  error?: string;
}

/**
 * Name prefix of the only migration class `db:migrate` records a DOWN script
 * for (`utilities.ts`, `diff.added_tables` loop:
 * `down: ['DROP TABLE IF EXISTS "<table>"']`). Keep the two in step — this
 * command reconstructs that exact statement from the recorded migration name.
 */
const CREATE_TABLE_MIGRATION_PREFIX = 'create_table_';

/**
 * Table names SMRT generates are plain snake_case identifiers. Anything else
 * in a `create_table_*` row was not written by `db:migrate`, so its DOWN is not
 * ours to reconstruct.
 */
const SAFE_TABLE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$]*$/;

/** Human-readable refusal headline, printed above the per-migration reasons. */
const REFUSAL_HEADLINE =
  'Refusing to roll back: no DOWN script is available for the selected migration(s).';

/** Single-line refusal used for the JSON payload. */
const REFUSAL_ERROR = `${REFUSAL_HEADLINE} Nothing was changed.`;

/** Why the refusal happened and the two ways forward, printed with it. */
const REFUSAL_GUIDANCE = [
  'SMRT schema migrations are diff-driven: db:migrate stores no SQL in _smrt_schema_migrations and records a DOWN script only for create_table_<table> migrations.',
  'Revert these by updating the @smrt object definitions and running smrt db:migrate, or by reverting the schema by hand.',
  'Re-run with --mark-only to mark them rolled_back in the tracking table WITHOUT changing the schema (record-only).',
];

/** Outcome of trying to reconstruct a migration's DOWN script. */
export type DownRecovery =
  | { recoverable: true; statements: string[] }
  | { recoverable: false; reason: string };

/** The fields of a `_smrt_schema_migrations` row this command reasons about. */
interface RollbackCandidate {
  name: string;
  is_reversible: boolean;
}

/**
 * Reconstruct the DOWN script for an applied migration, or explain why it
 * cannot be reconstructed.
 *
 * Recoverable only for `create_table_<table>` rows recorded as reversible: the
 * DOWN `db:migrate` attached to them is the deterministic
 * `DROP TABLE IF EXISTS "<table>"`. A row recorded reversible under any other
 * name came from a caller-supplied `MigrationDefinition` whose SQL was never
 * persisted, so it is refused rather than guessed at.
 *
 * Exported for unit testing.
 */
export function recoverDownStatements(
  migration: RollbackCandidate,
): DownRecovery {
  if (!migration.name.startsWith(CREATE_TABLE_MIGRATION_PREFIX)) {
    return {
      recoverable: false,
      reason: migration.is_reversible
        ? 'recorded as reversible, but its DOWN SQL is not stored in _smrt_schema_migrations and cannot be reconstructed'
        : 'was applied without a DOWN script',
    };
  }

  if (!migration.is_reversible) {
    return {
      recoverable: false,
      reason: 'is recorded as not reversible',
    };
  }

  const tableName = migration.name.slice(CREATE_TABLE_MIGRATION_PREFIX.length);
  if (!SAFE_TABLE_NAME_RE.test(tableName)) {
    return {
      recoverable: false,
      reason: `names table "${tableName}", which is not a plain identifier db:migrate would have generated`,
    };
  }

  return {
    recoverable: true,
    statements: [`DROP TABLE IF EXISTS "${tableName}"`],
  };
}

/** One planned rollback: the applied row plus the DOWN it can (or cannot) run. */
interface RollbackPlanEntry<TMigration extends RollbackCandidate> {
  migration: TMigration;
  recovery: DownRecovery;
}

export const dbRollbackCommand: CLICommand = {
  name: 'db:rollback',
  description: 'Rollback applied migrations by executing their DOWN script',
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
    'mark-only': {
      type: 'boolean',
      description:
        'Record-only: mark migrations rolled back WITHOUT running any DOWN script (schema untouched)',
      default: false,
      short: 'm',
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
    // Same rule for `--mark-only`, whose miss would be the same data-loss class
    // of bug as #1385.
    const dryRun = options['dry-run'] ?? options.dryRun;
    const markOnly = options['mark-only'] ?? options.markOnly;

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

      // 7. Plan the rollback: resolve the DOWN script for every selected row
      //    before anything is displayed, prompted for, or executed.
      const plan: RollbackPlanEntry<(typeof applied)[number]>[] =
        migrationsToRollback.map((migration) => ({
          migration,
          recovery: recoverDownStatements(migration),
        }));
      // Flattened to `{ name, reason }` here so the refusal payload below is
      // built from an already-narrowed shape rather than re-testing the union.
      const unrecoverable = plan.flatMap(({ migration, recovery }) =>
        recovery.recoverable
          ? []
          : [{ name: migration.name, reason: recovery.reason }],
      );

      if (!options.json) {
        console.log(
          `Migrations to rollback (${migrationsToRollback.length}):\n`,
        );
        for (const { migration, recovery } of plan) {
          const appliedAt = migration.applied_at.toISOString().substring(0, 19);
          const marker = recovery.recoverable ? '↩' : '⊘';
          console.log(
            `  ${marker} ${migration.name} (${shortChecksum(migration.checksum)} applied ${appliedAt})`,
          );
          if (recovery.recoverable) {
            for (const sql of recovery.statements) {
              console.log(`      ${sql};`);
            }
          } else {
            console.log(`      no DOWN script — ${recovery.reason}`);
          }
        }
        console.log();
      }

      // 8. Refuse rather than lie. Without a DOWN script the schema cannot be
      //    reverted, and marking the row `rolled_back` anyway would leave the
      //    tracking table describing a database that does not exist. Refusal is
      //    all-or-nothing: a partial revert would leave the chain inconsistent.
      if (unrecoverable.length > 0 && !markOnly) {
        if (options.json) {
          console.log(
            JSON.stringify(
              {
                error: REFUSAL_ERROR,
                dryRun: Boolean(dryRun),
                nonReversible: unrecoverable,
                guidance: REFUSAL_GUIDANCE,
              },
              null,
              2,
            ),
          );
        } else {
          console.error(`❌ ${REFUSAL_HEADLINE}\n`);
          for (const detail of unrecoverable) {
            console.error(`   - ${detail.name} — ${detail.reason}`);
          }
          console.error();
          for (const line of REFUSAL_GUIDANCE) {
            console.error(`   ${line}`);
          }
          console.error('\n   Nothing was changed.\n');
        }

        process.exitCode = 1;
        return;
      }

      // 9. Confirm rollback (unless --force or --dry-run)
      if (!options.force && !dryRun && !options.json) {
        console.log(
          markOnly
            ? '⚠️  WARNING: This marks migrations rolled back WITHOUT changing the schema!'
            : '⚠️  WARNING: This will revert database changes!',
        );

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
              markOnly: Boolean(markOnly),
              migrationsToRollback: plan.map(({ migration, recovery }) => ({
                name: migration.name,
                checksum: migration.checksum,
                isReversible: migration.is_reversible,
                down: recovery.recoverable ? recovery.statements : [],
              })),
            }),
          );
        } else {
          console.log('📋 Dry-run - no changes made\n');
          console.log(
            markOnly
              ? 'Would mark the following migrations rolled back (schema untouched):'
              : 'Would execute the DOWN script of the following migrations:',
          );
          for (const { migration, recovery } of plan) {
            const status = recovery.recoverable
              ? `(${recovery.statements.length} DOWN statement(s))`
              : '(no DOWN script)';
            console.log(`  ↩ ${migration.name} ${status}`);
          }
          console.log();
        }
        return;
      }

      // 11. Execute rollbacks
      if (!options.json) {
        console.log(
          markOnly
            ? '🔨 Marking migrations rolled back (record-only)...\n'
            : '🔨 Rolling back migrations...\n',
        );
      }

      let successCount = 0;
      let errorCount = 0;
      const results: RollbackResult[] = [];
      let stoppedBy: string | null = null;

      for (const { migration, recovery } of plan) {
        // A failed DOWN leaves the schema in a state the older DOWN scripts
        // were not written against, so stop instead of compounding it.
        if (stoppedBy) {
          const message = `Not attempted: rollback stopped after ${stoppedBy} failed`;
          if (!options.json) {
            console.error(`  ⊘ ${migration.name} skipped: ${message}`);
          }
          results.push({
            name: migration.name,
            success: false,
            error: message,
          });
          errorCount++;
          continue;
        }

        try {
          if (markOnly) {
            // Record-only: the operator asserts the schema was already
            // reverted. Never dressed up as an executed rollback.
            await db.query(
              `UPDATE _smrt_schema_migrations SET status = 'rolled_back', rolled_back_at = CURRENT_TIMESTAMP WHERE name = ?`,
              [migration.name],
            );
            if (!options.json) {
              console.log(
                `  ⊙ ${migration.name} marked rolled back (schema untouched)`,
              );
            }
            results.push({
              name: migration.name,
              success: true,
              markedOnly: true,
            });
            successCount++;
            continue;
          }

          if (!recovery.recoverable) {
            // Unreachable: step 8 refuses this set unless --mark-only.
            throw new Error(`No DOWN script available — ${recovery.reason}`);
          }

          const result = await tracker.rollback(
            migration.name,
            {
              id: migration.name,
              description: `Rollback: ${migration.name}`,
              version: migration.version,
              up: [],
              down: recovery.statements,
            },
            { dryRun: false },
          );

          if (!result.success) {
            throw result.error || new Error('Rollback failed');
          }

          if (!options.json) {
            console.log(`  ✓ ${migration.name} rolled back`);
          }
          results.push({
            name: migration.name,
            success: true,
            statements: recovery.statements,
          });
          successCount++;
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
          stoppedBy = migration.name;

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
              markOnly: Boolean(markOnly),
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
        } else if (markOnly) {
          console.log(
            `✅ Marked ${successCount} migration(s) rolled back — the schema was NOT changed\n`,
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

      if (errorCount > 0) {
        process.exitCode = 1;
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
