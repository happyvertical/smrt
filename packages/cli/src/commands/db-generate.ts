/**
 * db:generate Command
 *
 * File-backed migrations are intentionally unsupported. SMRT schema
 * migrations are manifest-driven.
 */

import type { CLICommand } from '../cli-generator.js';

const UNSUPPORTED_MESSAGE =
  'File-backed SMRT migrations are not supported. SMRT schema migrations are manifest-driven; update @smrt object definitions and run smrt db:migrate.';

export const dbGenerateCommand: CLICommand = {
  name: 'db:generate',
  description: '[Unsupported] File-backed migrations are not supported',
  aliases: ['generate', 'migration-create', 'db:create'],
  args: ['<name>'],
  options: {
    sql: {
      type: 'boolean',
      description: 'Unsupported: file-backed migrations are not supported',
      default: true,
    },
    ts: {
      type: 'boolean',
      description: 'Unsupported: file-backed migrations are not supported',
      default: false,
    },
    timestamp: {
      type: 'boolean',
      description: 'Unsupported: file-backed migrations are not supported',
      default: false,
      short: 't',
    },
    output: {
      type: 'string',
      description: 'Unsupported: file-backed migrations are not supported',
      default: './migrations',
      short: 'o',
    },
    json: {
      type: 'boolean',
      description: 'Output as JSON',
      default: false,
      short: 'j',
    },
  },
  handler: async (_args: string[], options: any) => {
    if (options.json) {
      console.log(JSON.stringify({ error: UNSUPPORTED_MESSAGE }));
    } else {
      console.error(`\n❌ ${UNSUPPORTED_MESSAGE}\n`);
    }
    process.exitCode = 1;
  },
};
