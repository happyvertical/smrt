import { ObjectRegistry } from '@happyvertical/smrt-core';
import {
  collectNullEqualIndexTargets,
  migrateNullEqualIndexes,
  nullEqualIndexStatements,
  preflightNullEqualIndexes,
} from '@happyvertical/smrt-core/migrations';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

export const dbMigrateNullEqualIndexesCommand: CLICommand = {
  name: 'db:migrate-null-equal-indexes',
  description:
    'Upgrade framework nullable conflict indexes on PostgreSQL 15+ in an explicit maintenance window. Run after db:migrate.',
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      default: false,
      description:
        'Inspect readiness, duplicates and proposed DDL without writing.',
    },
  },
  handler: async (_args, options: { 'dry-run'?: boolean }) => {
    let db: DatabaseInterface | undefined;
    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
      if (!config.database?.url || config.database.url === ':memory:') {
        throw new Error(
          'Database configuration required: set database.url in smrt.config.ts (or DATABASE_URL).',
        );
      }
      await autoDiscoverAndLoad();
      const schemas = ObjectRegistry.getAllSchemasAsDefinitions();
      if (!Object.keys(schemas).length)
        throw new Error(
          'No SMRT schemas discovered. Run from the project root after generating manifests.',
        );
      const type = config.database.type || 'sqlite';
      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type, url: config.database.url });
      console.log(
        `Connected to ${formatDatabaseDisplayUrl(type, config.database.url)}`,
      );
      const targets = collectNullEqualIndexTargets(schemas);
      const preflight = await preflightNullEqualIndexes(db, targets, {
        engineHint: type,
      });
      console.log(preflight.summary);
      for (const index of preflight.indexes) {
        console.log(
          `${index.table}.${index.index}: ${index.state}${index.reason ? ` — ${index.reason}` : ''}`,
        );
        if (index.state === 'blocked')
          console.log(`Detector: ${index.detectorSql};`);
        if (index.state === 'pending')
          for (const sql of nullEqualIndexStatements(index))
            console.log(`${sql};`);
      }
      if (preflight.indexes.some((index) => index.state === 'blocked'))
        throw new Error(
          'Preflight blocked. Resolve the reported identities or dependencies; no changes applied.',
        );
      if (!preflight.supported || options['dry-run']) return;
      const result = await migrateNullEqualIndexes(db, targets, {
        engineHint: type,
        lockTimeout: config.migrations?.postgres?.lockTimeout,
        statementTimeout: config.migrations?.postgres?.statementTimeout,
      });
      console.log(
        `Applied ${result.statements.length} index statements atomically.`,
      );
      console.log(
        'Refresh/restart database connections in EVERY application process to clear cached index capability probes. Until then the existing upsert fallback remains correct.',
      );
    } catch (error) {
      console.error(
        `NULL-equal conflict-index migration failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};
