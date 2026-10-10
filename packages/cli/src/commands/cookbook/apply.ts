/**
 * `smrt cookbook apply` engine (#3748): create or update a project from a
 * validated cookbook. Writes configuration only (package.json dependencies,
 * `smrt.cookbook.json`, and the project name for a new project); never sample
 * data and never anything else in the project.
 */

import { execFileSync, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve } from 'node:path';
import type { Cookbook } from '@happyvertical/smrt-types';

export const COOKBOOK_CONFIG_FILE = 'smrt.cookbook.json';
export const DEFAULT_TEMPLATE = 'github:happyvertical/smrt-start';

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;

type DepSection = (typeof DEP_SECTIONS)[number];

interface PackageJson {
  name?: string;
  [key: string]: unknown;
}

export interface ApplyOptions {
  cookbook: Cookbook;
  /** Packages the cookbook's recipes, features and policies need. */
  packages: string[];
  /** Target directory (new project) or project directory (`into`). */
  dir?: string;
  into?: boolean;
  /** Local path, `github:owner/repo[#ref]`, or a git URL. */
  template?: string;
  dryRun?: boolean;
  install?: boolean;
  /** Version of the CLI, the last-resort dependency range. */
  cliVersion: string;
  cwd?: string;
}

export interface ApplyPlan {
  mode: 'new' | 'update';
  targetDir: string;
  template?: { spec: string; revision?: string };
  projectName?: string;
  /** Dependencies added to package.json. */
  addDependencies: Record<string, string>;
  /** Needed packages already declared (left exactly as they are). */
  keptDependencies: Record<string, string>;
  config: 'create' | 'update' | 'unchanged';
}

export interface ApplyResult {
  plan: ApplyPlan;
  dryRun: boolean;
  written: string[];
  installed: boolean;
  nextSteps: string[];
}

export class ApplyError extends Error {}

function detectIndent(text: string): string | number {
  return /^( +|\t)"/m.exec(text)?.[1] ?? 2;
}

function readPackageJson(dir: string): { json: PackageJson; raw: string } {
  const file = join(dir, 'package.json');
  if (!existsSync(file)) {
    throw new ApplyError(`No package.json in ${dir}`);
  }
  const raw = readFileSync(file, 'utf-8');
  try {
    return { json: JSON.parse(raw) as PackageJson, raw };
  } catch {
    throw new ApplyError(`${file} is not valid JSON`);
  }
}

