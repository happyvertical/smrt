/**
 * `smrt cookbook validate|apply` (#3748). See `agents/cookbook.md`.
 */

import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPackageManagerRunner } from '../app/runtime.js';
import type { CLICommand } from '../cli-generator.js';
import { ApplyError, applyCookbook } from './cookbook/apply.js';
import {
  asList,
  cliVersion,
  printApplyResult,
  readCookbookSource,
  validateCookbookSource,
} from './cookbook/shared.js';
import type { CookbookReport } from './cookbook/validate.js';
import { refreshScaffoldedProject } from './scaffold-agent-docs.js';

interface CookbookCliOptions {
  json?: boolean;
  manifests?: string[] | string;
  'no-registry'?: boolean;
  template?: string;
  into?: boolean;
  'dry-run'?: boolean;
  'no-install'?: boolean;
}

async function loadAndValidate(
  source: string,
  options: CookbookCliOptions,
  dir: string,
): Promise<CookbookReport> {
  return validateCookbookSource(await readCookbookSource(source), {
    dir,
    manifests: asList(options.manifests),
    registry: !options['no-registry'],
  });
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
  'source build': {
    name: 'source build',
    description:
      'Build this app or workspace SMRT dependency closure from SMRT_ROOT',
    args: [],
    options: {},
    handler: async () => {
      if (!process.env.SMRT_ROOT) return;
      const root = realpathSync(process.env.SMRT_ROOT);
      const { readdirSync } = await import('node:fs');
      const projects = [process.cwd()];
      try {
        for (const entry of readdirSync(join(process.cwd(), 'apps')))
          projects.push(join(process.cwd(), 'apps', entry));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      const packages = new Set<string>();
      for (const project of projects) {
        const pkg = JSON.parse(
          readFileSync(join(project, 'package.json'), 'utf8'),
        );
        for (const name of Object.keys({
          ...pkg.dependencies,
          ...pkg.devDependencies,
        }))
          if (name.startsWith('@happyvertical/smrt-')) packages.add(name);
      }
      createPackageManagerRunner(root)([
        'exec',
        'turbo',
        'run',
        'build',
        '--concurrency=2',
        ...[...packages].sort().map((name) => `--filter=${name}...`),
      ]);
    },
  },
  'cookbook prepare': {
    name: 'cookbook prepare',
    description:
      'Generate preserved app subclasses and the verified lazy host exposure superset',
    args: [],
    options: {},
    handler: async () => {
      const root = process.cwd();
      const require = createRequire(join(root, 'package.json'));
      const { prepareCookbookHost } = await import(
        pathToFileURL(
          require.resolve(
            '@happyvertical/smrt-template-sveltekit/host/generate',
          ),
        ).href
      );
      await prepareCookbookHost({ root });
    },
  },
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
      'Create a complete cookbook host, or safely update one with --into',
    args: ['file', 'dir'],
    options: {
      ...sharedOptions,
      template: {
        type: 'string',
        description:
          'Project template: a local path, github:owner/repo[#ref], or a git URL (default bundled:sveltekit)',
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
          installOutput: options.json ? 'stderr' : undefined,
          cliVersion: cliVersion(),
        });
        // After the project is written; stderr only, never fails the command (#4878).
        if (!result.dryRun) {
          await refreshScaffoldedProject(result.plan.targetDir);
        }
        if (options.json) {
          console.log(
            JSON.stringify(
              { ...result, warnings: [...report.warnings, ...result.warnings] },
              null,
              2,
            ),
          );
          return;
        }
        printApplyResult(result, report.warnings);
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
