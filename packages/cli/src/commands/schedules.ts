/**
 * Schedule Commands - CLI tools for agent scheduling
 *
 * Commands for managing scheduled agent executions.
 */

import type { CLICommand } from '../cli-generator.js';

/**
 * Get schedule collection with database from config
 */
async function getScheduleCollection() {
  const { AgentScheduleCollection } = await import(
    '@happyvertical/smrt-agents'
  );
  const { getPackageConfig } = await import('@happyvertical/smrt-config');
  const { DEFAULT_CLI_CONFIG } = await import('../config.js');

  const config = getPackageConfig('cli', DEFAULT_CLI_CONFIG);
  const dbConfig = config.database;

  if (!dbConfig?.url) {
    throw new Error(
      'Database not configured. Set database.url in smrt.config.ts or use --db option.',
    );
  }

  return AgentScheduleCollection.create({
    db: {
      type: dbConfig.type || 'sqlite',
      url: dbConfig.url,
    },
  });
}

/**
 * Get schedule runner with database from config
 */
async function getScheduleRunner(options: { pollInterval?: number } = {}) {
  const { ScheduleRunner } = await import('@happyvertical/smrt-jobs');
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

  const runner = new ScheduleRunner({
    pollInterval: options.pollInterval || 60000,
  });

  await runner.initialize(db);
  return runner;
}

/**
 * Schedule management commands
 */
