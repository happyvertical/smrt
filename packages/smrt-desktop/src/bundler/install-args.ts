import { NodeDistError } from './node-errors.js';
import { BundleTreeError } from './tree-errors.js';

/**
 * Exact `pnpm install` argv for a bundle plan, plus the pure checks around it.
 *
 * Every argv token comes from this file's closed tables; no user-controlled
 * string is ever placed in argv (paths go through `cwd`), so the list can be
 * run without a shell on every platform. Lifecycle scripts NEVER run, host or
 * cross: `--ignore-scripts` is unconditional and there is no option to turn it
 * off. Neither does any JavaScript the app configures for pnpm itself:
 * `--ignore-pnpmfile` is unconditional and the app's `configDependencies`,
 * `pnpmfile` and `globalPnpmfile` settings fail the bundle (`--ignore-scripts`
 * does not cover pnpmfile hooks). Natives in scope ship as prebuilt optional
 * packages; a package that needs a build step is reported by
 * `findBuildStepPackages` and fails the bundle.
 *
 * The functions here do no I/O. The post-install checks work on a directory
 * listing (`TreeEntry[]`) and package facts the orchestrator collects through
 * its own filesystem seam.
 */

/**
 * The pnpm-facing part of a target: structurally the `pnpm` member of a
 * `TargetSpec` row (`{ os, cpu, libc? }`).
 */
export interface InstallTarget {
  readonly pnpm: {
    readonly os: string;
    readonly cpu: string;
    readonly libc?: string;
  };
}

export interface InstallArgsInput {
  readonly target: InstallTarget;
  /** Add `--offline` (store must already hold every tarball). */
  readonly offline?: boolean;
}

const OS_VALUES = new Set(['darwin', 'linux', 'win32']);
const CPU_VALUES = new Set(['arm64', 'x64']);
/** musl has no official Node build (v1 non-goal), so only glibc is allowed. */
const LIBC_VALUES = new Set(['glibc']);

/** Flags that must be present, in this order, for every plan. */
export const FIXED_INSTALL_ARGS: readonly string[] = Object.freeze([
  'install',
  '--frozen-lockfile',
  '--prod',
  '--ignore-scripts',
  // pnpm hooks (`.pnpmfile.cjs`, `pnpmfile`, `globalPnpmfile`, config
  // dependencies) are JavaScript pnpm loads during install; `--ignore-scripts`
  // does not stop them.
  '--ignore-pnpmfile',
]);

/**
 * Trailing config flags: hoisted layout, no host-built natives, real copies,
 * and never switch to (download and run) the pnpm the app's `packageManager`
 * or `devEngines` names. `pm-on-fail` is the pnpm 11 setting; pnpm 10 has no
 * such setting, so the staged manifest also drops both fields.
 */
export const FIXED_INSTALL_CONFIG_ARGS: readonly string[] = Object.freeze([
  '--config.pm-on-fail=ignore',
  '--config.node-linker=hoisted',
  '--config.side-effects-cache=false',
  '--config.package-import-method=copy',
  '--config.verify-store-integrity=true',
]);

/**
 * pnpm argv (without the `pnpm` executable). Throws `invalid_install_plan` for
 * a target outside the closed sets.
 */
export function buildPnpmInstallArgs(input: InstallArgsInput): string[] {
  const { os: pnpmOs, cpu: pnpmCpu, libc: pnpmLibc } = input.target.pnpm;
  if (!OS_VALUES.has(pnpmOs) || !CPU_VALUES.has(pnpmCpu)) {
    throw new NodeDistError('invalid_install_plan');
  }
  if (pnpmLibc !== undefined) {
    // `--libc` only means something on Linux.
    if (pnpmOs !== 'linux' || !LIBC_VALUES.has(pnpmLibc)) {
      throw new NodeDistError('invalid_install_plan');
    }
  } else if (pnpmOs === 'linux') {
    // Without it pnpm installs BOTH gnu and musl natives (~100 MB extra).
    throw new NodeDistError('invalid_install_plan');
  }
  return [
    ...FIXED_INSTALL_ARGS,
    '--os',
    pnpmOs,
    '--cpu',
    pnpmCpu,
    ...(pnpmLibc !== undefined ? ['--libc', pnpmLibc] : []),
    ...FIXED_INSTALL_CONFIG_ARGS,
    ...(input.offline ? ['--offline'] : []),
  ];
}

/**
 * Last gate before spawning: the argv must be exactly the form this module
 * builds, and the environment must still say "no scripts". Guards against a
 * later refactor, or a caller composing its own argv, enabling scripts.
 */
