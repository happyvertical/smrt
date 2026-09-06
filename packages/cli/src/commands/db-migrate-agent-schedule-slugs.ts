import {
  AGENT_SCHEDULE_SLUG_BACKFILL,
  migrateAgentScheduleSlugs,
  planAgentScheduleSlugMigration,
} from '@happyvertical/smrt-agents';
import { parsePostgresTimeoutMs } from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

interface DbMigrateAgentScheduleSlugsOptions {
  'dry-run'?: boolean;
}

export const dbMigrateAgentScheduleSlugsCommand: CLICommand = {
  name: 'db:migrate-agent-schedule-slugs',
  description:
    'Backfill canonical slugs for legacy framework AgentSchedule rows after db:migrate. Requires a PostgreSQL maintenance window; it never runs schedules.',
  aliases: ['migrate-agent-schedule-slugs', 'db-migrate-schedule-slugs'],
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Validate legacy schedule identities without writing.',
      default: false,
    },
  },
  handler: async (
    _args: string[],
    options: DbMigrateAgentScheduleSlugsOptions,
  ) => {
    let db: DatabaseInterface | undefined;
    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url || config.database.url === ':memory:') {
        throw new Error(
          'Database configuration required for db:migrate-agent-schedule-slugs. Configure database.url in smrt.config.ts (or DATABASE_URL).',
        );
      }
      const dbType = config.database.type || 'sqlite';
      if (dbType !== 'postgres') {
        throw new Error(
          'db:migrate-agent-schedule-slugs currently supports PostgreSQL only; no changes were made.',
        );
      }
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: config.database.url });
      console.log('\n🗓️  AgentSchedule slug migration\n');
      console.log(
        `✓ Connected to ${formatDatabaseDisplayUrl(dbType, config.database.url)}\n`,
      );
      if (options['dry-run']) {
        const plan = await planAgentScheduleSlugMigration(db);
        console.log(
          `DRY RUN: ${plan.pending} AgentSchedule slug(s) would be backfilled; no schedules run and no changes made.\n`,
        );
        return;
      }
      const postgres = config.migrations?.postgres;
      const result = await migrateAgentScheduleSlugs(db, {
        backfillName: AGENT_SCHEDULE_SLUG_BACKFILL,
        packageName: '@happyvertical/smrt-agents',
        lockTimeout: parsePostgresTimeoutMs(postgres?.lockTimeout, 30_000),
        statementTimeout: parsePostgresTimeoutMs(
          postgres?.statementTimeout,
          60_000,
        ),
      });
      console.log(
        result.ran
          ? `✓ Backfilled ${result.updated} AgentSchedule slug(s); no schedules were run.\n`
          : 'No schedule slug migration was needed.\n',
      );
    } catch (error) {
      console.error(
        `\n❌ AgentSchedule slug migration failed: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
