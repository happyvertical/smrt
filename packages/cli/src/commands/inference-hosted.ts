/**
 * `smrt inference:hosted <subcommand>` — hosted inference operations.
 *
 * One command group, several owners: each subcommand lives in its own
 * module and is listed in {@link INFERENCE_HOSTED_SUBCOMMANDS}, so adding
 * one never edits another's code. #4760 owns `enable` / `disable` /
 * `status` (the kill switch, `inference-hosted-switch.ts`); #4759 adds
 * `provision` / `revoke` the same way.
 */

import type { CLICommand } from '../cli-generator.js';
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
    'Hosted inference operations: disable | enable | status [--tenant <id>] (kill switch, #4760)',
  args: ['[subcommand]', '[args...]'],
  options: {
    tenant: {
      type: 'string',
      description: 'Apply to one tenant id instead of globally',
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
