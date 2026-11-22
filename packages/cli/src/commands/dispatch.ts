/**
 * Dispatch Commands - CLI tools for inter-agent communication
 *
 * Commands for managing the dispatch queue and subscriptions.
 */

import type {
  DispatchBus,
  DispatchFailureCode,
  DispatchRetryOptions,
  DispatchStatus,
} from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import type { CLICommand } from '../cli-generator.js';
import { closeDatabaseConnection } from './db-command-utils.js';

/** Parsed options for `dispatch:list`. */
interface DispatchListCliOptions {
  status?: DispatchStatus;
  source?: string;
  type?: string;
  reason?: string;
  limit?: number;
  json?: boolean;
}

/** Parsed options for `dispatch:process`. */
interface DispatchProcessCliOptions {
  subscriber?: string;
  limit?: number;
  dry?: boolean;
  'include-expired'?: boolean;
}

/** Parsed options for `dispatch:retry`. */
interface DispatchRetryCliOptions {
  'max-attempts'?: number;
  'reset-attempts'?: boolean;
  type?: string;
}

/** Parsed options for `dispatch:release-leases`. */
interface DispatchReleaseLeasesCliOptions {
  'after-drain'?: boolean;
  legacy?: boolean;
  dry?: boolean;
}

/** Parsed options for `dispatch:cleanup`. */
interface DispatchCleanupCliOptions {
  'completed-older-than'?: number;
  'failed-older-than'?: number;
  dry?: boolean;
}

/** Parsed options for `dispatch:subscriptions`. */
interface DispatchSubscriptionsCliOptions {
  subscriber?: string;
  json?: boolean;
}

/** Parsed options for `dispatch:subscribe`. */
interface DispatchSubscribeCliOptions {
  handler?: string;
}

/**
 * Get dispatch bus with database from config
 */
async function getDispatchBus(): Promise<{
  bus: DispatchBus;
  db: DatabaseInterface;
}> {
  const { createDispatchBus } = await import('@happyvertical/smrt-core');
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { getDatabase } = await import('@happyvertical/sql');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');

  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  const dbConfig = config.database;

  if (!dbConfig?.url) {
    throw new Error(
      'Database not configured. Set database.url in smrt.config.ts or use --db option.',
    );
  }

  let db: DatabaseInterface | undefined;

  try {
    db = await getDatabase({
      type: dbConfig.type || 'sqlite',
      url: dbConfig.url,
    });

    const bus = await createDispatchBus({ db });

    return { bus, db };
  } catch (error) {
    await closeDatabaseConnection(db);
    throw error;
  }
}

/**
 * Dispatch commands for inter-agent communication
 */
