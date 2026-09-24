import { parsePostgresTimeoutMs } from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
  redactConnectionStringsInText,
} from './db-command-utils.js';

interface DbMigrateLedgerAccountsOptions {
  'dry-run'?: boolean;
}

/**
 * Move ledger accounts out of the `accounts` table they shared with
 * smrt-messages before #3098. Run between two `db:migrate` passes; see the
 * smrt-ledgers README.
 */
export const dbMigrateLedgerAccountsCommand: CLICommand = {
  name: 'db:migrate-ledger-accounts',
  description:
    'Move smrt-ledgers accounts from the legacy shared `accounts` table into `ledger_accounts` (#3098). Run after db:migrate has created ledger_accounts, in a PostgreSQL maintenance window, then run db:migrate again.',
  aliases: ['migrate-ledger-accounts'],
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Report the ledger rows that would move without writing.',
      default: false,
    },
  },
  handler: async (_args: string[], options: DbMigrateLedgerAccountsOptions) => {
    let db: DatabaseInterface | undefined;
    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url || config.database.url === ':memory:') {
        throw new Error(
          'Database configuration required for db:migrate-ledger-accounts. Configure database.url in smrt.config.ts (or DATABASE_URL).',
        );
      }
      const dbType = config.database.type || 'sqlite';
      if (dbType !== 'postgres') {
        throw new Error(
          'db:migrate-ledger-accounts currently supports PostgreSQL only; no changes were made. See the smrt-ledgers README for SQLite.',
        );
      }
      // The project's full registry, as db:migrate uses: the move detaches
      // every foreign key the manifests now point at ledger_accounts,
      // including the application's own references to ledger accounts.
      await autoDiscoverAndLoad();
      const { getDatabase } = await import('@happyvertical/sql');
      const { migrateLedgerAccountsTable, planLedgerAccountsTableMove } =
        await import('@happyvertical/smrt-ledgers');
      db = await getDatabase({ type: dbType, url: config.database.url });
      console.log('\n📒 Ledger accounts table move\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(dbType, config.database.url)}\n`,
      );
      if (options['dry-run']) {
        const plan = await planLedgerAccountsTableMove(db);
        console.log(
          plan.legacyTable
            ? `DRY RUN: ${plan.pending} ledger account(s) would move to ledger_accounts; ${plan.messagingRows} messaging account(s) stay in accounts. No changes made.\n`
            : 'DRY RUN: no legacy accounts table holds ledger accounts. No changes made.\n',
        );
        return;
      }
      const postgres = config.migrations?.postgres;
      const result = await migrateLedgerAccountsTable(db, {
        lockTimeout: parsePostgresTimeoutMs(postgres?.lockTimeout, 30_000),
        statementTimeout: parsePostgresTimeoutMs(
          postgres?.statementTimeout,
          60_000,
        ),
      });
      if (!result.ran) {
        console.log('No ledger accounts table move was needed.\n');
        return;
      }
      console.log(
        `✓ Moved ${result.moved} ledger account(s) to ledger_accounts; ${result.remainingLegacyRows} row(s) remain in accounts.`,
      );
      if (result.detachedForeignKeys.length > 0) {
        console.log(
          `✓ Detached ${result.detachedForeignKeys.join(', ')} from accounts. Run db:migrate to add them against ledger_accounts.\n`,
        );
      }
    } catch (error) {
      console.error(
        `\n❌ Ledger accounts table move failed: ${redactConnectionStringsInText(
          error instanceof Error ? error.message : String(error),
        )}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