export const scheduleCommands: Record<string, CLICommand> = {
  'schedule:list': {
    name: 'schedule:list',
    description: 'List agent schedules',
    args: [],
    options: {
      status: {
        type: 'string',
        description: 'Filter by status (active|paused|disabled|error)',
        short: 's',
      },
      agent: {
        type: 'string',
        description: 'Filter by agent type',
        short: 'a',
      },
      'include-disabled': {
        type: 'boolean',
        description: 'Include disabled schedules',
        default: false,
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
        const collection = await getScheduleCollection();

        let schedules: Awaited<ReturnType<typeof collection.list>>;
        if (options.status) {
          schedules = await collection.listByStatus(options.status);
        } else if (options.agent) {
          schedules = await collection.listByAgentType(options.agent, {
            includeDisabled: options['include-disabled'],
          });
        } else {
          schedules = await collection.list({
            orderBy: 'next_run ASC',
          });
        }

        if (options.json) {
          console.log(JSON.stringify(schedules, null, 2));
          return;
        }

        if (schedules.length === 0) {
          console.log('No schedules found.');
          return;
        }

        console.log(`\nFound ${schedules.length} schedule(s):\n`);
        console.log(
          'ID'.padEnd(12) +
            'AGENT'.padEnd(20) +
            'CRON'.padEnd(18) +
            'STATUS'.padEnd(10) +
            'NEXT RUN',
        );
        console.log('-'.repeat(78));

        for (const schedule of schedules) {
          const agent = schedule.agentId
            ? `${schedule.agentType}#${schedule.agentId.substring(0, 6)}`
            : schedule.agentType;
          const nextRun = schedule.nextRun
            ? schedule.nextRun.toISOString().substring(0, 19)
            : '-';
          const scheduleId = schedule.id || '-';
          console.log(
            scheduleId.substring(0, 10).padEnd(12) +
              agent.substring(0, 18).padEnd(20) +
              schedule.cron.substring(0, 16).padEnd(18) +
              schedule.status.padEnd(10) +
              nextRun,
          );
        }
        console.log();
      } catch (error) {
        console.error(
          'Error listing schedules:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:get': {
    name: 'schedule:get',
    description: 'Get details of a specific schedule',
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
        console.error('Usage: smrt schedule:get <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.get(id);

        if (!schedule) {
          console.error(`Schedule not found: ${id}`);
          process.exit(1);
        }

        if (options.json) {
          console.log(JSON.stringify(schedule, null, 2));
          return;
        }

        console.log('\nSchedule Details:');
        console.log('─'.repeat(50));
        console.log(`ID:           ${schedule.id}`);
        console.log(`Description:  ${schedule.getDescription()}`);
        console.log(`Agent Type:   ${schedule.agentType}`);
        console.log(`Agent ID:     ${schedule.agentId || '-'}`);
        console.log(`Cron:         ${schedule.cron}`);
        console.log(`Timezone:     ${schedule.timezone}`);
        console.log(`Status:       ${schedule.status}`);
        console.log(`Enabled:      ${schedule.enabled ? 'yes' : 'no'}`);
        console.log(`Method:       ${schedule.method}`);
        console.log(`Max Concurrent: ${schedule.maxConcurrent}`);
        console.log(`Timeout:      ${schedule.timeout}ms`);

        console.log('\nExecution Stats:');
        console.log(`  Total Runs:   ${schedule.runCount}`);
        console.log(`  Successes:    ${schedule.successCount}`);
        console.log(`  Failures:     ${schedule.failureCount}`);
        console.log(`  Running Now:  ${schedule.runningCount}`);

        if (schedule.lastRun) {
          console.log(`\nLast Run:     ${schedule.lastRun.toISOString()}`);
          console.log(`Last Status:  ${schedule.lastStatus || '-'}`);
        }
        if (schedule.lastError) {
          console.log(`Last Error:   ${schedule.lastError}`);
        }
        if (schedule.nextRun) {
          console.log(`\nNext Run:     ${schedule.nextRun.toISOString()}`);
        }

        if (Object.keys(schedule.agentConfig).length > 0) {
          console.log('\nAgent Config:');
          console.log(JSON.stringify(schedule.agentConfig, null, 2));
        }

        if (Object.keys(schedule.methodArgs).length > 0) {
          console.log('\nMethod Args:');
          console.log(JSON.stringify(schedule.methodArgs, null, 2));
        }
        console.log();
      } catch (error) {
        console.error(
          'Error getting schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:create': {
    name: 'schedule:create',
    description: 'Create a new agent schedule',
    args: ['<agent-type>'],
    options: {
      cron: {
        type: 'string',
        description: 'Cron expression (required)',
        short: 'c',
      },
      'agent-id': {
        type: 'string',
        description: 'Specific agent instance ID',
        short: 'i',
      },
      timezone: {
        type: 'string',
        description: 'Timezone (default: UTC)',
        short: 't',
        default: 'UTC',
      },
      method: {
        type: 'string',
        description: 'Method to call (default: run)',
        short: 'm',
        default: 'run',
      },
      'max-concurrent': {
        type: 'number',
        description: 'Maximum concurrent runs (default: 1)',
        default: 1,
      },
      timeout: {
        type: 'number',
        description: 'Timeout in milliseconds (default: 3600000)',
        default: 3600000,
      },
      disabled: {
        type: 'boolean',
        description: 'Create in disabled state',
        default: false,
      },
    },
    handler: async (args: string[], options: any) => {
      if (args.length < 1) {
        console.error('Usage: smrt schedule:create <agent-type> --cron "..."');
        process.exit(1);
      }

      if (!options.cron) {
        console.error('Error: --cron option is required');
        process.exit(1);
      }

      const [agentType] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.create({
          agentType,
          agentId: options['agent-id'] || null,
          cron: options.cron,
          timezone: options.timezone,
          method: options.method,
          maxConcurrent: options['max-concurrent'],
          timeout: options.timeout,
          enabled: !options.disabled,
          status: options.disabled ? 'disabled' : 'active',
        });

        await schedule.save();

        console.log(`\nCreated schedule: ${schedule.id}`);
        console.log(`Description: ${schedule.getDescription()}`);
        if (schedule.nextRun) {
          console.log(`Next run: ${schedule.nextRun.toISOString()}`);
        }
        console.log();
      } catch (error) {
        console.error(
          'Error creating schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:enable': {
    name: 'schedule:enable',
    description: 'Enable a schedule',
    args: ['<id>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 1) {
        console.error('Usage: smrt schedule:enable <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.get(id);

        if (!schedule) {
          console.error(`Schedule not found: ${id}`);
          process.exit(1);
        }

        await schedule.enable();
        console.log(`Schedule ${id} enabled.`);
        if (schedule.nextRun) {
          console.log(`Next run: ${schedule.nextRun.toISOString()}`);
        }
      } catch (error) {
        console.error(
          'Error enabling schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:disable': {
    name: 'schedule:disable',
    description: 'Disable a schedule',
    args: ['<id>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 1) {
        console.error('Usage: smrt schedule:disable <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.get(id);

        if (!schedule) {
          console.error(`Schedule not found: ${id}`);
          process.exit(1);
        }

        await schedule.disable();
        console.log(`Schedule ${id} disabled.`);
      } catch (error) {
        console.error(
          'Error disabling schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:pause': {
    name: 'schedule:pause',
    description: 'Temporarily pause a schedule',
    args: ['<id>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 1) {
        console.error('Usage: smrt schedule:pause <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.get(id);

        if (!schedule) {
          console.error(`Schedule not found: ${id}`);
          process.exit(1);
        }

        await schedule.pause();
        console.log(`Schedule ${id} paused.`);
      } catch (error) {
        console.error(
          'Error pausing schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:resume': {
    name: 'schedule:resume',
    description: 'Resume a paused schedule',
    args: ['<id>'],
    options: {},
    handler: async (args: string[]) => {
      if (args.length < 1) {
        console.error('Usage: smrt schedule:resume <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.get(id);

        if (!schedule) {
          console.error(`Schedule not found: ${id}`);
          process.exit(1);
        }

        await schedule.resume();
        console.log(`Schedule ${id} resumed.`);
        if (schedule.nextRun) {
          console.log(`Next run: ${schedule.nextRun.toISOString()}`);
        }
      } catch (error) {
        console.error(
          'Error resuming schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:delete': {
    name: 'schedule:delete',
    description: 'Delete a schedule',
    args: ['<id>'],
    options: {
      force: {
        type: 'boolean',
        description: 'Skip confirmation',
        short: 'f',
        default: false,
      },
    },
    handler: async (args: string[], options: any) => {
      if (args.length < 1) {
        console.error('Usage: smrt schedule:delete <id>');
        process.exit(1);
      }

      const [id] = args;

      try {
        const collection = await getScheduleCollection();
        const schedule = await collection.get(id);

        if (!schedule) {
          console.error(`Schedule not found: ${id}`);
          process.exit(1);
        }

        if (!options.force) {
          const readline = await import('node:readline');
          const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout,
          });

          const answer = await new Promise<string>((resolve) => {
            rl.question(
              `Delete schedule "${schedule.getDescription()}"? [y/N] `,
              resolve,
            );
          });
          rl.close();

          if (answer.toLowerCase() !== 'y') {
            console.log('Cancelled.');
            return;
          }
        }

        await schedule.delete();
        console.log(`Schedule ${id} deleted.`);
      } catch (error) {
        console.error(
          'Error deleting schedule:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },

  'schedule:stats': {
    name: 'schedule:stats',
    description: 'Show schedule statistics',
    args: [],
    options: {
      json: {
        type: 'boolean',
        description: 'Output as JSON',
        short: 'j',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        const collection = await getScheduleCollection();
        const stats = await collection.stats();

        if (options.json) {
          console.log(JSON.stringify(stats, null, 2));
          return;
        }

        console.log('\nSchedule Statistics:');
        console.log('─'.repeat(30));
        console.log(`Active:      ${stats.active}`);
        console.log(`Paused:      ${stats.paused}`);
        console.log(`Disabled:    ${stats.disabled}`);
        console.log(`Error:       ${stats.error}`);
        console.log('─'.repeat(30));
        console.log(`Total:       ${stats.total}`);
        console.log(`Due Now:     ${stats.dueNow}`);
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

  'schedule:run': {
    name: 'schedule:run',
    description: 'Start the schedule runner to process due schedules',
    args: [],
    options: {
      'poll-interval': {
        type: 'number',
        description: 'Poll interval in milliseconds (default: 60000)',
        short: 'p',
        default: 60000,
      },
      once: {
        type: 'boolean',
        description: 'Run once and exit',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      try {
        const runner = await getScheduleRunner({
          pollInterval: options['poll-interval'],
        });

        if (options.once) {
          console.log('Checking for due schedules...');
          const processed = await runner.processOnce();
          console.log(`Processed ${processed} schedule(s).`);
          return;
        }

        console.log('\n📅 Starting schedule runner...');
        console.log(`   Poll Interval: ${options['poll-interval'] || 60000}ms`);
        console.log('\nPress Ctrl+C to stop.\n');

        // Handle shutdown signals
        const shutdown = async (signal: string) => {
          console.log(`\n${signal} received, shutting down gracefully...`);
          await runner.stop();
          console.log('Schedule runner stopped.');
          process.exit(0);
        };

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));

        // Start the runner
        await runner.start();

        // Keep process alive
        await new Promise(() => {
          // This will never resolve, keeping the runner running
        });
      } catch (error) {
        console.error(
          'Error starting schedule runner:',
          error instanceof Error ? error.message : error,
        );
        process.exit(1);
      }
    },
  },
};