export function assertInstallSafe(
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): void {
  const fixed = new Set([...FIXED_INSTALL_ARGS, ...FIXED_INSTALL_CONFIG_ARGS]);
  const seen = new Set<string>();
  const valued = new Map<string, Set<string>>([
    ['--os', OS_VALUES],
    ['--cpu', CPU_VALUES],
    ['--libc', LIBC_VALUES],
  ]);
  let ok = env.npm_config_ignore_scripts === 'true';
  for (let i = 0; ok && i < args.length; i += 1) {
    const arg = args[i] as string;
    const allowedValues = valued.get(arg);
    if (allowedValues) {
      const value = args[i + 1];
      ok = value !== undefined && allowedValues.has(value) && !seen.has(arg);
      i += 1;
    } else {
      ok = (fixed.has(arg) || arg === '--offline') && !seen.has(arg);
    }
    seen.add(arg);
  }
  ok = ok && args[0] === 'install';
  for (const flag of fixed) ok = ok && seen.has(flag);
  if (!ok) throw new NodeDistError('install_unsafe');
}

/* ---------------- dependency specifier policy ---------------- */

export type DependencySpecKind =
  | 'registry'
  | 'alias'
  | 'link'
  | 'file'
  | 'git'
  | 'tarball'
  | 'workspace'
  | 'unknown';

