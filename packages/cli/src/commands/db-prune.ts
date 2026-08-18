/**
 * db:prune Command — bounded growth for framework-owned tables (#2375).
 *
 * The cron entry point for `runRetentionSweep()`: prunes `_smrt_changes`,
 * `_smrt_ai_usage`, `_smrt_contexts` and `_smrt_dispatch`, plus every task
 * other packages contribute (job/job-event cleanup from
 * `@happyvertical/smrt-jobs`, session and token expiry from
 * `@happyvertical/smrt-users`). Deployments that run a jobs worker already get
 * the same sweep on an interval; this command is for those that do not, and
 * for one-off operator runs.
 *
 * Defaults come from the framework's documented retention policy and can be
 * overridden per table on the command line or, persistently, through
 * `retention` in `smrt.config`. `--dry-run` reports exactly what a real run
 * would delete, using the same predicates.
 */

import type {
  RetentionPolicy,
  RetentionSweepResult,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import {
  closeDatabaseConnection,
  formatDatabaseDisplayUrl,
} from './db-command-utils.js';

/** Parsed CLI options for the `db:prune` command. */
interface DbPruneOptions {
  json?: boolean;
  'dry-run'?: boolean;
  'changes-days'?: number;
  'usage-days'?: number;
  'dispatch-days'?: number;
  skip?: string;
}

/**
 * Merge command-line overrides onto the configured retention policy.
 *
 * `--skip` names tasks, not tables, so it covers both the built-in tables and
 * anything a package registered — the same names `db:prune --json` reports.
 */
export function buildPrunePolicy(
  configured: RetentionPolicy | undefined,
  options: DbPruneOptions,
): RetentionPolicy {
  const policy: RetentionPolicy = { ...(configured ?? {}) };
  policy.dryRun = options['dry-run'] ?? false;

  if (options['changes-days'] !== undefined) {
    policy.changes = {
      ...(policy.changes === false ? {} : (policy.changes ?? {})),
      maxAgeDays: options['changes-days'],
    };
  }
  if (options['usage-days'] !== undefined) {
    policy.aiUsage = {
      ...(policy.aiUsage === false ? {} : (policy.aiUsage ?? {})),
      maxAgeDays: options['usage-days'],
    };
  }
  if (options['dispatch-days'] !== undefined) {
    policy.dispatch = {
      ...(policy.dispatch === false ? {} : (policy.dispatch ?? {})),
      completedOlderThanDays: options['dispatch-days'],
    };
  }

  const skipped = (options.skip ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);

  for (const name of skipped) {
    switch (name) {
      case 'changes':
        policy.changes = false;
        break;
      case 'ai-usage':
        policy.aiUsage = false;
        break;
      case 'contexts':
        policy.contexts = false;
        break;
      case 'dispatch':
        policy.dispatch = false;
        break;
      default:
        policy.tasks = { ...(policy.tasks ?? {}), [name]: false };
    }
  }

  return policy;
}

/** Render a completed sweep as an operator-readable table. */
export function formatSweepResult(result: RetentionSweepResult): string {
  const lines: string[] = [];
  const verb = result.dryRun ? 'would prune' : 'pruned';

  for (const task of result.tasks) {
    const status = task.error
      ? `error: ${task.error}`
      : task.skipped
        ? task.skipped
        : `${verb} ${task.pruned}`;
    const detail = task.details
      ? ` (${Object.entries(task.details)
          .map(([key, value]) => `${key}=${value}`)
          .join(', ')})`
      : '';
    lines.push(`  ${task.task.padEnd(24)}${status}${detail}`);
  }

  lines.push('');
  lines.push(
    `  ${'total'.padEnd(24)}${verb} ${result.pruned} row(s) in ${result.durationMs}ms`,
  );

  return lines.join('\n');
}

export const dbPruneCommand: CLICommand = {
  name: 'db:prune',
  description: 'Prune framework-owned system tables to their retention windows',
  args: [],
  options: {
    'dry-run': {
      type: 'boolean',
      description: 'Report what would be deleted without deleting it',
      default: false,
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON (for CI/cron integration)',
      default: false,
      short: 'j',
    },
    'changes-days': {
      type: 'number',
      description: 'Retention window for _smrt_changes, in days',
    },
    'usage-days': {
      type: 'number',
      description: 'Retention window for _smrt_ai_usage, in days',
    },
    'dispatch-days': {
      type: 'number',
      description:
        'Retention window for completed _smrt_dispatch rows, in days',
    },
    skip: {
      type: 'string',
      description:
        'Comma-separated task names to skip (changes, ai-usage, contexts, dispatch, …)',
    },
  },
  handler: async (_args: string[], options: DbPruneOptions) => {
    let db: DatabaseInterface | undefined;

    try {
      const { getPackageConfig } = await import('@happyvertical/smrt-config');
      const { DEFAULT_CLI_CONFIG } = await import('../config.js');
      const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);

      if (!config.database?.url) {
        const message =
          'Database not configured. Set database.url in smrt.config.ts.';
        if (options.json) {
          console.log(JSON.stringify({ error: message }));
        } else {
          console.error(`\n❌ ${message}\n`);
        }
        process.exitCode = 1;
        return;
      }

      const dbUrl = config.database.url;
      const dbType = config.database.type || 'sqlite';

      const { getDatabase } = await import('@happyvertical/sql');
      db = await getDatabase({ type: dbType, url: dbUrl });

      const { config: smrtConfig, runRetentionSweep } = await import(
        '@happyvertical/smrt-core'
      );
      const policy = buildPrunePolicy(smrtConfig.toJSON().retention, options);
      const result = await runRetentionSweep(db, policy);

      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(
          `\n🧹 Retention sweep${result.dryRun ? ' (dry run)' : ''}\n`,
        );
        console.log(`Database: ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`);
        console.log(formatSweepResult(result));
        console.log();
      }

      // A partial sweep must not look like a clean one to cron.
      if (result.failed) {
        process.exitCode = 1;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.json) {
        console.log(JSON.stringify({ error: message }));
      } else {
        console.error(`\n❌ Retention sweep failed: ${message}\n`);
      }
      process.exitCode = 1;
    } finally {
      await closeDatabaseConnection(db);
    }
  },
};

export default dbPruneCommand;
