/**
 * `smrt cookbook validate|apply` (#3748). See `agents/cookbook.md`.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CLICommand } from '../cli-generator.js';
import { ApplyError, applyCookbook } from './cookbook/apply.js';
import { resolveRecipeIndex } from './cookbook/recipe-index.js';
import {
  type CookbookReport,
  parseForResolution,
  validateCookbookText,
} from './cookbook/validate.js';

interface CookbookCliOptions {
  json?: boolean;
  manifests?: string[] | string;
  'no-registry'?: boolean;
  template?: string;
  into?: boolean;
  'dry-run'?: boolean;
  'no-install'?: boolean;
}

function cliVersion(): string {
  let current = dirname(fileURLToPath(import.meta.url));
  while (true) {
    try {
      const pkg = JSON.parse(
        readFileSync(join(current, 'package.json'), 'utf-8'),
      );
      if (pkg.name === '@happyvertical/smrt-cli' && pkg.version) {
        return pkg.version as string;
      }
    } catch {
      // keep walking up
    }
    const parent = dirname(current);
    if (parent === current) return '0.0.0';
    current = parent;
  }
}

async function readSource(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new ApplyError(
        `Could not fetch ${source}: HTTP ${response.status}`,
      );
    }
    return response.text();
  }
  try {
    return readFileSync(resolve(source), 'utf-8');
  } catch {
    throw new ApplyError(`Could not read cookbook file ${resolve(source)}`);
  }
}

const asList = (value: string[] | string | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

async function loadAndValidate(
  source: string,
  options: CookbookCliOptions,
  dir: string,
): Promise<CookbookReport> {
  const text = await readSource(source);
  const warnings: string[] = [];
  const index = await resolveRecipeIndex(parseForResolution(text), {
    dir,
    manifests: asList(options.manifests),
    registry: !options['no-registry'],
    warn: (message) => warnings.push(message),
  });
  const report = validateCookbookText(text, index);
  report.warnings.push(...warnings);
  return report;
}

function printReport(source: string, report: CookbookReport, json?: boolean) {
  if (json) {
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          source,
          errors: report.errors,
          warnings: report.warnings,
          packages: report.packages,
        },
        null,
        2,
      ),
    );
    return;
  }
  for (const warning of report.warnings) console.warn(`warning: ${warning}`);
  if (report.ok) {
    console.log(
      `${source} is a valid cookbook (${report.packages.length} package(s))`,
    );
    return;
  }
  console.error(`${source} is not a valid cookbook:`);
  for (const error of report.errors) console.error(`  - ${error}`);
}

const sharedOptions: CLICommand['options'] = {
  json: {
    type: 'boolean',
    description: 'Print machine-readable JSON',
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
};

export const cookbookCommands: Record<string, CLICommand> = {
  'cookbook validate': {
    name: 'cookbook validate',
    description:
      'Validate a cookbook (file or URL) against cookbook/v1 and the recipe manifests',
    args: ['file'],
    options: sharedOptions,
    handler: async (args: string[], options: CookbookCliOptions) => {
      const source = args[0];
      if (!source) {
        console.error('Usage: smrt cookbook validate <file|url> [--json]');
        process.exit(2);
      }
      let report: CookbookReport;
      try {
        report = await loadAndValidate(source, options, process.cwd());
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      printReport(source, report, options.json);
      if (!report.ok) process.exit(1);
    },
  },
  'cookbook apply': {
    name: 'cookbook apply',
    description:
      'Create a project from a cookbook (smrt-start template), or update one with --into',
    args: ['file', 'dir'],
    options: {
      ...sharedOptions,
      template: {
        type: 'string',
        description:
          'Project template: a local path, github:owner/repo[#ref], or a git URL (default github:happyvertical/smrt-start)',
      },
      into: {
        type: 'boolean',
        description:
          'Apply to an existing project (dir, default: current directory)',
        default: false,
      },
      'dry-run': {
        type: 'boolean',
        description: 'Print the planned changes without writing anything',
        default: false,
      },
      'no-install': {
        type: 'boolean',
        description: 'Skip the package install',
        default: false,
      },
    },
    handler: async (args: string[], options: CookbookCliOptions) => {
      const [source, dir] = args;
      if (!source) {
        console.error(
          'Usage: smrt cookbook apply <file|url> [dir] [--into] [--template <t>] [--dry-run] [--no-install]',
        );
        process.exit(2);
      }
      try {
        const report = await loadAndValidate(
          source,
          options,
          resolve(dir ?? '.'),
        );
        if (!report.ok || !report.cookbook) {
          printReport(source, report, options.json);
          process.exit(1);
        }
        const result = applyCookbook({
          cookbook: report.cookbook,
          packages: report.packages,
          dir,
          into: options.into,
          template: options.template,
          dryRun: options['dry-run'],
          install: !options['no-install'],
          cliVersion: cliVersion(),
        });
        if (options.json) {
          console.log(
            JSON.stringify({ ...result, warnings: report.warnings }, null, 2),
          );
          return;
        }
        for (const warning of report.warnings) {
          console.warn(`warning: ${warning}`);
        }
        const { plan } = result;
        console.log(
          `${result.dryRun ? 'Plan (dry run)' : 'Applied'}: ${plan.mode === 'new' ? 'new project' : 'update'} in ${plan.targetDir}`,
        );
        if (plan.template) {
          console.log(
            `  template: ${plan.template.spec}${plan.template.revision ? ` @ ${plan.template.revision}` : ''}`,
          );
        }
        if (plan.projectName) {
          console.log(`  project name: ${plan.projectName}`);
        }
        for (const [name, range] of Object.entries(plan.addDependencies)) {
          console.log(`  + ${name}@${range}`);
        }
        for (const [name, range] of Object.entries(plan.keptDependencies)) {
          console.log(`  = ${name}@${range} (already declared)`);
        }
        console.log(`  smrt.cookbook.json: ${plan.config}`);
        console.log('\nNext steps:');
        for (const step of result.nextSteps) console.log(`  ${step}`);
      } catch (error) {
        if (error instanceof ApplyError) {
          console.error(error.message);
          process.exit(1);
        }
        throw error;
      }
    },
  },
};