const SEMVERISH = /^[\s\dA-Za-z.*^~<>=|,\-+_x]*$/;
const GIT_SHORTHAND = /^[A-Za-z0-9][\w.-]*\/[\w.-]+(?:#.*)?$/;

/**
 * Classify one `package.json` dependency specifier. Only `registry` (a semver
 * range or dist-tag), `alias` (`npm:`) and `catalog` references (reported as
 * `registry`, resolved by the lockfile) are acceptable for a bundle.
 */
export function classifyDependencySpec(spec: string): DependencySpecKind {
  const value = spec.trim();
  if (value.startsWith('npm:')) return 'alias';
  if (value.startsWith('catalog:')) return 'registry';
  if (value.startsWith('link:') || value.startsWith('portal:')) return 'link';
  if (value.startsWith('file:')) return 'file';
  if (value.startsWith('workspace:')) return 'workspace';
  if (/^(?:git|git\+[a-z]+|github|gitlab|bitbucket|gist|ssh):/i.test(value)) {
    return 'git';
  }
  if (/^https?:/i.test(value)) return 'tarball';
  if (value.startsWith('.') || value.startsWith('/') || value.startsWith('~')) {
    return 'file';
  }
  if (GIT_SHORTHAND.test(value) && !SEMVERISH.test(value)) return 'git';
  if (value.length === 0 || SEMVERISH.test(value)) return 'registry';
  return 'unknown';
}

export interface DisallowedDependency {
  /** Dependency name as written in package.json (data, not a message). */
  readonly name: string;
  readonly kind: Exclude<DependencySpecKind, 'registry' | 'alias'>;
}

/**
 * Production dependencies (`dependencies` + `optionalDependencies`) whose
 * specifier is not a registry reference. Sorted by name; the caller turns a
 * non-empty result into one `invalid_input` failure.
 */
export function findDisallowedDependencies(manifest: {
  readonly dependencies?: Readonly<Record<string, unknown>>;
  readonly optionalDependencies?: Readonly<Record<string, unknown>>;
}): DisallowedDependency[] {
  const found = new Map<string, DisallowedDependency>();
  for (const group of [manifest.dependencies, manifest.optionalDependencies]) {
    if (!group || typeof group !== 'object') continue;
    for (const [name, spec] of Object.entries(group)) {
      const kind =
        typeof spec === 'string' ? classifyDependencySpec(spec) : 'unknown';
      if (kind !== 'registry' && kind !== 'alias' && !found.has(name)) {
        found.set(name, { name, kind });
      }
    }
  }
  return [...found.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Whether a `pnpm-lock.yaml` package resolution is acceptable: a registry
 * tarball with an integrity hash. Tarball URLs, git commits and directories
 * are not. `resolution` is the parsed `resolution:` mapping.
 */
export function isRegistryResolution(resolution: unknown): boolean {
  if (resolution === null || typeof resolution !== 'object') return false;
  const record = resolution as Record<string, unknown>;
  if ('tarball' in record || 'directory' in record || 'repo' in record) {
    return false;
  }
  if ('type' in record && record.type !== undefined) return false;
  return typeof record.integrity === 'string' && record.integrity.length > 0;
}

/**
 * The staging copy of `package.json` for the install. Removed:
 * - `scripts`, so nothing in the app's own manifest can run;
 * - `packageManager` and `devEngines`, which make pnpm 10 and 11 download and
 *   run a different pnpm than the one the bundler probed and recorded (neither
 *   field is part of the lockfile).
 * Returns a new object; `devDependencies` are left for pnpm's `--prod` to
 * ignore.
 */
export function stageManifest<T extends Record<string, unknown>>(
  manifest: T,
): Omit<T, 'scripts' | 'packageManager' | 'devEngines'> {
  const {
    scripts: _scripts,
    packageManager: _packageManager,
    devEngines: _devEngines,
    ...rest
  } = manifest;
  return rest;
}

/* ---------------- pnpm configuration that would load code ---------------- */

/**
 * Settings that make pnpm load JavaScript while installing. Matched after
 * lowercasing and removing `-` and `_`, so `global-pnpmfile` and
 * `globalPnpmfile` are the same setting.
 */
const CODE_LOADING_SETTINGS: ReadonlyArray<readonly [string, string]> = [
  ['configdependencies', 'configDependencies'],
  ['globalpnpmfile', 'globalPnpmfile'],
  ['pnpmfile', 'pnpmfile'],
];

const normalizeKey = (key: string): string =>
  key.toLowerCase().replace(/[-_]/g, '');

/**
 * Static names of the code-loading settings mentioned in `key`. `globalPnpmfile`
 * contains `pnpmfile`, so it is reported alone.
 */
function codeLoadingSettingsIn(key: string): string[] {
  const normalized = normalizeKey(key);
  const hits = CODE_LOADING_SETTINGS.filter(([needle]) =>
    normalized.includes(needle),
  ).map(([, name]) => name);
  return hits.includes('globalPnpmfile')
    ? hits.filter((name) => name !== 'pnpmfile')
    : hits;
}

/**
 * Code-loading settings in the app's `pnpm-workspace.yaml`, as static setting
 * names (never file text). It is a conservative text scan, not a YAML parser,
 * and fails closed: a setting is found wherever its name appears outside a
 * full-line comment (block key, flow mapping, quoted key, anchor), and a
 * backslash escape, which could spell a key without writing it, is reported as
 * `escaped YAML key`.
 */
export function findWorkspaceCodeLoading(yaml: string): string[] {
  const found = new Set<string>();
  const body = yaml
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith('#'))
    .join('\n');
  for (const name of codeLoadingSettingsIn(body)) found.add(name);
  if (body.includes('\\')) found.add('escaped YAML key');
  return [...found].sort();
}

/**
 * Code-loading settings anywhere under the manifest's `pnpm` field (any depth)
 * or at its top level.
 */
export function findManifestCodeLoading(
  manifest: Readonly<Record<string, unknown>>,
): string[] {
  const found = new Set<string>();
  const visit = (value: unknown, depth: number): void => {
    if (depth > 32 || value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      for (const name of codeLoadingSettingsIn(key)) found.add(name);
      visit(child, depth + 1);
    }
  };
  visit(manifest.pnpm, 0);
  for (const key of Object.keys(manifest)) {
    for (const name of codeLoadingSettingsIn(key)) found.add(name);
  }
  return [...found].sort();
}

/** Boolean resolution settings the lockfile records, so a frozen install needs them. */
const NPMRC_BOOLEAN_KEYS = new Set([
  'auto-install-peers',
  'dedupe-peer-dependents',
  'exclude-links-from-lockfile',
  'strict-peer-dependencies',
]);
const NPMRC_SCOPED_REGISTRY = /^@[a-z0-9][a-z0-9._~-]*:registry$/;
const NPMRC_URL = /^https?:\/\/[^\s@]+$/;

export interface StagedNpmrc {
  /** The `.npmrc` text to place in the install directory (maybe empty). */
  readonly text: string;
  /** Lines that were not carried over (comments and blanks excluded). */
  readonly dropped: number;
}

/**
 * The part of the app's `.npmrc` that reaches pnpm: `registry`,
 * `@scope:registry` (an `http(s)` URL without credentials) and four boolean
 * resolution settings. Everything else is dropped, including every `_auth*`
 * line (credentials come from the build user's own `~/.npmrc`) and anything
 * that expands an environment variable. A `pnpmfile`, `global-pnpmfile` or
 * `config-dependencies` key fails the bundle (`unsafe_install_config`).
 */
export function stageNpmrc(text: string): StagedNpmrc {
  const kept: string[] = [];
  const unsafe = new Set<string>();
  let dropped = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#') || line.startsWith(';')) {
      continue;
    }
    const eq = line.indexOf('=');
    const key = (eq === -1 ? line : line.slice(0, eq)).trim();
    const value = eq === -1 ? '' : line.slice(eq + 1).trim();
    for (const name of codeLoadingSettingsIn(key)) unsafe.add(name);
    const registry =
      (key === 'registry' || NPMRC_SCOPED_REGISTRY.test(key)) &&
      NPMRC_URL.test(value);
    const boolean =
      NPMRC_BOOLEAN_KEYS.has(key) && /^(?:true|false)$/.test(value);
    if (registry || boolean) kept.push(`${key}=${value}`);
    else dropped += 1;
  }
  if (unsafe.size > 0) {
    throw new BundleTreeError('unsafe_install_config', {
      field: '.npmrc',
      subjects: [...unsafe].sort(),
    });
  }
  return {
    text: kept.length === 0 ? '' : `${kept.join('\n')}\n`,
    dropped,
  };
}

