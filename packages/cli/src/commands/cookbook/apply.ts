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
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
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

/** Sections a new project's smrt packages are pinned in (peer ranges stay ranges). */
const PINNED_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const;

const SMRT_PACKAGE_PREFIX = '@happyvertical/smrt-';

/** Lockfiles a template may ship; they resolve the template's own pins. */
const LOCKFILES = [
  'pnpm-lock.yaml',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'bun.lock',
  'bun.lockb',
] as const;

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
  /**
   * Where the package manager's output goes. `inherit` (default) uses this
   * process's stdout; `stderr` keeps stdout free for a protocol (the MCP
   * stdio server). Stdin is never shared with the install in `stderr` mode.
   */
  installOutput?: 'inherit' | 'stderr';
  /**
   * Version of this CLI. smrt releases in lockstep, so a new project's
   * `@happyvertical/smrt-*` packages are pinned to exactly this version when
   * it is a plain release; it is also the last-resort range for `--into`.
   */
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
  /** Needed packages already declared (left as they are, apart from the pin below). */
  keptDependencies: Record<string, string>;
  /**
   * The exact version a new project's `@happyvertical/smrt-*` packages are
   * pinned to (this CLI's), or undefined when they keep their ranges.
   */
  smrtVersion?: string;
  /** Template smrt dependencies whose range the pin replaced. */
  repinnedDependencies: Record<string, { from: string; to: string }>;
  /** Template lockfiles dropped because they resolve the replaced pins. */
  removedLockfiles: string[];
  config: 'create' | 'update' | 'unchanged';
}

export interface ApplyResult {
  plan: ApplyPlan;
  dryRun: boolean;
  written: string[];
  installed: boolean;
  nextSteps: string[];
  /** Things the user should know about the result (e.g. an unpinned dev build). */
  warnings: string[];
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
 * `version` when it is a plain release (`x.y.z`) that the registry serves;
 * undefined for a prerelease, build metadata, or the `0.0.0` an unresolved
 * dev build reports.
 */
export function releasedVersion(version: string): string | undefined {
  return /^\d+\.\d+\.\d+$/.test(version) && version !== '0.0.0'
    ? version
    : undefined;
}

/**
 * Range for packages an existing project (`--into`) does not declare yet:
 * the framework line the project already uses (smrt packages release as one
 * fixed group), else this CLI's own version (exact when it is a release).
 */
export function chooseRange(json: PackageJson, cliVersion: string): string {
  const core = declaredRange(json, '@happyvertical/smrt-core');
  if (core?.startsWith('workspace:')) return 'workspace:*';
  if (core && /^[\^~]?\d/.test(core)) return core;
  return releasedVersion(cliVersion) ?? `^${cliVersion}`;
}

/**
 * A copy of `json` with every `@happyvertical/smrt-*` registry range in
 * dependencies, devDependencies and optionalDependencies set to exactly
 * `version`, plus what changed. A protocol or path spec (`workspace:`,
 * `link:`, `file:`, `npm:` alias, git, URL) is a deliberate local choice
 * and is kept, as is every non-smrt dependency.
 */
export function pinSmrtDependencies(
  json: PackageJson,
  version: string,
): {
  json: PackageJson;
  changes: Record<string, { from: string; to: string }>;
} {
  const next: PackageJson = { ...json };
  const changes: Record<string, { from: string; to: string }> = {};
  for (const section of PINNED_SECTIONS) {
    const deps = json[section] as Record<string, unknown> | undefined;
    if (!deps || typeof deps !== 'object') continue;
    const pinned: Record<string, unknown> = { ...deps };
    for (const [name, spec] of Object.entries(deps)) {
      if (!name.startsWith(SMRT_PACKAGE_PREFIX)) continue;
      if (typeof spec !== 'string' || /[:/]/.test(spec)) continue;
      if (spec === version) continue;
      pinned[name] = version;
      changes[name] = { from: spec, to: version };
    }
    next[section] = pinned;
  }
  return { json: next, changes };
}

const slug = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

/** A valid unscoped npm package name from free text, or undefined when nothing usable remains. */
export function npmNameFromText(value: string): string | undefined {
  const name = slug(value).slice(0, 214).replace(/-+$/, '');
  return name || undefined;
}

/** The scope a new project's name takes when its template's name has none. */
export const DEFAULT_PROJECT_SCOPE = '@smrt-app';

/**
 * A new project's package name: the slug under the template's npm scope (else
 * `@smrt-app`). SMRT qualifies class names as `@scope/package:ClassName` and
 * refuses to scan a project with an unscoped name, so an unscoped name would
 * leave any template that declares its own models unbuildable (#4061). A
 * slug that would reproduce the template's name gets a `-project` suffix.
 */
export function scopedProjectName(
  slugName: string,
  templateName: string | undefined,
): string {
  const scope = /^@[a-z0-9][a-z0-9._~-]*\//.exec(templateName ?? '')?.[0];
  const prefix = scope ? scope.slice(0, -1) : DEFAULT_PROJECT_SCOPE;
  // Never the template's own name (its app identity), even when the slug
  // matches it.
  const suffix = `${prefix}/${slugName}` === templateName ? '-project' : '';
  const room = 214 - prefix.length - 1 - suffix.length;
  return `${prefix}/${slugName.slice(0, room).replace(/-+$/, '')}${suffix}`;
}

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
  /**
   * Paths (relative to `root`) to copy, when the template is a local git
   * checkout: tracked plus untracked-but-not-ignored files. Undefined means
   * copy everything except `.git` and `node_modules`.
   */
  files?: string[];
  cleanup(): void;
}