function declaredRange(json: PackageJson, name: string): string | undefined {
  for (const section of DEP_SECTIONS) {
    const value = (json[section] as Record<string, string> | undefined)?.[name];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

/**
 * Range for packages the project does not declare yet: the framework line the
 * project already uses (smrt packages release as one fixed group), else this
 * CLI's own release line.
 */
export function chooseRange(json: PackageJson, cliVersion: string): string {
  const core = declaredRange(json, '@happyvertical/smrt-core');
  if (core?.startsWith('workspace:')) return 'workspace:*';
  if (core && /^[\^~]?\d/.test(core)) return core;
  return `^${cliVersion}`;
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** Parse `github:owner/repo#ref`, a git URL, or a local path. */
export function parseTemplateSpec(
  spec: string,
):
  | { kind: 'local'; path: string }
  | { kind: 'git'; url: string; ref?: string } {
  const [head, ref] = (() => {
    const hash = spec.indexOf('#');
    return hash === -1
      ? [spec, undefined]
      : [spec.slice(0, hash), spec.slice(hash + 1)];
  })();
  const github = /^github:([\w.-]+\/[\w.-]+)$/.exec(head);
  if (github) {
    return { kind: 'git', url: `https://github.com/${github[1]}.git`, ref };
  }
  if (/^(https?|ssh|git):\/\//.test(head) || /^git@/.test(head)) {
    return { kind: 'git', url: head, ref };
  }
  return { kind: 'local', path: resolve(spec) };
}

interface AcquiredTemplate {
  root: string;
  revision?: string;
  cleanup(): void;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/** Resolve a template to a directory: a local path as-is, a git source shallow-fetched. */
export function acquireTemplate(spec: string): AcquiredTemplate {
  const parsed = parseTemplateSpec(spec);
  if (parsed.kind === 'local') {
    if (!existsSync(join(parsed.path, 'package.json'))) {
      throw new ApplyError(
        `Template ${parsed.path} has no package.json (pass --template <path|github:owner/repo#ref>)`,
      );
    }
    return { root: parsed.path, cleanup() {} };
  }
  const root = mkdtempSync(join(tmpdir(), 'smrt-template-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    git(['init', '-q'], root);
    git(
      ['fetch', '-q', '--depth', '1', parsed.url, parsed.ref ?? 'HEAD'],
      root,
    );
    git(['checkout', '-q', 'FETCH_HEAD'], root);
    const revision = git(['rev-parse', 'HEAD'], root);
    rmSync(join(root, '.git'), { recursive: true, force: true });
    return { root, revision, cleanup };
  } catch (error) {
    cleanup();
    const detail =
      error instanceof Error
        ? ((error as { stderr?: string }).stderr || error.message).trim()
        : String(error);
    throw new ApplyError(`Could not fetch template ${spec}: ${detail}`);
  }
}

function isEmptyDir(dir: string): boolean {
  return readdirSync(dir).length === 0;
}

function renderJson(value: unknown, indent: string | number = 2): string {
  return `${JSON.stringify(value, null, indent)}\n`;
}

function packageManager(dir: string): string {
  if (existsSync(join(dir, 'yarn.lock'))) return 'yarn';
  if (existsSync(join(dir, 'package-lock.json'))) return 'npm';
  return 'pnpm';
}

export function nextSteps(
  dir: string,
  json: PackageJson,
  installed: boolean,
  cwd: string,
): string[] {
  const pm = packageManager(dir);
  const run = pm === 'npm' ? 'npm run' : pm;
  const scripts = (json.scripts as Record<string, string> | undefined) ?? {};
  const steps: string[] = [];
  if (resolve(dir) !== resolve(cwd))
    steps.push(`cd ${relative(cwd, dir) || '.'}`);
  if (!installed) steps.push(`${pm} install`);
  steps.push(
    scripts['app:setup'] ? `${run} app:setup` : 'npx smrt app setup',
    scripts['app:doctor'] ? `${run} app:doctor` : 'npx smrt doctor',
  );
  return steps;
}

/** Plan and (unless dry-run) perform the apply. */
export function applyCookbook(options: ApplyOptions): ApplyResult {
  const cwd = options.cwd ?? process.cwd();
  const spec = options.template ?? DEFAULT_TEMPLATE;
  const configText = renderJson(options.cookbook);

  // Decide new vs update.
  let mode: 'new' | 'update';
  let targetDir: string;
  if (options.into) {
    mode = 'update';
    targetDir = resolve(cwd, options.dir ?? '.');
  } else {
    const relative =
      options.dir ?? (options.cookbook.name ? slug(options.cookbook.name) : '');
    if (!relative) {
      throw new ApplyError(
        'Give a directory for the new project (smrt cookbook apply <file> <dir>), or use --into for the current project',
      );
    }
    targetDir = resolve(cwd, relative);
    if (existsSync(targetDir) && !isEmptyDir(targetDir)) {
      if (
        existsSync(join(targetDir, COOKBOOK_CONFIG_FILE)) &&
        existsSync(join(targetDir, 'package.json'))
      ) {
        mode = 'update';
      } else {
        throw new ApplyError(
          `${targetDir} is not empty and holds no ${COOKBOOK_CONFIG_FILE}; pick another directory, or pass --into to apply to an existing project`,
        );
      }
    } else {
      mode = 'new';
    }
  }

  let template: AcquiredTemplate | undefined;
  try {
    let baseJson: PackageJson;
    let baseRaw: string;
    if (mode === 'new') {
      template = acquireTemplate(spec);
      ({ json: baseJson, raw: baseRaw } = readPackageJson(template.root));
    } else {
      ({ json: baseJson, raw: baseRaw } = readPackageJson(targetDir));
    }

    const range = chooseRange(baseJson, options.cliVersion);
    const addDependencies: Record<string, string> = {};
    const keptDependencies: Record<string, string> = {};
    for (const name of options.packages) {
      const existing = declaredRange(baseJson, name);
      if (existing !== undefined) keptDependencies[name] = existing;
      else addDependencies[name] = range;
    }

    const configFile = join(targetDir, COOKBOOK_CONFIG_FILE);
    const config: ApplyPlan['config'] =
      mode === 'update' && existsSync(configFile)
        ? readFileSync(configFile, 'utf-8') === configText
          ? 'unchanged'
          : 'update'
        : 'create';

    const projectName =
      mode === 'new' && options.cookbook.name
        ? slug(options.cookbook.name) || undefined
        : undefined;

    const plan: ApplyPlan = {
      mode,
      targetDir,
      template:
        mode === 'new' ? { spec, revision: template?.revision } : undefined,
      projectName,
      addDependencies,
      keptDependencies,
      config,
    };

    // The package.json that results, for next steps and the write.
    const nextJson: PackageJson = { ...baseJson };
    if (projectName) nextJson.name = projectName;
    if (Object.keys(addDependencies).length > 0) {
      const section: DepSection = 'dependencies';
      const merged = {
        ...((nextJson[section] as Record<string, string> | undefined) ?? {}),
        ...addDependencies,
      };
      nextJson[section] = Object.fromEntries(
        Object.entries(merged).sort(([a], [b]) => a.localeCompare(b)),
      );
    }

    const wantInstall = options.install !== false;
    if (options.dryRun) {
      return {
        plan,
        dryRun: true,
        written: [],
        installed: false,
        nextSteps: nextSteps(targetDir, nextJson, false, cwd),
      };
    }

    const written: string[] = [];
    if (mode === 'new') {
      mkdirSync(targetDir, { recursive: true });
      cpSync(template?.root as string, targetDir, {
        recursive: true,
        filter: (src) => {
          const name = basename(src);
          return name !== '.git' && name !== 'node_modules';
        },
      });
      written.push(`${targetDir} (from template)`);
    }
    const packageJsonChanged =
      mode === 'new' ||
      Object.keys(addDependencies).length > 0 ||
      Boolean(projectName);
    if (packageJsonChanged) {
      const file = join(targetDir, 'package.json');
      const next = renderJson(nextJson, detectIndent(baseRaw));
      if (mode === 'new' || next !== baseRaw) {
        writeFileSync(file, next);
        written.push(file);
      }
    }
    if (config !== 'unchanged') {
      writeFileSync(configFile, configText);
      written.push(configFile);
    }

    let installed = false;
    if (wantInstall) {
      const pm = packageManager(targetDir);
      const result = spawnSync(pm, ['install'], {
        cwd: targetDir,
        stdio: 'inherit',
      });
      if (result.status !== 0) {
        throw new ApplyError(
          `${pm} install failed in ${targetDir}; the cookbook is applied, fix the install error and re-run it`,
        );
      }
      installed = true;
    }
    return {
      plan,
      dryRun: false,
      written,
      installed,
      nextSteps: nextSteps(targetDir, nextJson, installed, cwd),
    };
  } finally {
    template?.cleanup();
  }
}
