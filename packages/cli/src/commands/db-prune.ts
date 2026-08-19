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
 * Packages that contribute retention tasks by registering them on import.
 *
 * `db:prune` runs in the CLI's own process, so a task only reaches the sweep
 * if this process actually loaded the package that registers it. These are
 * imported optionally — a project that does not depend on jobs or users simply
 * has no jobs or users tasks, which is the correct outcome, not an error.
 */
const RETENTION_TASK_PACKAGES = [
  '@happyvertical/smrt-jobs',
  '@happyvertical/smrt-users',
] as const;

/**
 * Load every installed package that contributes retention tasks.
 *
 * A rejected import is always treated as "not installed" — this function
 * cannot reliably tell a genuine module-resolution miss apart from a package
 * that resolved but threw during its own top-level evaluation (error shapes
 * differ across bundlers and runtimes, and `importPackage` is caller-supplied
 * for exactly that flexibility). It still logs the message on `stderr`
 * rather than swallowing it outright, so an operator can tell "this project
 * doesn't depend on jobs/users" apart from "smrt-jobs is installed but broke
 * on import" without the sweep itself needing to fail over an optional
 * dependency.
 *
 * @returns The specifiers that loaded, in declaration order.
 */
export async function loadRetentionTaskPackages(
  importPackage: (specifier: string) => Promise<unknown>,
): Promise<string[]> {
  const loaded: string[] = [];
  for (const specifier of RETENTION_TASK_PACKAGES) {
    try {
      await importPackage(specifier);
      loaded.push(specifier);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(
        `⚠️  Could not load ${specifier} (${message}). Treating its retention tasks as not contributed — ` +
          'if the package is installed, this may be a real import failure rather than a missing dependency.',
      );
    }
  }
  return loaded;
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
  // `--dry-run` can turn a real run into a preview; nothing on the command
  // line turns a configured preview back into a real deletion.
  policy.dryRun = options['dry-run'] || (configured?.dryRun ?? false);

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

/**
 * Names passed to `--skip` that no task in the completed sweep answered to.
 *
 * A typo and a package that was never installed look identical on the command
 * line, so the command says which names it did not recognize rather than
 * silently doing less than the operator asked for.
 */
export function unmatchedSkipNames(
  skip: string | undefined,
  result: RetentionSweepResult,
): string[] {
  const known = new Set(result.tasks.map((task) => task.task));
  return (skip ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0 && !known.has(name));
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

      const {
        config: smrtConfig,
        importOptionalDependency,
        runRetentionSweep,
      } = await import('@happyvertical/smrt-core');

      // Packages register their retention tasks on import, and this process
      // has loaded none of them yet — without this the sweep would only ever
      // see the four built-in tables.
      const loaded = await loadRetentionTaskPackages((specifier) =>
        importOptionalDependency(
          specifier,
          'Install it in the project to include its retention tasks.',
        ),
      );

      const policy = buildPrunePolicy(smrtConfig.toJSON().retention, options);
      const result = await runRetentionSweep(db, policy);
      const unmatched = unmatchedSkipNames(options.skip, result);

      if (options.json) {
        console.log(
          JSON.stringify(
            { ...result, contributors: loaded, unmatched },
            null,
            2,
          ),
        );
      } else {
        console.log(
          `\n🧹 Retention sweep${result.dryRun ? ' (dry run)' : ''}\n`,
        );
        console.log(`Database: ${formatDatabaseDisplayUrl(dbType, dbUrl)}\n`);
        console.log(formatSweepResult(result));
        console.log();
        if (unmatched.length > 0) {
          console.warn(
            `⚠️  --skip named no known task: ${unmatched.join(', ')}. ` +
              'Check the spelling, or the package that registers it may not be installed.\n',
          );
        }
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