function git(args: string[], cwd: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // Never prompt for credentials or hang on a slow remote.
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'false' },
    timeout: 120_000,
  }).trim();
}

/**
 * Files a local git checkout contributes to a new project: everything tracked
 * plus untracked files that are not git-ignored (`git ls-files -co
 * --exclude-standard`). A working checkout carries git-ignored generated
 * output (build products, a stale `src/routes/api/notes`) that must not leak
 * into a new project, while uncommitted edits to the template still apply, so
 * `git archive HEAD` (which would drop them) is not used. Returns undefined
 * when `dir` is not inside a git work tree or git is unavailable.
 */
export function listLocalTemplateFiles(dir: string): string[] | undefined {
  try {
    if (git(['rev-parse', '--is-inside-work-tree'], dir) !== 'true') {
      return undefined;
    }
    const out = execFileSync(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
      { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return [...new Set(out.split('\0').filter(Boolean))].filter((file) =>
      existsSync(join(dir, file)),
    );
  } catch {
    return undefined;
  }
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
    return {
      root: parsed.path,
      files: listLocalTemplateFiles(parsed.path),
      cleanup() {},
    };
  }
  const root = mkdtempSync(join(tmpdir(), 'smrt-template-'));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  try {
    git(['init', '-q'], root);
    // A ref that starts with `-` would be read by git as an option.
    if (parsed.ref?.startsWith('-') || parsed.url.startsWith('-')) {
      throw new ApplyError(`Invalid template source ${spec}`);
    }
    git(
      ['fetch', '-q', '--depth', '1', '--', parsed.url, parsed.ref ?? 'HEAD'],
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

function packageManagerFrom(has: (file: string) => boolean): string {
  if (has('yarn.lock')) return 'yarn';
  if (has('package-lock.json')) return 'npm';
  return 'pnpm';
}

function packageManager(dir: string): string {
  return packageManagerFrom((file) => existsSync(join(dir, file)));
}

export function nextSteps(
  dir: string,
  json: PackageJson,
  installed: boolean,
  cwd: string,
  pm: string = packageManager(dir),
): string[] {
  const run = pm === 'npm' ? 'npm run' : pm;
  const scripts = (json.scripts as Record<string, string> | undefined) ?? {};
  const steps: string[] = [];
  if (resolve(dir) !== resolve(cwd)) {
    // A directory outside the working tree reads better as an absolute path.
    const rel = relative(cwd, dir);
    steps.push(`cd ${rel.startsWith('..') ? resolve(dir) : rel || '.'}`);
  }
  if (!installed) steps.push(`${pm} install`);
  steps.push(
    scripts['app:setup'] ? `${run} app:setup` : 'npx smrt app setup',
    scripts['app:doctor'] ? `${run} app:doctor` : 'npx smrt doctor',
  );
  return steps;
}

function copyTemplate(template: AcquiredTemplate, targetDir: string): void {
  const skip = (name: string) => name === '.git' || name === 'node_modules';
  // A symlink copied into the project would let a later write (package.json,
  // smrt.cookbook.json) land on whatever it points at, outside the project.
  const refuseLink = (src: string): boolean => {
    if (lstatSync(src).isSymbolicLink()) {
      throw new ApplyError(
        `Template entry ${relative(template.root, src)} is a symbolic link; templates must not contain links`,
      );
    }
    return true;
  };
  if (!template.files) {
    cpSync(template.root, targetDir, {
      recursive: true,
      filter: (src) => !skip(basename(src)) && refuseLink(src),
    });
    return;
  }
  for (const file of template.files) {
    if (file.split('/').some(skip)) continue;
    const from = join(template.root, file);
    refuseLink(from);
    const to = join(targetDir, file);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, {
      recursive: true,
      filter: (src) => refuseLink(src),
    });
  }
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

    // A new project runs the smrt release this CLI is, not whatever the
    // template pinned when it was last touched (#4055): smrt releases in
    // lockstep, so this CLI's version is right for every smrt package.
    const warnings: string[] = [];
    const smrtVersion =
      mode === 'new' ? releasedVersion(options.cliVersion) : undefined;
    if (mode === 'new' && !smrtVersion) {
      warnings.push(
        `this CLI's version (${options.cliVersion}) is not a published release, so the project keeps the template's @happyvertical/smrt-* ranges; pin them to a released smrt version before relying on the app`,
      );
    }
    let repinnedDependencies: Record<string, { from: string; to: string }> = {};
    if (smrtVersion) {
      ({ json: baseJson, changes: repinnedDependencies } = pinSmrtDependencies(
        baseJson,
        smrtVersion,
      ));
    }
    // The template's lockfile resolves the ranges just replaced; keeping it
    // would let the install (or a later frozen one) restore them.
    // What the new project receives from the template: a local git
    // template contributes only `files` (an ignored lockfile stays behind).
    const copied = (file: string): boolean => {
      const { root, files } = template as AcquiredTemplate;
      return files ? files.includes(file) : existsSync(join(root, file));
    };
    const removedLockfiles =
      mode === 'new' && Object.keys(repinnedDependencies).length > 0
        ? LOCKFILES.filter(copied)
        : [];
    // Decided from the copied files before a lockfile is dropped, since
    // lockfiles name it.
    const pm =
      mode === 'new' ? packageManagerFrom(copied) : packageManager(targetDir);

    const range = smrtVersion ?? chooseRange(baseJson, options.cliVersion);
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

    // A new project never keeps the template's package name: the runtime
    // derives the application identity (and so the OS data directory) from
    // it, so two projects from one template would share a database. Name it
    // from the cookbook, else from the target directory, under the template's
    // scope: SMRT requires a scoped package name to qualify class names.
    const projectName =
      mode === 'new'
        ? scopedProjectName(
            npmNameFromText(options.cookbook.name ?? '') ??
              npmNameFromText(basename(targetDir)) ??
              'smrt-app',
            typeof baseJson.name === 'string' ? baseJson.name : undefined,
          )
        : undefined;

    const plan: ApplyPlan = {
      mode,
      targetDir,
      template:
        mode === 'new' ? { spec, revision: template?.revision } : undefined,
      projectName,
      addDependencies,
      keptDependencies,
      smrtVersion,
      repinnedDependencies,
      removedLockfiles,
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
        nextSteps: nextSteps(targetDir, nextJson, false, cwd, pm),
        warnings,
      };
    }

    const written: string[] = [];
    if (mode === 'new') {
      mkdirSync(targetDir, { recursive: true });
      copyTemplate(template as AcquiredTemplate, targetDir);
      written.push(`${targetDir} (from template)`);
      for (const file of removedLockfiles) {
        rmSync(join(targetDir, file), { force: true });
      }
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
      const result = spawnSync(pm, ['install'], {
        cwd: targetDir,
        stdio:
          options.installOutput === 'stderr' ? ['ignore', 2, 2] : 'inherit',
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
      nextSteps: nextSteps(targetDir, nextJson, installed, cwd, pm),
      warnings,
    };
  } finally {
    template?.cleanup();
  }
}
