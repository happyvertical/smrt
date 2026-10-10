/**
 * Pieces of `smrt cookbook` that `smrt kitchen` (#3750) reuses: reading a
 * cookbook source, validating it against the recipe index, and printing an
 * apply result.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ApplyError, type ApplyResult } from './apply.js';
import { resolveRecipeIndex } from './recipe-index.js';
import {
  type CookbookReport,
  parseForResolution,
  validateCookbookText,
} from './validate.js';

/** Version of this CLI: the last-resort range for packages a cookbook adds. */
export function cliVersion(): string {
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

/** A cookbook is a small JSON file; the kitchen accepts at most 2 MB too. */
const MAX_COOKBOOK_CHARS = 2 * 1024 * 1024;

/** Cookbook text from a file path or an http(s) URL. */
export async function readCookbookSource(source: string): Promise<string> {
  if (/^https?:\/\//.test(source)) {
    const response = await fetch(source);
    if (!response.ok) {
      throw new ApplyError(
        `Could not fetch ${source}: HTTP ${response.status}`,
      );
    }
    const text = await response.text();
    if (text.length > MAX_COOKBOOK_CHARS) {
      throw new ApplyError(`${source} is larger than a cookbook can be.`);
    }
    return text;
  }
  try {
    return readFileSync(resolve(source), 'utf-8');
  } catch {
    throw new ApplyError(`Could not read cookbook file ${resolve(source)}`);
  }
}

export const asList = (value: string[] | string | undefined): string[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

export interface ValidateSourceOptions {
  /** Project directory manifests are looked up from. */
  dir: string;
  manifests?: string[];
  registry?: boolean;
}

/** Validate cookbook text structurally and against the resolved recipe index. */
export async function validateCookbookSource(
  text: string,
  options: ValidateSourceOptions,
): Promise<CookbookReport> {
  const warnings: string[] = [];
  const index = await resolveRecipeIndex(parseForResolution(text), {
    dir: options.dir,
    manifests: options.manifests ?? [],
    registry: options.registry !== false,
    warn: (message) => warnings.push(message),
  });
  const report = validateCookbookText(text, index);
  report.warnings.push(...warnings);
  return report;
}

/** Print what an apply did (or, for a dry run, would do) and the next steps. */
export function printApplyResult(
  result: ApplyResult,
  warnings: string[],
  log: (line: string) => void = console.log,
  warn: (line: string) => void = console.warn,
): void {
  for (const warning of warnings) warn(`warning: ${warning}`);
  const { plan } = result;
  log(
    `${result.dryRun ? 'Plan (dry run)' : 'Applied'}: ${plan.mode === 'new' ? 'new project' : 'update'} in ${plan.targetDir}`,
  );
  if (plan.template) {
    log(
      `  template: ${plan.template.spec}${plan.template.revision ? ` @ ${plan.template.revision}` : ''}`,
    );
  }
  if (plan.projectName) log(`  project name: ${plan.projectName}`);
  for (const [name, range] of Object.entries(plan.addDependencies)) {
    log(`  + ${name}@${range}`);
  }
  for (const [name, range] of Object.entries(plan.keptDependencies)) {
    log(`  = ${name}@${range} (already declared)`);
  }
  log(`  smrt.cookbook.json: ${plan.config}`);
  log('\nNext steps:');
  for (const step of result.nextSteps) log(`  ${step}`);
}
