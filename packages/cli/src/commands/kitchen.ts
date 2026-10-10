/**
 * `smrt kitchen [dir]` and `smrt kitchen apply <url|file> [dir]` (#3750).
 * See `agents/kitchen.md`.
 */

import { resolve } from 'node:path';
import type { CLICommand } from '../cli-generator.js';
import { ApplyError } from './cookbook/apply.js';
import { asList } from './cookbook/shared.js';
import { cookbookCommands } from './cookbook.js';
import { PlannerError } from './kitchen/planner.js';
import { runKitchen } from './kitchen/run.js';

interface KitchenCliOptions {
  planner?: string;
  template?: string;
  'no-open'?: boolean;
  'no-install'?: boolean;
  'no-registry'?: boolean;
  manifests?: string[] | string;
  port?: number | string;
}

/** Ctrl-C and SIGTERM stop the kitchen cleanly (the server is closed in `finally`). */
function stopOnSignal(): { stop: Promise<never>; dispose(): void } {
  let dispose = () => {};
  const stop = new Promise<never>((_, reject) => {
    const onSignal = (signal: NodeJS.Signals) => {
      reject(new KitchenStopped(signal));
    };
    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    dispose = () => {
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
    };
  });
  // The race may never reject; an unobserved rejection must not crash.
  stop.catch(() => {});
  return { stop, dispose };
}

class KitchenStopped extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`stopped by ${signal}`);
  }
}

const apply = cookbookCommands['cookbook apply'];

export const kitchenCommands: Record<string, CLICommand> = {
  kitchen: {
    name: 'kitchen',
    description:
      'Run the planner on localhost, chat your way to a cookbook, and apply it into [dir]',
    args: ['dir'],
    options: {
      planner: {
        type: 'string',
        description:
          'Use a packaged planner checkout (run `pnpm package` there) instead of the cached registry copy',
      },
      template: {
        type: 'string',
        description:
          'Project template: a local path, github:owner/repo[#ref], or a git URL (default github:happyvertical/smrt-start)',
      },
      'no-open': {
        type: 'boolean',
        description: 'Do not open the browser; print the address only',
        default: false,
      },
      'no-install': {
        type: 'boolean',
        description: 'Skip the package install after the project is written',
        default: false,
      },
      manifests: {
        type: 'string',
        description:
          'Extra package manifests (file or directory); repeatable. Searched before the workspace, node_modules and the registry',
        multiple: true,
      },
      'no-registry': {
        type: 'boolean',
        description:
          'Do not fetch manifests of uninstalled packages from the registry',
        default: false,
      },
      port: {
        type: 'number',
        description: 'Listen on this port (default: a random free port)',
      },
    },
    handler: async (args: string[], options: KitchenCliOptions) => {
      const dir = resolve(args[0] ?? '.');
      const { stop, dispose } = stopOnSignal();
      try {
        const applied = await runKitchen({
          dir,
          planner: options.planner,
          template: options.template,
          install: !options['no-install'],
          open: !options['no-open'],
          manifests: asList(options.manifests),
          registry: !options['no-registry'],
          port: options.port === undefined ? undefined : Number(options.port),
          stop,
        });
        console.log(
          `\nDone: ${applied.mode === 'new' ? 'created' : 'updated'} the project in ${applied.dir}`,
        );
        if (applied.added.length) {
          console.log(`  packages added: ${applied.added.join(', ')}`);
        }
        console.log('\nNext steps:');
        for (const step of applied.nextSteps) console.log(`  ${step}`);
        console.log('  pnpm dev');
      } catch (error) {
        if (error instanceof KitchenStopped) {
          console.log('\nKitchen closed.');
          process.exitCode = 130;
          return;
        }
        if (error instanceof PlannerError || error instanceof ApplyError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      } finally {
        dispose();
      }
    },
  },
  'kitchen apply': {
    ...apply,
    name: 'kitchen apply',
    description:
      'Apply a cookbook made elsewhere (file, cookbook URL or plan.s-m-r-t.dev plan URL) to a new project; same as `cookbook apply`',
  },
};
