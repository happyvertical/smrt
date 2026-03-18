/**
 * db:history Command
 *
 * Shows detailed migration history with filtering options.
 */

import type { MigrationStatus } from '@happyvertical/smrt-core/migrations';
import type { CLICommand } from '../cli-generator.js';

export const dbHistoryCommand: CLICommand = {
  name: 'db:history',
  description: 'View detailed migration history',
  aliases: ['history', 'migration-history'],
  args: [],
  options: {
    limit: {
      type: 'number',
      description: 'Number of migrations to show (default: 20)',
      default: 20,
      short: 'n',
    },
    since: {
      type: 'string',
      description: 'Show migrations since date (YYYY-MM-DD)',
      short: 's',
    },
    status: {
      type: 'string',
      description:
        'Filter by status (completed, failed, rolled_back, running, pending)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
    verbose: {
      type: 'boolean',
      description: 'Show full details including checksums',
      default: false,
      short: 'v',
    },
  },
  handler: async (_args: string[], options: any) => {
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
        console.log('\n📜 Migration History\n');
      }

      // 3. Connect to database
      const { getDatabase } = await import('@happyvertical/sql');
      const db = await getDatabase({ type: dbType, url: dbUrl });

      // 4. Import MigrationTracker
      const { MigrationTracker } = await import(
        '@happyvertical/smrt-core/migrations'
      );

      const tracker = new MigrationTracker({ db });
      await tracker.initialize();

      // 5. Build query options
      const queryOptions: {
        limit?: number;
        since?: Date;
        status?: MigrationStatus;
      } = {};

      if (options.limit) {
        queryOptions.limit = options.limit;
      }

      if (options.since) {
        queryOptions.since = new Date(options.since);
      }

      if (options.status) {
        queryOptions.status = options.status as
          | 'pending'
          | 'running'
          | 'completed'
          | 'failed'
          | 'rolled_back';
      }

      // 6. Get history
      const history = await tracker.getHistory(queryOptions);

      // 7. Output results
      if (options.json) {
        const jsonOutput = history.map((m) => ({
          id: m.id,
          name: m.name,
          version: m.version,
          checksum: m.checksum,
          appliedChecksum: m.applied_checksum,
          appliedAt: m.applied_at.toISOString(),
          executionTimeMs: m.execution_time_ms,
          status: m.status,
          errorMessage: m.error_message,
          attempts: m.attempts,
          isReversible: m.is_reversible,
          rolledBackAt: m.rolled_back_at?.toISOString() || null,
          appliedBy: m.applied_by,
          batch: m.batch,
          packageName: m.package_name,
          sourceFile: m.source_file,
        }));
        console.log(JSON.stringify(jsonOutput, null, 2));
        return;
      }

      // Human-readable output
      if (history.length === 0) {
        console.log('No migrations found matching criteria.');
        console.log();
        console.log('💡 Run `smrt db:migrate` to apply schema changes');
        console.log();
        return;
      }

      console.log(`Showing ${history.length} migration(s):\n`);

      for (const m of history) {
        const statusIcon = getStatusIcon(m.status);
        const timeStr = formatDateTime(m.applied_at);

        console.log(`${statusIcon} ${m.name}`);
        console.log(`   Applied: ${timeStr}`);

        if (options.verbose) {
          console.log(`   Version: ${m.version}`);
          console.log(`   Checksum: ${m.checksum.substring(0, 16)}...`);
          if (m.execution_time_ms) {
            console.log(`   Duration: ${m.execution_time_ms}ms`);
          }
          if (m.applied_by) {
            console.log(`   Host: ${m.applied_by}`);
          }
          if (m.batch) {
            console.log(`   Batch: ${m.batch}`);
          }
          if (m.package_name) {
            console.log(`   Package: ${m.package_name}`);
          }
          if (m.source_file) {
            console.log(`   Source: ${m.source_file}`);
          }
          if (m.error_message) {
            console.log(`   Error: ${m.error_message}`);
          }
          if (m.rolled_back_at) {
            console.log(`   Rolled back: ${formatDateTime(m.rolled_back_at)}`);
          }
        } else {
          // Compact mode - show key info
          const parts: string[] = [];
          if (m.execution_time_ms) {
            parts.push(`${m.execution_time_ms}ms`);
          }
          if (m.batch) {
            parts.push(`batch ${m.batch}`);
          }
          if (m.error_message) {
            parts.push(`error: ${m.error_message.substring(0, 50)}`);
          }
          if (parts.length > 0) {
            console.log(`   ${parts.join(' | ')}`);
          }
        }

        console.log();
      }

      // Summary
      const completed = history.filter((m) => m.status === 'completed').length;
      const failed = history.filter((m) => m.status === 'failed').length;
      const rolledBack = history.filter(
        (m) => m.status === 'rolled_back',
      ).length;

      console.log('━'.repeat(50));
      console.log(
        `Summary: ${completed} completed, ${failed} failed, ${rolledBack} rolled back`,
      );
      console.log();

      console.log('💡 Commands:');
      console.log('   smrt db:status     - Current migration status');
      console.log('   smrt db:rollback   - Rollback migrations');
      console.log();
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to get migration history:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exit(1);
    }
  },
};

/**
 * Get status icon for migration status
 */
function getStatusIcon(status: string): string {
  switch (status) {
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'rolled_back':
      return '↩';
    case 'running':
      return '⟳';
    case 'pending':
      return '○';
    default:
      return '?';
  }
}

/**
 * Format date/time for display
 */
function formatDateTime(date: Date): string {
  return date.toISOString().replace('T', ' ').substring(0, 19);
}
