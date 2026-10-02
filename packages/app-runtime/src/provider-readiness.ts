/**
 * Provider-owned readiness probes for deployed profiles.
 *
 * Ported from the template's `scripts/smrt-provider-readiness.mjs`. The
 * module named by the environment setting is resolved from the application
 * (not from this CLI package), because it is the application's installed
 * provider adapter.
 */

import { randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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

/** Evaluated by Node itself; exposes `import.meta.resolve` to the hook. */
const RESOLVER_MODULE =
  'data:text/javascript,export default (s) => import.meta.resolve(s)';

/**
 * Resolve a bare specifier exactly as an ES module located at `sourceRoot`
 * would, using Node's own ESM resolver (exports/imports maps, condition
 * order, PATTERN_KEY_COMPARE, null targets, invalid-target rejection).
 *
 * Node 26 still flags `import.meta.resolve(specifier, parent)`, so a
 * synchronous `module.registerHooks()` resolve hook re-parents one unique
 * token onto the application's `package.json` and delegates to the default
 * resolver; the hook is removed before this returns.
 */
async function resolveFromApplication(
  specifier: string,
  sourceRoot: string,
): Promise<string> {
  const parentURL = pathToFileURL(
    join(resolve(sourceRoot), 'package.json'),
  ).href;
  const token = `smrt-app-readiness-${randomUUID()}`;
  const hooks = registerHooks({
    resolve(requested, context, nextResolve) {
      return requested === token
        ? nextResolve(specifier, { ...context, parentURL })
        : nextResolve(requested, context);
    },
  });
  try {
    // A data: module is evaluated by Node itself, so its import.meta.resolve
    // runs through the hook (and not through a test runner's resolver).
    const resolver = (await import(/* @vite-ignore */ RESOLVER_MODULE)) as {
      default: (value: string) => string;
    };
    return resolver.default(token);
  } finally {
    hooks.deregister();
  }
}

/**
 * Resolve a readiness module specifier the way the application would.
 *
 * URLs (`data:`, `file:`) are imported as given; absolute paths become file
 * URLs; relative paths resolve against the application root; bare package
 * specifiers resolve through Node's ESM resolver from the application root
 * (as the template's in-app `import()` did) and must land inside the
 * package installed in the application's own `node_modules` chain.
 */
export async function resolveReadinessModule(
  specifier: string,
  sourceRoot: string,
): Promise<string> {
  if (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !isAbsolute(specifier)) {
    return specifier;
  }
  if (isAbsolute(specifier)) return pathToFileURL(specifier).href;
  if (specifier.startsWith('./') || specifier.startsWith('../')) {
    return pathToFileURL(resolve(sourceRoot, specifier)).href;
  }
  const installed = findInstalledPackage(sourceRoot, packageNameOf(specifier));
  if (!installed) {
    throw new Error(`${specifier} is not installed in the application.`);
  }
  const packageRoot = realpathSync(installed);
  const resolvedUrl = await resolveFromApplication(specifier, sourceRoot);
  const resolvedPath = realpathSync(fileURLToPath(resolvedUrl));
  if (
    resolvedPath !== packageRoot &&
    !resolvedPath.startsWith(`${packageRoot}${sep}`)
  ) {
    throw new Error(
      `${specifier} resolved outside its installed package; refusing to load it.`,
    );
  }
  return pathToFileURL(resolvedPath).href;
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
      await resolveReadinessModule(
        specifier,
        options.sourceRoot ?? process.cwd(),
      )
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
