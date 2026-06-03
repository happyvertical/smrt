/**
 * dev:knowledge-* commands
 *
 * Deterministic SMRT agentic-development knowledge tooling. These commands do
 * not call model providers; they produce local facts and portable prompt
 * bundles for Codex, Claude, or another downstream model.
 */

import {
  buildArchitectureContext,
  buildKnowledgeIndex,
  buildReviewContext,
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
      scope: {
        type: 'string',
        description: 'Knowledge scope: project, local, package, or sdk',
        default: 'project',
      },
      package: {
        type: 'string',
        description: 'Package name or short name to focus',
      },
    },
    handler: async (_args: string[], options: any) => {
      const index = await buildKnowledgeIndex({
        scope: options.scope,
        package: options.package,
      });
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
      format: {
        type: 'string',
        description: 'Output format: markdown or json',
        default: 'markdown',
        short: 'f',
      },
      json: {
        type: 'boolean',
        description: 'Deprecated alias for --format json',
        default: false,
      },
      scope: {
        type: 'string',
        description: 'Knowledge scope: project, local, package, or sdk',
        default: 'project',
      },
      package: {
        type: 'string',
        description: 'Package name or short name to focus',
      },
    },
    handler: async (_args: string[], options: any) => {
      const result = await checkKnowledgeFreshness({
        changed: Boolean(options.changed),
        strict: Boolean(options.strict),
        scope: options.scope,
        package: options.package,
      });
      const format = options.json ? 'json' : options.format;
      if (format === 'json') {
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
      format: {
        type: 'string',
        description: 'Output format: markdown or json',
        default: 'markdown',
        short: 'f',
      },
      json: {
        type: 'boolean',
        description: 'Deprecated alias for --format json',
        default: false,
      },
      scope: {
        type: 'string',
        description: 'Knowledge scope: project, local, package, or sdk',
        default: 'project',
      },
      package: {
        type: 'string',
        description: 'Package name or short name to focus',
      },
    },
    handler: async (_args: string[], options: any) => {
      const result = await diffKnowledgeIndex({
        base: options.base ?? 'HEAD',
        scope: options.scope,
        package: options.package,
      });
      const format = options.json ? 'json' : options.format;
      if (format === 'json') {
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

  'dev:knowledge-review-context': {
    name: 'dev:knowledge-review-context',
    description: 'Build domain-scoped model-ready SMRT code review context',
    aliases: ['knowledge:review-context'],
    args: [],
    options: contextOptions('markdown'),
    handler: async (args: string[], options: any) => {
      const result = await buildReviewContext({
        focus: args.join(' ') || options.focus,
        scope: options.scope,
        package: options.package,
      });
      const format = options.json ? 'json' : options.format;
      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderContextMarkdown(result));
    },
  },

  'dev:knowledge-architecture-context': {
    name: 'dev:knowledge-architecture-context',
    description: 'Build domain-scoped model-ready SMRT architecture context',
    aliases: ['knowledge:architecture-context'],
    args: [],
    options: contextOptions('markdown'),
    handler: async (args: string[], options: any) => {
      const result = await buildArchitectureContext({
        idea: args.join(' ') || options.idea,
        focus: options.focus,
        scope: options.scope,
        package: options.package,
      });
      const format = options.json ? 'json' : options.format;
      if (format === 'json') {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(renderContextMarkdown(result));
    },
  },
};

function contextOptions(
  defaultFormat: 'markdown' | 'json',
): NonNullable<CLICommand['options']> {
  return {
    format: {
      type: 'string',
      description: 'Output format: markdown or json',
      default: defaultFormat,
      short: 'f',
    },
    json: {
      type: 'boolean',
      description: 'Deprecated alias for --format json',
      default: false,
    },
    scope: {
      type: 'string',
      description: 'Knowledge scope: project, local, package, or sdk',
      default: 'project',
    },
    package: {
      type: 'string',
      description: 'Package name or short name to focus',
    },
    focus: {
      type: 'string',
      description: 'Additional review or architecture focus text',
    },
    idea: {
      type: 'string',
      description: 'Architecture idea text',
    },
  };
}

function renderContextMarkdown(result: {
  selectedPackages: Array<{ name: string }>;
  selectedSdkPackages: Array<{ name: string }>;
  deterministicFindings?: Array<{
    severity: string;
    code: string;
    message: string;
    file?: string;
  }>;
  promptBundle: { contextMarkdown: string };
}): string {
  const lines = [
    '# SMRT Domain Context',
    '',
    `Selected packages: ${result.selectedPackages.map((pkg) => pkg.name).join(', ') || '(none)'}`,
    `Selected SDK packages: ${result.selectedSdkPackages.map((pkg) => pkg.name).join(', ') || '(none)'}`,
    '',
  ];
  if (result.deterministicFindings) {
    lines.push('## Deterministic Findings', '');
    for (const finding of result.deterministicFindings) {
      const file = finding.file ? ` (${finding.file})` : '';
      lines.push(
        `- [${finding.severity.toUpperCase()}] ${finding.code}: ${finding.message}${file}`,
      );
    }
    lines.push('');
  }
  lines.push('## Prompt Bundle', '', result.promptBundle.contextMarkdown);
  return lines.join('\n');
}
