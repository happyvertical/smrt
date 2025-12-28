/**
 * Dispatch Commands - CLI tools for inter-agent communication
 *
 * Commands for managing the dispatch queue and subscriptions.
 */

import type { CLICommand } from '../cli-generator.js';

/**
 * Get dispatch bus with database from config
 */
async function getDispatchBus() {
  const { createDispatchBus } = await import('@happyvertical/smrt-core');
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');

  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  const dbConfig = config.database;

  if (!dbConfig?.url) {
    throw new Error(
      'Database not configured. Set database.url in smrt.config.ts or use --db option.',
    );
  }

  return createDispatchBus({
    db: {
      type: dbConfig.type || 'sqlite',
      url: dbConfig.url,
    },
  });
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
    handler: async (_args: string[], options: any) => {
      try {
        const bus = await getDispatchBus();
        const dispatches = await bus.list({
          status: options.status,
          source: options.source,
          type: options.type,
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
        process.exit(1);
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
        description: 'Show what would be processed without executing',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      if (!options.subscriber) {
        console.error('Error: --subscriber is required');
        process.exit(1);
      }

      try {
        const bus = await getDispatchBus();

        if (options.dry) {
          // Dry run - just show what would be processed
          const subscriptions = await bus.listSubscriptions(options.subscriber);
          console.log(
            `\nSubscriptions for "${options.subscriber}" (${subscriptions.length}):`,
          );
          for (const sub of subscriptions) {
            console.log(`  • ${sub.signalType} → ${sub.handler}()`);
          }

          const pending = await bus.list({
            status: 'pending',
            limit: options.limit || 100,
          });

          // Filter by subscription patterns
          const matching = pending.filter((d) =>
            subscriptions.some((s) => s.matches(d.type)),
          );

          console.log(
            `\nPending dispatches that would be processed: ${matching.length}`,
          );
          for (const dispatch of matching) {
            console.log(
              `  • ${dispatch.id.substring(0, 8)} - ${dispatch.type} (from ${dispatch.source})`,
            );
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
          { limit: options.limit || 100 },
        );

        console.log(`\nProcessed ${result} dispatch(es).`);
      } catch (error) {
        console.error(
          'Error processing dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
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
        description: 'Maximum attempts before giving up (default: 3)',
        short: 'm',
        default: 3,
      },
      type: {
        type: 'string',
        description: 'Only retry specific signal type',
        short: 't',
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        const bus = await getDispatchBus();

        const retryOptions: any = {
          maxAttempts: options['max-attempts'] || 3,
        };

        if (options.type) {
          retryOptions.signalTypes = [options.type];
        }

        const count = await bus.retry(retryOptions);
        console.log(`Reset ${count} failed dispatch(es) to pending.`);
      } catch (error) {
        console.error(
          'Error retrying dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
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
    handler: async (_args: string[], options: any) => {
      try {
        const bus = await getDispatchBus();

        if (options.dry) {
          // Just show counts
          const { DispatchCollection } = await import(
            '@happyvertical/smrt-core'
          );
          const { getDatabase } = await import('@happyvertical/sql');
          const { getPackageConfig } = await import(
            '@happyvertical/smrt-config'
          );
          const { DEFAULT_CLI_CONFIG } = await import('../config.js');
          const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
          const db = await getDatabase(config.database);

          const completed = await DispatchCollection.countByStatus(
            db,
            'completed',
          );
          const failed = await DispatchCollection.countByStatus(db, 'failed');

          console.log(
            `\nCurrent counts:\n  Completed: ${completed}\n  Failed: ${failed}`,
          );
          const completedDays = options['completed-older-than'] || 30;
          console.log(
            `\nWould delete completed older than ${completedDays} days`,
          );
          if (options['failed-older-than']) {
            console.log(
              `Would delete failed older than ${options['failed-older-than']} days`,
            );
          }
          return;
        }

        const result = await bus.cleanup({
          completedOlderThanDays: options['completed-older-than'] || 30,
          failedOlderThanDays: options['failed-older-than'] || undefined,
        });

        console.log(`Cleanup complete:`);
        console.log(`  Completed deleted: ${result.completedDeleted}`);
        console.log(`  Failed deleted: ${result.failedDeleted}`);
      } catch (error) {
        console.error(
          'Error cleaning up dispatches:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
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
    handler: async (_args: string[], options: any) => {
      try {
        const bus = await getDispatchBus();
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
        process.exit(1);
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
    handler: async (args: string[], options: any) => {
      if (args.length < 2) {
        console.error(
          'Usage: smrt dispatch:subscribe <signal-type> <subscriber>',
        );
        process.exit(1);
      }

      const [signalType, subscriber] = args;

      try {
        const bus = await getDispatchBus();
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
        process.exit(1);
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

      try {
        const bus = await getDispatchBus();
        await bus.unsubscribe(signalType, subscriber);

        console.log(`Removed subscription: "${subscriber}" ← ${signalType}`);
      } catch (error) {
        console.error(
          'Error removing subscription:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },
};
