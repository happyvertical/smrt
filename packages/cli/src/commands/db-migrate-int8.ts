/**
 * db:migrate-int8 Command
 *
 * Explicitly widens legacy PostgreSQL/DuckDB int4 columns created before
 * #2373. This is deliberately separate from `db:migrate`: PostgreSQL rewrites
 * each table, so an operator must review the row-count preflight and schedule
 * a maintenance window before opting in.
 */

import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  buildIntegerWidthTableStatements,
  collectIntegerWidthTargets,
  parsePostgresTimeoutMs,
  preflightIntegerWidthWidening,
  widenIntegerColumnsToBigInt,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

interface DbMigrateInt8Options {
  'dry-run'?: boolean;
  verbose?: boolean;
}

const BACKFILL_NAME = '@happyvertical/smrt-core:integer-width:v1';
const DEFAULT_POSTGRES_LOCK_TIMEOUT_MS = 30_000;
const DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS = 60_000;

export const dbMigrateInt8Command: CLICommand = {
  name: 'db:migrate-int8',
  description:
    'Widen legacy SMRT int4 columns to BIGINT after reviewing the maintenance-window preflight. Run after db:migrate.',
  aliases: ['migrate-int8', 'db-migrate-int8'],
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Print the preflight and ALTER statements without writing.',
      default: false,
    },
    verbose: {
      type: 'boolean',
      description: 'Print the full per-table preflight report.',
      default: false,
      short: 'v',
    },
  },
  handler: async (_args: string[], options: DbMigrateInt8Options) => {
    let db: DatabaseInterface | undefined;
    const dryRun = Boolean(options['dry-run']);

    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url || config.database.url === ':memory:') {
        throw new Error(
          'Database configuration required for db:migrate-int8. Configure database.url in smrt.config.ts (or DATABASE_URL).',
        );
      }

      // This is the same registry source ordinary schema migration uses. Do
      // not guess targets from names; a later complete discovery safely
      // widens any live int4 columns still pending.
      await autoDiscoverAndLoad();
      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      if (Object.keys(schemas).length === 0) {
        throw new Error(
          'No SMRT application schemas were discovered. Run this command from the project root after generating manifests.',
        );
      }

      const dbType = config.database.type || 'sqlite';
      const dbUrl = config.database.url;
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });
      console.log('\n↔️  Integer-width migration\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`,
      );

      const targets = collectIntegerWidthTargets(schemas, {
        includeSystemTables: true,
      });
      const preflight = await preflightIntegerWidthWidening(db, targets, {
        engineHint: dbType,
      });
      console.log(preflight.summary);
      if (options.verbose && preflight.supported) {
        console.log('\nFull preflight report:');
        for (const table of preflight.tables) {
          const columns = table.columns
            .map(
              (column) =>
                `${column.column}: ${column.declaredType ?? 'missing'} (${column.state})`,
            )
            .join(', ');
          console.log(
            `  ${table.table}: ${table.rowCount ?? 'not counted'} row(s); ${columns}`,
          );
        }
      }

      if (!preflight.supported) {
        console.log('\nNo widening is needed on this engine.\n');
        return;
      }
      if (preflight.unexpectedColumns > 0) {
        throw new Error(
          'Some schema-declared integer columns have unexpected live types. Resolve ordinary schema drift before this widening pass.',
        );
      }
      if (preflight.pendingColumns === 0) {
        console.log('\nNo legacy int4 columns remain.\n');
        return;
      }

      const statements = preflight.tables.flatMap((table) =>
        buildIntegerWidthTableStatements(
          preflight.engine,
          table.table,
          table.columns
            .filter((column) => column.state === 'pending')
            .map((column) => column.column),
        ),
      );
      console.log(
        `\n${dryRun ? 'DRY RUN — would execute' : 'Applying'} ${statements.length} lossless ALTER statement(s):`,
      );
      for (const statement of statements) console.log(`  ${statement};`);

      if (dryRun) {
        console.log('\nDry run complete — no changes applied.\n');
        return;
      }

      const postgresMigrationConfig = config.migrations?.postgres;
      const result = await widenIntegerColumnsToBigInt(db, targets, {
        engineHint: dbType,
        backfillName: BACKFILL_NAME,
        packageName: '@happyvertical/smrt-core',
        lockTimeout: parsePostgresTimeoutMs(
          postgresMigrationConfig?.lockTimeout,
          DEFAULT_POSTGRES_LOCK_TIMEOUT_MS,
        ),
        statementTimeout: parsePostgresTimeoutMs(
          postgresMigrationConfig?.statementTimeout,
          DEFAULT_POSTGRES_STATEMENT_TIMEOUT_MS,
        ),
      });
      console.log(
        result.ran
          ? `\n✓ Widened ${result.widenedColumns.length} column(s) to BIGINT.\n`
          : '\nNo widening was applied; no legacy int4 columns remain.\n',
      );
    } catch (error) {
      console.error(
        `\n❌ int8 migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