/* ---------------- post-install checks (directory listing seam) ---------------- */

export interface TreeEntry {
  /** POSIX-style path relative to the tree root, no leading `./`. */
  readonly path: string;
  readonly kind: 'file' | 'directory' | 'symlink' | 'other';
}

/** Names removed from the install tree by the normalisation step. */
const ROOT_REMOVALS = [
  /^\.modules\.yaml$/,
  /^\.pnpm-workspace-state[^/]*\.json$/,
  /^\.package-lock\.json$/,
  /^\.pnpm$/,
];

/**
 * Paths the normalisation step deletes from a hoisted `node_modules` listing
 * (paths relative to `node_modules`): every `.bin` directory, and pnpm's state
 * files at the root. Only the top-most path of a removed subtree is returned.
 */
export function findNormalizationTargets(
  entries: readonly TreeEntry[],
): string[] {
  const targets: string[] = [];
  for (const entry of entries) {
    const segments = entry.path.split('/');
    const last = segments[segments.length - 1] as string;
    const isBin = last === '.bin';
    const isRootState =
      segments.length === 1 && ROOT_REMOVALS.some((rule) => rule.test(last));
    if (isBin || isRootState) targets.push(entry.path);
  }
  targets.sort();
  return targets.filter(
    (path, index) =>
      !targets.slice(0, index).some((parent) => path.startsWith(`${parent}/`)),
  );
}

/**
 * Entries that must not survive normalisation: any symlink, junction (reported
 * as `symlink` or `other`), device, FIFO or socket. Paths are returned sorted;
 * `normalized` lists are the entries still present after removals were applied.
 */
export function findLeftoverLinks(entries: readonly TreeEntry[]): string[] {
  return entries
    .filter((entry) => entry.kind === 'symlink' || entry.kind === 'other')
    .map((entry) => entry.path)
    .sort();
}

/** Packages whose install script is harmless or irrelevant to a bundle. */
export const HARMLESS_INSTALL_SCRIPT_PACKAGES: readonly string[] =
  Object.freeze(['esbuild', 'fsevents', 'protobufjs']);

export interface InstalledPackageFacts {
  readonly name: string;
  readonly scripts?: Readonly<Record<string, unknown>>;
  /** `package.json` `gypfile: true`. */
  readonly gypfile?: boolean;
  /** A `binding.gyp` file sits in the package root. */
  readonly hasBindingGyp?: boolean;
  /** The package ships a `.node` file (prebuilt addon). */
  readonly hasPrebuiltNode?: boolean;
}

const INSTALL_HOOKS = ['preinstall', 'install', 'postinstall'] as const;

/**
 * Names of installed packages that would have needed an install step to work:
 * they declare `preinstall`/`install`/`postinstall` or build via node-gyp, are
 * not in the harmless list, and ship no prebuilt `.node`. Scripts were not run
 * (`--ignore-scripts`), so these cannot be bundled.
 */
export function findBuildStepPackages(
  packages: readonly InstalledPackageFacts[],
  harmless: readonly string[] = HARMLESS_INSTALL_SCRIPT_PACKAGES,
): string[] {
  const allowed = new Set(harmless);
  const names = new Set<string>();
  for (const pkg of packages) {
    if (allowed.has(pkg.name) || pkg.hasPrebuiltNode) continue;
    const hasHook =
      pkg.scripts !== undefined &&
      INSTALL_HOOKS.some((hook) => typeof pkg.scripts?.[hook] === 'string');
    if (hasHook || pkg.gypfile === true || pkg.hasBindingGyp === true) {
      names.add(pkg.name);
    }
  }
  return [...names].sort();
}
