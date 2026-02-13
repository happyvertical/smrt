/**
 * db:status Command
 *
 * Shows the current status of database migrations:
 * - Applied migrations
 * - Pending migrations
 * - Drift detection warnings
 */

import type { CLICommand } from '../cli-generator.js';
import { autoDiscoverAndLoad } from '../discovery/index.js';

export const dbStatusCommand: CLICommand = {
  name: 'db:status',
  description: 'Show migration status (applied, pending, drift)',
  aliases: ['status', 'migration-status'],
  args: [],
  options: {
    json: {
      type: 'boolean',
      description: 'Output as JSON (for CI integration)',
      default: false,
      short: 'j',
    },
    verbose: {
      type: 'boolean',
      description: 'Show detailed migration information',
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
        console.log('\n📊 Migration Status\n');
        const displayUrl = /^[a-z]+:\/\//.test(dbUrl)
          ? dbUrl
          : `${dbType}://${dbUrl}`;
        console.log(`Database: ${displayUrl}\n`);
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

      // 5. Get applied migrations
      const applied = await tracker.getAppliedMigrations();

      // 6. Auto-discover manifests to get current definitions
      const { discovered, totalObjects } = await autoDiscoverAndLoad();

      // 7. Build status report
      const status = {
        database: {
          type: dbType,
          url: dbUrl,
          engine: tracker.getEngine(),
        },
        manifests: {
          count: discovered.length,
          objects: totalObjects,
        },
        migrations: {
          applied: applied.length,
          details: applied.map((m) => ({
            name: m.name,
            version: m.version,
            appliedAt: m.applied_at.toISOString(),
            executionTime: m.execution_time_ms,
            status: m.status,
            isReversible: m.is_reversible,
            checksum: m.checksum.substring(0, 8),
          })),
        },
        drift: [] as { name: string; type: string; recommendation: string }[],
      };

      // 8. Check for drift (if we have migration definitions)
      // Note: In dynamic mode, we don't have file-based definitions yet
      // This will be more useful when file-based migrations are implemented

      // 9. Output results
      if (options.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      // Human-readable output
      console.log(`📦 Manifests: ${status.manifests.count} discovered`);
      console.log(`   Objects:   ${status.manifests.objects} total`);
      console.log();

      if (applied.length === 0) {
        console.log('📋 Applied Migrations: None');
        console.log();
        console.log('💡 Run `smrt db:migrate` to apply pending schema changes');
      } else {
        console.log(`📋 Applied Migrations: ${applied.length}`);
        console.log();

        if (options.verbose) {
          // Detailed table
          console.log(
            '   Name                              Version    Applied At           Status',
          );
          console.log(`   ${'─'.repeat(80)}`);

          for (const m of applied) {
            const name = m.name.padEnd(35).substring(0, 35);
            const version = m.version.padEnd(10).substring(0, 10);
            const appliedAt = m.applied_at.toISOString().substring(0, 19);
            const statusIcon =
              m.status === 'completed'
                ? '✓'
                : m.status === 'failed'
                  ? '✗'
                  : '⊙';
            console.log(
              `   ${name} ${version} ${appliedAt} ${statusIcon} ${m.status}`,
            );
          }
        } else {
          // Compact list
          for (const m of applied.slice(-10)) {
            const statusIcon =
              m.status === 'completed'
                ? '✓'
                : m.status === 'failed'
                  ? '✗'
                  : '⊙';
            const timeAgo = getTimeAgo(m.applied_at);
            console.log(`   ${statusIcon} ${m.name} (${timeAgo})`);
          }

          if (applied.length > 10) {
            console.log(`   ... and ${applied.length - 10} more`);
          }
        }
      }

      console.log();

      // Drift warnings
      if (status.drift.length > 0) {
        console.log('⚠️  Drift Detected:');
        for (const d of status.drift) {
          console.log(`   • ${d.name}: ${d.type}`);
          if (options.verbose) {
            console.log(`     ${d.recommendation}`);
          }
        }
        console.log();
      }

      console.log('💡 Commands:');
      console.log('   smrt db:migrate   - Apply pending changes');
      console.log('   smrt db:history   - View migration history');
      console.log('   smrt db:diff      - Generate migration from changes');
      console.log();
    } catch (error) {
      if (options.json) {
        console.log(
          JSON.stringify({
            error: error instanceof Error ? error.message : String(error),
          }),
        );
      } else {
        console.error('\n❌ Failed to get migration status:');
        if (error instanceof Error) {
          console.error(`   ${error.message}`);
        }
      }
      process.exit(1);
    }
  },
};

/**
 * Get human-readable time ago string
 */
function getTimeAgo(date: Date): string {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);

  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;

  return date.toLocaleDateString();
}
