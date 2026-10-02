/**
 * Provider-owned readiness probes for deployed profiles.
 *
 * Ported from the template's `scripts/smrt-provider-readiness.mjs`. The
 * module named by the environment setting is resolved from the application
 * (not from this CLI package), because it is the application's installed
 * provider adapter.
 */

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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
 * specifiers resolve through the application's own `node_modules`.
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
  const installed = findInstalledPackage(sourceRoot, packageNameOf(specifier));
  if (!installed) {
    throw new Error(`${specifier} is not installed in the application.`);
  }
  // The package is in the application's own node_modules chain, which
  // CommonJS resolution searches before any NODE_PATH entry.
  const requireFromApplication = createRequire(
    join(resolve(sourceRoot), 'package.json'),
  );
  return pathToFileURL(requireFromApplication.resolve(specifier)).href;
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
