/**
 * Provider-owned readiness probes for deployed profiles.
 *
 * Ported from the template's `scripts/smrt-provider-readiness.mjs`. The
 * module named by the environment setting is resolved from the application
 * (not from this CLI package), because it is the application's installed
 * provider adapter.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Provider components with a readiness module setting. */
export type ReadinessComponent = 'authentication' | 'assets' | 'secrets';

/** Environment variable naming each component's readiness module. */
export const PROVIDER_READINESS_SETTINGS: Readonly<
  Record<ReadinessComponent, string>
> = Object.freeze({
  authentication: 'SMRT_AUTH_READINESS_MODULE',
  assets: 'SMRT_ASSETS_READINESS_MODULE',
  secrets: 'SMRT_SECRETS_READINESS_MODULE',
});

/** Context handed to the provider's probe. */
export interface ReadinessContext {
  profile: string;
  provider: string;
}

/** Options for {@link createProviderReadinessProbe}. */
export interface ProviderReadinessOptions {
  /** Application root the module is resolved from. Defaults to `process.cwd()`. */
  sourceRoot?: string;
  /** Environment to read the setting from. Defaults to `process.env`. */
  environment?: Record<string, string | undefined>;
}

/**
 * Locate an installed package the way an ES module in `sourceRoot` would:
 * the nearest `node_modules/<name>` walking up from the application. Unlike
 * CommonJS resolution this never consults `NODE_PATH`, which package-manager
 * bin shims point at the CLI's own dependency store.
 */
export function findInstalledPackage(
  sourceRoot: string,
  packageName: string,
): string | null {
  let directory = resolve(sourceRoot);
  for (;;) {
    const candidate = join(directory, 'node_modules', packageName);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
}

function packageNameOf(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/**
 * Resolve a readiness module specifier the way the application would.
 *
 * URLs (`data:`, `file:`) are imported as given; absolute paths become file
 * URLs; relative paths resolve against the application root; bare package
 * specifiers resolve through the application's own `node_modules` with ESM
 * import conditions (as the template's in-app `import()` did).
 */
export function resolveReadinessModule(
  specifier: string,
  sourceRoot: string,
): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !isAbsolute(specifier)) {
    return specifier;
  }
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(resolve(sourceRoot, specifier)).href;
  }
  const packageName = packageNameOf(specifier);
  const installed = findInstalledPackage(sourceRoot, packageName);
  if (!installed) {
    throw new Error(`${specifier} is not installed in the application.`);
  }
  return pathToFileURL(
    resolvePackageEntry(
      realpathSync(installed),
      `.${specifier.slice(packageName.length)}`,
    ),
  ).href;
}

/** Conditions Node's ESM loader matches for `import()` (in priority order of the map). */
const IMPORT_CONDITIONS = new Set(['node', 'import', 'module-sync', 'default']);

function notExported(packageRoot: string, subpath: string): Error {
  return Object.assign(
    new Error(
      `Package subpath '${subpath}' is not exported for import by ${join(packageRoot, 'package.json')}.`,
    ),
    { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' },
  );
}

function resolveExportTarget(
  packageRoot: string,
  target: unknown,
  patternMatch: string | null,
): string | null {
  if (typeof target === 'string') {
    if (!target.startsWith('./')) return null;
    const substituted =
      patternMatch === null ? target : target.replaceAll('*', patternMatch);
    const resolved = resolve(packageRoot, substituted);
    // A target (or pattern substitution) may never leave the package.
    if (
      resolved !== packageRoot &&
      !resolved.startsWith(`${packageRoot}/`) &&
      !resolved.startsWith(`${packageRoot}\\`)
    ) {
      return null;
    }
    return resolved;
  }
  if (Array.isArray(target)) {
    for (const candidate of target) {
      const resolved = resolveExportTarget(
        packageRoot,
        candidate,
        patternMatch,
      );
      if (resolved) return resolved;
    }
    return null;
  }
  if (target && typeof target === 'object') {
    for (const [condition, value] of Object.entries(target)) {
      if (!IMPORT_CONDITIONS.has(condition)) continue;
      const resolved = resolveExportTarget(packageRoot, value, patternMatch);
      if (resolved) return resolved;
    }
  }
  return null;
}

/**
 * Resolve `subpath` (`.` or `./x`) of an installed package the way Node's ESM
 * loader does for `import()`: `exports` with the `node`/`import`/`default`
 * conditions (including `*` subpath patterns), else `main`/`index.js`.
 * `require` resolution is wrong here: it rejects import-only packages.
 */
export function resolvePackageEntry(
  packageRoot: string,
  subpath: string,
): string {
  const metadata = JSON.parse(
    readFileSync(join(packageRoot, 'package.json'), 'utf8'),
  ) as { exports?: unknown; main?: unknown };
  const { exports } = metadata;
  if (exports === undefined || exports === null) {
    if (subpath === '.') {
      return resolve(
        packageRoot,
        typeof metadata.main === 'string' ? metadata.main : 'index.js',
      );
    }
    return resolve(packageRoot, subpath);
  }
  const map =
    typeof exports === 'string' ||
    Array.isArray(exports) ||
    (typeof exports === 'object' &&
      !Object.keys(exports as object).some((key) => key.startsWith('.')))
      ? { '.': exports }
      : (exports as Record<string, unknown>);
  if (Object.hasOwn(map, subpath)) {
    const resolved = resolveExportTarget(packageRoot, map[subpath], null);
    if (resolved) return resolved;
    throw notExported(packageRoot, subpath);
  }
  let best: { key: string; match: string } | null = null;
  for (const key of Object.keys(map)) {
    const star = key.indexOf('*');
    if (star === -1 || key.indexOf('*', star + 1) !== -1) continue;
    const prefix = key.slice(0, star);
    const suffix = key.slice(star + 1);
    if (
      subpath.length >= key.length &&
      subpath.startsWith(prefix) &&
      subpath.endsWith(suffix) &&
      (!best || prefix.length > best.key.indexOf('*'))
    ) {
      best = {
        key,
        match: subpath.slice(prefix.length, subpath.length - suffix.length),
      };
    }
  }
  if (best) {
    const resolved = resolveExportTarget(
      packageRoot,
      map[best.key],
      best.match,
    );
    if (resolved) return resolved;
  }
  throw notExported(packageRoot, subpath);
}

/**
 * Build a provider-owned readiness probe. The installed adapter module must
 * export `checkReadiness()` (or a default function) and return `true` or
 * `{ ready: true }` only after checking its real backing service.
 */
export function createProviderReadinessProbe(
  component: ReadinessComponent,
  context: ReadinessContext,
  options: ProviderReadinessOptions = {},
): () => Promise<void> {
  return async () => {
    const setting = PROVIDER_READINESS_SETTINGS[component];
    const environment = options.environment ?? process.env;
    const specifier = environment[setting];
    if (!specifier) {
      throw new Error(
        `${setting} must name an installed provider readiness module.`,
      );
    }
    const module = (await import(
      resolveReadinessModule(specifier, options.sourceRoot ?? process.cwd())
    )) as { checkReadiness?: unknown; default?: unknown };
    const probe = module.checkReadiness || module.default;
    if (typeof probe !== 'function') {
      throw new Error(`${setting} does not export a readiness probe.`);
    }
    const result = (await probe({ component, ...context })) as
      | boolean
      | { ready?: unknown }
      | null
      | undefined;
    if (
      result !== true &&
      (typeof result !== 'object' || result === null || result.ready !== true)
    ) {
      throw new Error(`${component} provider readiness check failed.`);
    }
  };
}
