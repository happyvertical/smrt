/**
 * dev:knowledge-* commands
 *
 * Deterministic SMRT agentic-development knowledge tooling. These commands do
 * not call model providers; they produce local facts and portable prompt
 * bundles for Codex, Claude, or another downstream model.
 */

import {
  buildKnowledgeIndex,
  checkKnowledgeFreshness,
  diffKnowledgeIndex,
  renderFreshnessResult,
  renderKnowledgeIndexMarkdown,
} from '@happyvertical/smrt-dev-mcp/knowledge';
import type { CLICommand } from '../cli-generator.js';

export const devKnowledgeCommands: Record<string, CLICommand> = {
  'dev:knowledge-index': {
    name: 'dev:knowledge-index',
    description:
      'Print the deterministic SMRT + HappyVertical SDK knowledge index',
    aliases: ['knowledge:index'],
    args: [],
    options: {
      format: {
        type: 'string',
        description: 'Output format: json or markdown',
        default: 'json',
        short: 'f',
      },
    },
    handler: async (_args: string[], options: any) => {
      const index = await buildKnowledgeIndex();
      if (options.format === 'markdown') {
        console.log(renderKnowledgeIndexMarkdown(index));
        return;
      }
      console.log(JSON.stringify(index, null, 2));
    },
  },

  'dev:knowledge-check': {
    name: 'dev:knowledge-check',
    description: 'Check deterministic freshness of SMRT agent knowledge',
    aliases: ['knowledge:check'],
    args: [],
    options: {
      changed: {
        type: 'boolean',
        description: 'Limit stale-pattern checks to changed files',
        default: false,
      },
      strict: {
        type: 'boolean',
        description: 'Treat stale-pattern findings as errors',
        default: false,
      },
      json: {
        type: 'boolean',
        description: 'Print JSON output',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      const result = await checkKnowledgeFreshness({
        changed: Boolean(options.changed),
        strict: Boolean(options.strict),
      });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(renderFreshnessResult(result));
      }
      if (!result.ok) process.exit(1);
    },
  },

  'dev:knowledge-diff': {
    name: 'dev:knowledge-diff',
    description: 'Show changed files and affected SMRT packages for a git base',
    aliases: ['knowledge:diff'],
    args: [],
    options: {
      base: {
        type: 'string',
        description: 'Git base ref for diffing',
        default: 'HEAD',
        short: 'b',
      },
      json: {
        type: 'boolean',
        description: 'Print JSON output',
        default: false,
      },
    },
    handler: async (_args: string[], options: any) => {
      const result = await diffKnowledgeIndex({ base: options.base ?? 'HEAD' });
      if (options.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Base: ${result.base}`);
      console.log(`Changed files: ${result.changedFiles.length}`);
      for (const file of result.changedFiles) console.log(`- ${file}`);
      console.log('');
      console.log(`Changed packages: ${result.changedPackages.length}`);
      for (const pkg of result.changedPackages) console.log(`- ${pkg}`);
    },
  },
};
