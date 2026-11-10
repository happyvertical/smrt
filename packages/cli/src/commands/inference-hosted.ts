/**
 * `smrt inference:hosted <subcommand>` — hosted inference operations.
 *
 * One command group, several owners: each subcommand lives in its own
 * module and is listed in {@link INFERENCE_HOSTED_SUBCOMMANDS}, so adding
 * one never edits another's code. #4760 owns `enable` / `disable` /
 * `status` (the kill switch, `inference-hosted-switch.ts`); #4759 owns
 * `provision` / `revoke` (gateway keys, `inference-hosted-provision.ts`).
 */

import type { CLICommand } from '../cli-generator.js';
import { inferenceHostedProvisionSubcommands } from './inference-hosted-provision.js';
import { inferenceHostedSwitchSubcommands } from './inference-hosted-switch.js';

/** One `inference:hosted` subcommand. */
export interface InferenceHostedSubcommand {
  /** One line for `smrt inference:hosted help`. */
  summary: string;
  /** Usage line, e.g. `disable [--tenant <id>]`. */
  usage: string;
  run(args: string[], options: Record<string, unknown>): Promise<void>;
}

/** Every registered subcommand by name. */
export const INFERENCE_HOSTED_SUBCOMMANDS: Readonly<
  Record<string, InferenceHostedSubcommand>
> = Object.freeze({
  ...inferenceHostedProvisionSubcommands,
  ...inferenceHostedSwitchSubcommands,
});

/** `smrt inference:hosted help` text. */
export function formatInferenceHostedHelp(): string {
  const lines = ['Usage: smrt inference:hosted <subcommand> [options]', ''];
  for (const [name, sub] of Object.entries(INFERENCE_HOSTED_SUBCOMMANDS)) {
    lines.push(`  ${sub.usage.padEnd(34)} ${sub.summary}`);
    if (!sub.usage.startsWith(name)) lines.push(`    (${name})`);
  }
  return lines.join('\n');
}

export const inferenceHostedCommand: CLICommand = {
  name: 'inference:hosted',
  description:
    'Hosted inference operations: provision | revoke (gateway keys, #4759); disable | enable | status (kill switch, #4760)',
  args: ['[subcommand]', '[args...]'],
  options: {
    tenant: {
      type: 'string',
      description:
        'Tenant id: required by provision/revoke; scopes disable/enable/status to one tenant instead of globally',
    },
    user: {
      type: 'string',
      description: 'User id (provision, revoke)',
    },
    'budget-micros': {
      type: 'string',
      description: 'provision: spend cap in micro-dollars (USD x 1,000,000)',
    },
    'budget-usd': {
      type: 'string',
      description: 'provision: spend cap in USD, e.g. 20 or 7.50',
    },
    window: {
      type: 'string',
      description:
        'provision: budget reset window: day, week, month (default), year',
    },
    reason: {
      type: 'string',
      description:
        'revoke: reason recorded in the audit log (default: operator)',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (args: string[], options: Record<string, unknown>) => {
    const [name, ...rest] = args;
    if (!name || name === 'help') {
      console.log(formatInferenceHostedHelp());
      return;
    }
    const sub = Object.hasOwn(INFERENCE_HOSTED_SUBCOMMANDS, name)
      ? INFERENCE_HOSTED_SUBCOMMANDS[name]
      : undefined;
    if (!sub) {
      console.error(
        `\n❌ Unknown inference:hosted subcommand "${name}".\n\n${formatInferenceHostedHelp()}\n`,
      );
      process.exitCode = 1;
      return;
    }
    await sub.run(rest, options);
  },
};

export default inferenceHostedCommand;
