/**
 * Job Commands - CLI tools for background job management
 *
 * Commands for managing background jobs and workers.
 */

import type { CLICommand } from '../cli-generator.js';

/**
 * Get job collection with database from config
 */
async function getJobCollection() {
  const { SmrtJobCollection } = await import('@happyvertical/smrt-jobs');
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');

  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  const dbConfig = config.database;

  if (!dbConfig?.url) {
    throw new Error(
      'Database not configured. Set database.url in smrt.config.ts or use --db option.',
    );
  }

  return SmrtJobCollection.create({
    db: {
      type: dbConfig.type || 'sqlite',
      url: dbConfig.url,
    },
  });
}

/**
 * Get task runner with database from config
 */
async function getTaskRunner(options: {
  concurrency?: number;
  queues?: string[];
  pollInterval?: number;
}) {
  const { TaskRunner } = await import('@happyvertical/smrt-jobs');
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

  const db = await getDatabase({
    type: dbConfig.type || 'sqlite',
    url: dbConfig.url,
  });

  const runner = new TaskRunner({
    concurrency: options.concurrency || 5,
    queues: options.queues,
    pollInterval: options.pollInterval || 5000,
  });

  await runner.initialize(db);
  return runner;
}

/**
 * Job management commands
 */
export const jobCommands: Record<string, CLICommand> = {
  'job:list': {
    name: 'job:list',
    description: 'List background jobs',
    args: [],
    options: {
      status: {
        type: 'string',
        description:
          'Filter by status (pending|running|completed|failed|cancelled)',
        short: 's',
      },
      queue: {
        type: 'string',
        description: 'Filter by queue name',
        short: 'q',
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
        const collection = await getJobCollection();

        let jobs: Awaited<ReturnType<typeof collection.list>>;
        if (options.status) {
          jobs = await collection.listByStatus(options.status, {
            queue: options.queue,
            limit: options.limit || 50,
          });
        } else {
          const where: Record<string, unknown> = {};
          if (options.queue) {
            where.queue = options.queue;
          }
          jobs = await collection.list({
            where,
            orderBy: ['priority DESC', 'run_at ASC'],
            limit: options.limit || 50,
          });
        }

        if (options.json) {
          console.log(JSON.stringify(jobs, null, 2));
          return;
        }

        if (jobs.length === 0) {
          console.log('No jobs found.');
          return;
        }

        console.log(`\nFound ${jobs.length} job(s):\n`);
        console.log(
          'ID'.padEnd(12) +
            'OBJECT'.padEnd(20) +
            'METHOD'.padEnd(15) +
            'QUEUE'.padEnd(12) +
            'STATUS'.padEnd(12) +
            'ATTEMPTS',
        );
        console.log('-'.repeat(83));

        for (const job of jobs) {
          const object = job.objectId
            ? `${job.objectType}#${job.objectId.substring(0, 6)}`
            : job.objectType;
          const jobId = job.id || '-';
          console.log(
            jobId.substring(0, 10).padEnd(12) +
              object.substring(0, 18).padEnd(20) +
              job.method.substring(0, 13).padEnd(15) +
              job.queue.substring(0, 10).padEnd(12) +
              job.status.padEnd(12) +
              `${job.attempts}/${job.maxAttempts}`,
          );
        }
        console.log();
      } catch (error) {
        console.error(
          'Error listing jobs:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'job:get': {
    name: 'job:get',
    description: 'Get details of a specific job',
    args: ['<id>'],
    options: {
      json: {
        type: 'boolean',
        description: 'Output as JSON',
        short: 'j',
        default: false,
      },
    },
    handler: async (args: string[], options: any) => {
      if (args.length < 1) {
        console.error('Usage: smrt job:get <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getJobCollection();
        const job = await collection.get(id);

        if (!job) {
          console.error(`Job not found: ${id}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(job, null, 2));
          return;
        }

        console.log('\nJob Details:');
        console.log('─'.repeat(50));
        console.log(`ID:           ${job.id}`);
        console.log(`Description:  ${job.getDescription()}`);
        console.log(`Queue:        ${job.queue}`);
        console.log(`Status:       ${job.status}`);
        console.log(`Priority:     ${job.priority}`);
        console.log(`Attempts:     ${job.attempts}/${job.maxAttempts}`);
        console.log(`Timeout:      ${job.timeout}ms`);
        console.log(`Run At:       ${job.runAt.toISOString()}`);

        if (job.startedAt) {
          console.log(`Started At:   ${job.startedAt.toISOString()}`);
        }
        if (job.completedAt) {
          console.log(`Completed At: ${job.completedAt.toISOString()}`);
        }
        if (job.lastError) {
          console.log(`Last Error:   ${job.lastError}`);
        }
        if (job.resultPointer) {
          console.log(`Result:       ${job.resultPointer}`);
        }

        console.log('\nArguments:');
        console.log(JSON.stringify(job.args, null, 2));
        console.log();
      } catch (error) {
        console.error(
          'Error getting job:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'job:retry': {
    name: 'job:retry',
    description: 'Retry a failed or cancelled job',
    args: ['<id>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 1) {
        console.error('Usage: smrt job:retry <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getJobCollection();
        const job = await collection.get(id);

        if (!job) {
          console.error(`Job not found: ${id}`);
          process.exit(1);
        }

        await job.retry();
        console.log(`Job ${id} reset to pending and will be retried.`);
      } catch (error) {
        console.error(
          'Error retrying job:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'job:cancel': {
    name: 'job:cancel',
    description: 'Cancel a pending or running job',
    args: ['<id>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 1) {
        console.error('Usage: smrt job:cancel <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getJobCollection();
        const job = await collection.get(id);

        if (!job) {
          console.error(`Job not found: ${id}`);
          process.exit(1);
        }

        await job.cancel();
        console.log(`Job ${id} has been cancelled.`);
      } catch (error) {
        console.error(
          'Error cancelling job:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'job:stats': {
    name: 'job:stats',
    description: 'Show job queue statistics',
    args: [],
    options: {
      queue: {
        type: 'string',
        description: 'Filter by queue name',
        short: 'q',
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
        const collection = await getJobCollection();
        const stats = await collection.stats(options.queue);

        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        const queue = options.queue || 'all queues';
        console.log(`\nJob Statistics (${queue}):`);
        console.log('─'.repeat(30));
        console.log(`Pending:     ${stats.pending}`);
        console.log(`Running:     ${stats.running}`);
        console.log(`Completed:   ${stats.completed}`);
        console.log(`Failed:      ${stats.failed}`);
        console.log(`Cancelled:   ${stats.cancelled}`);
        console.log('─'.repeat(30));
        console.log(
          `Total:       ${stats.pending + stats.running + stats.completed + stats.failed + stats.cancelled}`,
        );
        console.log();
      } catch (error) {
        console.error(
          'Error getting stats:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'job:work': {
    name: 'job:work',
    description: 'Start a job worker to process background jobs',
    args: [],
    options: {
      concurrency: {
        type: 'number',
        description: 'Number of concurrent jobs (default: 5)',
        short: 'c',
        default: 5,
      },
      queues: {
        type: 'string',
        description: 'Comma-separated list of queues to process',
        short: 'q',
      },
      'poll-interval': {
        type: 'number',
        description: 'Poll interval in milliseconds (default: 5000)',
        short: 'p',
        default: 5000,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        const queues = options.queues
          ? options.queues.split(',').map((q: string) => q.trim())
          : undefined;

        const runner = await getTaskRunner({
          concurrency: options.concurrency,
          queues,
          pollInterval: options['poll-interval'],
        });

        console.log('\n🚀 Starting job worker...');
        console.log(`   Concurrency: ${options.concurrency || 5}`);
        console.log(`   Queues: ${queues ? queues.join(', ') : 'all'}`);
        console.log(`   Poll Interval: ${options['poll-interval'] || 5000}ms`);
        console.log('\nPress Ctrl+C to stop.\n');

        // Handle shutdown signals
        const shutdown = async (signal: string) => {
          console.log(`\n${signal} received, shutting down gracefully...`);
          await runner.stop();
          console.log('Worker stopped.');
          process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // Start the runner
        await runner.start();

        // Keep process alive
        await new Promise(() => {
          // This will never resolve, keeping the worker running
        });
      } catch (error) {
        console.error(
          'Error starting worker:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'job:cleanup': {
    name: 'job:cleanup',
    description: 'Clean up old completed/failed jobs',
    args: [],
    options: {
      'completed-older-than': {
        type: 'number',
        description: 'Delete completed jobs older than N days (default: 7)',
        short: 'c',
        default: 7,
      },
      'failed-older-than': {
        type: 'number',
        description: 'Delete failed jobs older than N days',
        short: 'f',
      },
      'cancelled-older-than': {
        type: 'number',
        description: 'Delete cancelled jobs older than N days',
      },
      limit: {
        type: 'number',
        description: 'Maximum jobs to delete (default: unlimited)',
        short: 'l',
      },
      dry: {
        type: 'boolean',
        description: 'Show what would be deleted without executing',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        const collection = await getJobCollection();

        if (options.dry) {
          const stats = await collection.stats();
          console.log('\nCurrent counts:');
          console.log(`  Completed: ${stats.completed}`);
          console.log(`  Failed: ${stats.failed}`);
          console.log(`  Cancelled: ${stats.cancelled}`);
          console.log(
            `\nWould delete completed older than ${options['completed-older-than'] || 7} days`,
          );
          if (options['failed-older-than']) {
            console.log(
              `Would delete failed older than ${options['failed-older-than']} days`,
            );
          }
          if (options['cancelled-older-than']) {
            console.log(
              `Would delete cancelled older than ${options['cancelled-older-than']} days`,
            );
          }
          return;
        }

        const now = Date.now();
        const daysToMs = (days: number) => days * 24 * 60 * 60 * 1000;

        const cleanupOptions: {
          completedBefore?: Date;
          failedBefore?: Date;
          cancelledBefore?: Date;
          limit?: number;
        } = {};

        if (options['completed-older-than']) {
          cleanupOptions.completedBefore = new Date(
            now - daysToMs(options['completed-older-than']),
          );
        }
        if (options['failed-older-than']) {
          cleanupOptions.failedBefore = new Date(
            now - daysToMs(options['failed-older-than']),
          );
        }
        if (options['cancelled-older-than']) {
          cleanupOptions.cancelledBefore = new Date(
            now - daysToMs(options['cancelled-older-than']),
          );
        }
        if (options.limit) {
          cleanupOptions.limit = options.limit;
        }

        const deleted = await collection.cleanup(cleanupOptions);
        console.log(`Cleaned up ${deleted} job(s).`);
      } catch (error) {
        console.error(
          'Error cleaning up jobs:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },
};