export const dispatchCommands: Record<string, CLICommand> = {
  'dispatch:list': {
    name: 'dispatch:list',
    description: 'List dispatches in the queue',
    args: [],
    options: {
      status: {
        type: 'string',
        description: 'Filter by status (pending|processing|completed|failed)',
        short: 's',
      },
      source: {
        type: 'string',
        description: 'Filter by source agent',
      },
      type: {
        type: 'string',
        description: 'Filter by signal type',
        short: 't',
      },
      reason: {
        type: 'string',
        description:
          'Only rows failed or released for this framework reason (e.g. DISPATCH_ATTEMPTS_EXHAUSTED); exact match',
      },
      limit: {
        type: 'number',
        description: 'Maximum results (default: 50)',
        short: 'l',
        default: 50,
      },
      json: {
        type: 'boolean',
        description: 'Output as JSON',
        short: 'j',
        default: false,
      },
    },
    handler: async (_args: string[], options: DispatchListCliOptions) => {
      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;
        const dispatches = await bus.list({
          status: options.status,
          source: options.source,
          type: options.type,
          reason: options.reason as DispatchFailureCode | undefined,
          limit: options.limit || 50,
        });

        if (options.json) {
          console.log(JSON.stringify(dispatches, null, 2));
          return;
        }

        if (dispatches.length === 0) {
          console.log('No dispatches found.');
          return;
        }

        console.log(`\nFound ${dispatches.length} dispatch(es):\n`);
        console.log(
          'ID'.padEnd(20) +
            'TYPE'.padEnd(25) +
            'SOURCE'.padEnd(15) +
            'STATUS'.padEnd(12) +
            'CREATED',
        );
        console.log('-'.repeat(90));

        for (const dispatch of dispatches) {
          console.log(
            dispatch.id.substring(0, 18).padEnd(20) +
              dispatch.type.substring(0, 23).padEnd(25) +
              dispatch.source.substring(0, 13).padEnd(15) +
              dispatch.status.padEnd(12) +
              dispatch.createdAt.toISOString().substring(0, 19),
          );
        }
        console.log();
      } catch (error) {
        console.error(
          'Error listing dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:process': {
    name: 'dispatch:process',
    description: 'Process pending dispatches for a subscriber',
    args: [],
    options: {
      subscriber: {
        type: 'string',
        description: 'Subscriber name (required)',
        short: 's',
      },
      limit: {
        type: 'number',
        description: 'Maximum dispatches to process (default: 100)',
        short: 'l',
        default: 100,
      },
      dry: {
        type: 'boolean',
        description:
          'Show what would be processed (the same candidate query, with the phase of each row) without executing',
        default: false,
      },
      'include-expired': {
        type: 'boolean',
        description:
          'Also reclaim rows whose lease expired (default: pending rows only)',
        default: false,
      },
    },
    handler: async (_args: string[], options: DispatchProcessCliOptions) => {
      if (!options.subscriber) {
        console.error('Error: --subscriber is required');
        process.exit(1);
      }

      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;

        if (options.dry) {
          // Dry run - just show what would be processed
          const subscriptions = await bus.listSubscriptions(options.subscriber);
          console.log(
            `\nSubscriptions for "${options.subscriber}" (${subscriptions.length}):`,
          );
          for (const sub of subscriptions) {
            console.log(`  • ${sub.signalType} → ${sub.handler}()`);
          }

          // The bus's own read-only candidate query: same phases, routing,
          // patterns, budget and tenant scope as a live run.
          const preview = await bus.previewProcess(options.subscriber, {
            limit: options.limit || 100,
          });
          const reclaims = preview.filter(
            ({ phase }) => phase === 'expired' || phase === 'legacy',
          );
          const taken = options['include-expired']
            ? preview
            : preview.filter((entry) => !reclaims.includes(entry));
          const line = ({
            dispatch,
            phase,
          }: (typeof preview)[number]): string =>
            `  • ${dispatch.id} - ${dispatch.type} (from ${dispatch.source}) [${phase}]`;

          console.log(`\nDispatches that would be processed: ${taken.length}`);
          for (const entry of taken) console.log(line(entry));
          if (!options['include-expired'] && reclaims.length > 0) {
            console.log(
              `\nExpired leases, processed only with --include-expired: ${reclaims.length}`,
            );
            for (const entry of reclaims) console.log(line(entry));
          }
          return;
        }

        console.log(`Processing dispatches for "${options.subscriber}"...`);

        // Note: In real usage, the agent would provide its handleDispatch method
        // For CLI, we just mark them as processed with a log handler
        let processed = 0;
        const result = await bus.process(
          options.subscriber,
          async (_payload, metadata) => {
            console.log(
              `  ✓ Processed ${metadata.id.substring(0, 8)} - ${metadata.type}`,
            );
            processed++;
          },
          {
            limit: options.limit || 100,
            // The logging handler does no work: reclaiming another worker's
            // expired lease needs an explicit opt-in.
            phases: options['include-expired'] ? 'all' : 'pending',
          },
        );

        console.log(`\nProcessed ${result} dispatch(es).`);
      } catch (error) {
        console.error(
          'Error processing dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:retry': {
    name: 'dispatch:retry',
    description: 'Retry failed dispatches',
    args: [],
    options: {
      'max-attempts': {
        type: 'number',
        description:
          "Only retry rows with fewer attempts than this (default: each row's claim budget, 5 unless configured)",
        short: 'm',
      },
      'reset-attempts': {
        type: 'boolean',
        description:
          'Reset the attempt count, reviving rows whose claim budget is spent',
        default: false,
      },
      type: {
        type: 'string',
        description: 'Only retry specific signal type',
        short: 't',
      },
    },
    handler: async (_args: string[], options: DispatchRetryCliOptions) => {
      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;

        // Without --max-attempts the bus applies each row's claim budget.
        const retryOptions: DispatchRetryOptions = {};
        if (options['max-attempts']) {
          retryOptions.maxAttempts = options['max-attempts'];
        }
        if (options['reset-attempts']) {
          retryOptions.resetAttempts = true;
        }

        if (options.type) {
          retryOptions.signalTypes = [options.type];
        }

        const count = await bus.retry(retryOptions);
        console.log(
          `Reset ${count} failed dispatch(es) to pending${retryOptions.resetAttempts ? ' (attempts reset)' : ''}.`,
        );
      } catch (error) {
        console.error(
          'Error retrying dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:release-leases': {
    name: 'dispatch:release-leases',
    description:
      'Move leased processing dispatches back to pending (attempts kept): expired leases by default',
    args: [],
    options: {
      'after-drain': {
        type: 'boolean',
        description:
          'Release every lease, live or expired. Only after every dispatch worker has stopped (rollback)',
        default: false,
      },
      legacy: {
        type: 'boolean',
        description:
          'Release rows an older core left processing without a lease (after draining it)',
        default: false,
      },
      dry: {
        type: 'boolean',
        description: 'Count the rows that would be released',
        default: false,
      },
    },
    handler: async (
      _args: string[],
      options: DispatchReleaseLeasesCliOptions,
    ) => {
      let db: DatabaseInterface | undefined;

      try {
        if (options['after-drain'] && options.legacy) {
          throw new Error('--after-drain and --legacy cannot be combined');
        }
        const release = options['after-drain']
          ? 'afterDrain'
          : options.legacy
            ? 'legacy'
            : 'expired';
        const context = await getDispatchBus();
        db = context.db;
        const result = await context.bus.maintain({
          release,
          sweepOrphans: false,
          dryRun: options.dry === true,
        });
        console.log(
          `${options.dry ? 'Would release' : 'Released'} ${result.released} lease(s) (${release}).`,
        );
      } catch (error) {
        console.error(
          'Error releasing dispatch leases:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:cleanup': {
    name: 'dispatch:cleanup',
    description: 'Clean up old dispatches',
    args: [],
    options: {
      'completed-older-than': {
        type: 'number',
        description: 'Delete completed dispatches older than N days',
        short: 'c',
        default: 30,
      },
      'failed-older-than': {
        type: 'number',
        description: 'Delete failed dispatches older than N days',
        short: 'f',
      },
      dry: {
        type: 'boolean',
        description: 'Show what would be deleted without executing',
        default: false,
      },
    },
    handler: async (_args: string[], options: DispatchCleanupCliOptions) => {
      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;

        const cleanupOptions = {
          completedOlderThanDays: options['completed-older-than'] || 30,
          failedOlderThanDays: options['failed-older-than'] || undefined,
        };

        if (options.dry) {
          // Same predicates and tenant scope as the live cleanup below,
          // counted without deleting.
          const preview = await bus.cleanup({
            ...cleanupOptions,
            dryRun: true,
          });
          console.log('\nDry run: nothing deleted.');
          console.log(
            `Would delete completed older than ${cleanupOptions.completedOlderThanDays} days: ${preview.completedDeleted}`,
          );
          if (cleanupOptions.failedOlderThanDays) {
            console.log(
              `Would delete failed older than ${cleanupOptions.failedOlderThanDays} days: ${preview.failedDeleted}`,
            );
          }
          return;
        }

        const result = await bus.cleanup(cleanupOptions);

        console.log(`Cleanup complete:`);
        console.log(`  Completed deleted: ${result.completedDeleted}`);
        console.log(`  Failed deleted: ${result.failedDeleted}`);
      } catch (error) {
        console.error(
          'Error cleaning up dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:subscriptions': {
    name: 'dispatch:subscriptions',
    description: 'List dispatch subscriptions',
    args: [],
    options: {
      subscriber: {
        type: 'string',
        description: 'Filter by subscriber name',
        short: 's',
      },
      json: {
        type: 'boolean',
        description: 'Output as JSON',
        short: 'j',
        default: false,
      },
    },
    handler: async (
      _args: string[],
      options: DispatchSubscriptionsCliOptions,
    ) => {
      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;
        const subscriptions = await bus.listSubscriptions(options.subscriber);

        if (options.json) {
          console.log(JSON.stringify(subscriptions, null, 2));
          return;
        }

        if (subscriptions.length === 0) {
          console.log('No subscriptions found.');
          return;
        }

        console.log(`\nFound ${subscriptions.length} subscription(s):\n`);
        console.log(
          'SUBSCRIBER'.padEnd(20) +
            'SIGNAL TYPE'.padEnd(30) +
            'HANDLER'.padEnd(20) +
            'ENABLED',
        );
        console.log('-'.repeat(80));

        for (const sub of subscriptions) {
          console.log(
            sub.subscriber.substring(0, 18).padEnd(20) +
              sub.signalType.substring(0, 28).padEnd(30) +
              sub.handler.substring(0, 18).padEnd(20) +
              (sub.enabled ? 'yes' : 'no'),
          );
        }
        console.log();
      } catch (error) {
        console.error(
          'Error listing subscriptions:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:subscribe': {
    name: 'dispatch:subscribe',
    description: 'Create a dispatch subscription',
    args: ['<signal-type>', '<subscriber>'],
    options: {
      handler: {
        type: 'string',
        description: 'Handler method name (default: handleDispatch)',
        short: 'h',
        default: 'handleDispatch',
      },
    },
    handler: async (args: string[], options: DispatchSubscribeCliOptions) => {
      if (args.length < 2) {
        console.error(
          'Usage: smrt dispatch:subscribe <signal-type> <subscriber>',
        );
        process.exit(1);
      }

      const [signalType, subscriber] = args;
      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;
        await bus.subscribe({
          signalType,
          subscriber,
          handler: options.handler,
        });

        console.log(
          `Created subscription: "${subscriber}" → ${signalType} (handler: ${options.handler})`,
        );
      } catch (error) {
        console.error(
          'Error creating subscription:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },

  'dispatch:unsubscribe': {
    name: 'dispatch:unsubscribe',
    description: 'Remove a dispatch subscription',
    args: ['<signal-type>', '<subscriber>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 2) {
        console.error(
          'Usage: smrt dispatch:unsubscribe <signal-type> <subscriber>',
        );
        process.exit(1);
      }

      const [signalType, subscriber] = args;
      let db: DatabaseInterface | undefined;

      try {
        const context = await getDispatchBus();
        db = context.db;
        const { bus } = context;
        await bus.unsubscribe(signalType, subscriber);

        console.log(`Removed subscription: "${subscriber}" ← ${signalType}`);
      } catch (error) {
        console.error(
          'Error removing subscription:',
          error instanceof Error ? error.message : error,
        );
        process.exitCode = 1;
        return;
      } finally {
        await closeDatabaseConnection(db);
      }
    },
  },
};
