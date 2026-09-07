/**
 * SMRT Vitest Plugin
 *
 * Automatically loads manifests from SMRT peer dependencies before tests run.
 * This solves Issue #583 where cross-package integration tests fail because
 * external package classes aren't registered in the test manifest.
 *
 * Uses ManifestManager for unified manifest loading, which properly handles
 * the manifest priority order: .smrt/manifest.json (test) -> dist/manifest.json (production)
 *
 * @example
 * ```typescript
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 * import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
 *
 * export default defineConfig({
 *   plugins: [smrtVitestPlugin()],
 *   test: {
 *     globals: true,
 *     environment: 'node',
 *   },
 * });
 * ```
 *
 * @packageDocumentation
 */

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vitest/config';

/**
 * Environment variable carrying this plugin's manifest-registration options
 * (`packages`, `root`, `verbose`) from the Vitest orchestrator process to
 * every pool worker process (#2750).
 *
 * `configResolved()` below registers manifests into `ObjectRegistry`, but it
 * only ever runs in Vitest's main/orchestrator process. Test files execute
 * in separate pool worker processes (`forks`) or worker threads (`threads`)
 * that resolve `@happyvertical/smrt-core` independently — `globalThis` (and
 * so the `ObjectRegistry` singleton it backs) is not shared across OS
 * processes, and worker threads get their own JS realm too. Registration
 * done only in `configResolved()` is therefore invisible to the test code
 * that actually calls `getTestDatabase()` — it registers into a copy of the
 * registry the test never sees.
 *
 * `config()` below sets this env var as early as possible (before Vitest
 * spawns any pool worker); `./setup.ts`, which runs inside every worker via
 * `setupFiles`, reads it and re-runs the exact same registration
 * (`setupSmrtManifests`) in that worker's own process/realm. Node's
 * `child_process.fork` (the `forks` pool) and `worker_threads` (the
 * `threads` pool) both inherit `process.env` from the parent at spawn time,
 * so the option payload reaches every worker without any new public API.
 *
 * The env var's value is a JSON object keyed by resolved plugin `root`
 * (see {@link setManifestRegistrationOptionsForRoot}), not a single flat
 * options object: a Vitest multi-project config (`test.projects`) can run
 * several `smrtVitestPlugin()` instances — with different options, or none
 * at all next to one that has options — inside the same orchestrator
 * process, and `process.env` is process-global. Keying by `root` and
 * merging (never overwriting) keeps one project's options from leaking into
 * another's worker, and `setup.ts` looks its own `process.cwd()` up in the
 * map rather than reading a single ambient value.
 */
export const SMRT_VITEST_SETUP_OPTIONS_ENV_KEY =
  '__SMRT_VITEST_SETUP_OPTIONS__';

/**
 * Normalize a project root to a stable key for
 * {@link SMRT_VITEST_SETUP_OPTIONS_ENV_KEY}: resolves symlinks
 * (`fs.realpathSync`) so the write side (this plugin, running in the
 * orchestrator process) and the read side (`setup.ts`'s `process.cwd()`,
 * running in a pool worker) agree on the same key even when the two differ
 * only by a symlink — e.g. macOS's `/var` → `/private/var` (`os.tmpdir()`
 * and some CI checkouts live under it), or Linux's `/tmp` → `/private/tmp`
 * equivalents. Falls back to the raw path (still trimmed of a trailing
 * separator) when the path does not exist yet or `realpathSync` otherwise
 * fails, so this never throws.
 */
export function normalizeRootKey(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return root.replace(/[/\\]+$/, '') || root;
  }
}

/**
 * Merge `options` for `root` into {@link SMRT_VITEST_SETUP_OPTIONS_ENV_KEY},
 * preserving any other roots' entries already present (from an earlier
 * `smrtVitestPlugin()` instance in the same process — see the env var's
 * doc comment). `root` is normalized through {@link normalizeRootKey}
 * before use as the map key. Exported so `setup.ts` and tests can reason
 * about the exact payload shape without duplicating the parse/merge logic.
 */
export function setManifestRegistrationOptionsForRoot(
  root: string,
  options: SmrtVitestPluginOptions,
): void {
  const key = normalizeRootKey(root);
  let byRoot: Record<string, SmrtVitestPluginOptions> = {};
  const raw = process.env[SMRT_VITEST_SETUP_OPTIONS_ENV_KEY];
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      // `typeof [] === 'object'` too: an array here would let `byRoot[key] =
      // options` silently succeed (JS permits arbitrary string keys on
      // arrays) but `JSON.stringify()` an array only serializes integer
      // indices, dropping that property -- the env var update would appear
      // to work and then vanish. Reject non-plain-object values explicitly
      // so a foreign/malformed prior value falls through to the empty-map
      // default below instead.
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        byRoot = parsed as Record<string, SmrtVitestPluginOptions>;
      }
    } catch {
      // A malformed/foreign prior value is discarded rather than merged.
    }
  }

  byRoot[key] = options;
  process.env[SMRT_VITEST_SETUP_OPTIONS_ENV_KEY] = JSON.stringify(byRoot);
}

/**
 * Configuration options for {@link smrtVitestPlugin} and
 * {@link setupSmrtManifests}.
 *
 * All fields are optional — the defaults work for the typical single-package
 * SMRT project.  Override them when you need to tune manifest generation,
 * add extra packages, or adjust the scan scope.
 */
export interface SmrtVitestPluginOptions {
  /**
   * Extra `@happyvertical/smrt-*` package names whose manifests should be
   * loaded in addition to those discovered automatically from `package.json`.
   *
   * Useful when a dependency is not listed in `dependencies`,
   * `peerDependencies`, or `devDependencies` but still needs its classes
   * registered (e.g., a dynamically loaded plugin).
   *
   * @default [] — only auto-discovered packages are loaded
   */
  packages?: string[];

  /**
   * Emit diagnostic log lines for each manifest discovered, loaded, or
   * skipped.  Helpful when debugging "No field metadata found" errors.
   *
   * @default false
   */
  verbose?: boolean;

  /**
   * Project root used to locate `package.json` and to resolve relative
   * manifest paths.
   *
   * @default process.cwd()
   */
  root?: string;

  /**
   * Automatically generate the local manifest at vitest startup using
   * `ManifestBuilder`.  When `true`, there is no need to run
   * `smrt generate:test` or `smrt test` before running vitest.
   *
   * The manifest is generated **once** at startup and cached for the session.
   * In watch mode, restart vitest after adding new `@smrt()` classes or
   * fields to pick up the changes.
   *
   * @default true
   */
  generateManifest?: boolean;

  /**
   * Glob patterns that determine which source files are scanned for SMRT
   * classes when `generateManifest` is `true`.
   *
   * @default ['src/**\/*.ts']
   */
  include?: string[];

  /**
   * Glob patterns excluded from the manifest scan.
   *
   * @default ['**\/*.d.ts', '**\/node_modules/**', '**\/dist/**']
   */
  exclude?: string[];

  /**
   * Override the setup file injected into Vitest projects.
   *
   * Defaults to the published package entry. Workspace packages can point this
   * at a local source file while still using the same plugin API.
   */
  setupFile?: string;

  /**
   * Filter applied to the auto-generated workspace alias entries before they
   * are injected into `resolve.alias`. Receives the raw string `find` and its
   * `replacement`; return `false` to drop the entry — e.g. to force a package
   * to resolve through its published exports map instead of workspace source.
   *
   * @default undefined — every generated entry is kept
   */
  aliasFilter?: (entry: { find: string; replacement: string }) => boolean;
}

function resolveDefaultSetupFile(): string {
  const sourceSetupPath = fileURLToPath(new URL('./setup.ts', import.meta.url));
  if (existsSync(sourceSetupPath)) {
    return sourceSetupPath;
  }

  const distSetupPath = fileURLToPath(new URL('./setup.js', import.meta.url));
  if (existsSync(distSetupPath)) {
    return distSetupPath;
  }

  return '@happyvertical/smrt-vitest/setup';
}

type ViteAliasEntry = {
  find: string;
  replacement: string;
};

/**
 * Workspace alias entry as injected into Vite. `find` is an anchored RegExp
 * so an alias can only match its exact specifier: rolldown (vite 8) treats a
 * plain-string `find` as a prefix match, so a bare package alias like
 * `@org/pkg` → `src/index.ts` would mangle an unaliased subpath import
 * (`@org/pkg/sub` → `src/index.ts/sub`). Known subpaths get their own
 * entries; everything else falls through to the package exports map.
 */
export type WorkspaceViteAlias = {
  find: RegExp;
  replacement: string;
};

/**
 * Options for {@link getWorkspaceViteAliases}.
 */
export interface WorkspaceViteAliasOptions {
  /**
   * Drop generated entries by returning `false`. Receives the raw string
   * `find` (package name or package subpath) and its `replacement` path.
   */
  filter?: (entry: ViteAliasEntry) => boolean;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findWorkspaceRoot(startDir: string): string | null {
  let current = startDir;

  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return null;
    }
    current = parent;
  }
}

function getWorkspaceSourceTsconfigPath(
  startDir = process.cwd(),
): string | null {
  const workspaceRoot = findWorkspaceRoot(startDir);
  if (!workspaceRoot) {
    return null;
  }

  const tsconfigPath = join(workspaceRoot, 'tsconfig.package-build.json');
  return existsSync(tsconfigPath) ? tsconfigPath : null;
}

async function importWorkspaceSourceModule<T>(href: string): Promise<T> {
  const { register } = await import('tsx/esm/api');
  const tsconfigPath = getWorkspaceSourceTsconfigPath();
  const unregister = register(
    tsconfigPath ? { tsconfig: tsconfigPath } : undefined,
  );

  try {
    return (await import(href)) as T;
  } finally {
    await unregister();
  }
}

function readWorkspacePackageRoots(root: string): Map<string, string> {
  const workspaceRoot = findWorkspaceRoot(root);
  if (!workspaceRoot) {
    return new Map();
  }

  const packagesDir = join(workspaceRoot, 'packages');
  if (!existsSync(packagesDir)) {
    return new Map();
  }

  const packageRoots = new Map<string, string>();

  for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageRoot = join(packagesDir, entry.name);
    const packageJsonPath = join(packageRoot, 'package.json');
    if (!existsSync(packageJsonPath)) {
      continue;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
      if (typeof packageJson.name === 'string') {
        packageRoots.set(packageJson.name, packageRoot);
      }
    } catch {
      // Ignore invalid package manifests in the workspace scan.
    }
  }

  return packageRoots;
}

function addAliasIfPresent(
  aliases: ViteAliasEntry[],
  find: string,
  replacement: string,
): void {
  if (
    aliases.some((entry) => entry.find === find) ||
    !existsSync(replacement)
  ) {
    return;
  }

  if (existsSync(replacement)) {
    aliases.push({ find, replacement });
  }
}

export function getWorkspaceViteAliases(
  root = process.cwd(),
  options: WorkspaceViteAliasOptions = {},
): WorkspaceViteAlias[] {
  const packageRoots = readWorkspacePackageRoots(root);
  const aliases: ViteAliasEntry[] = [];

  for (const [packageName, packageRoot] of packageRoots.entries()) {
    addAliasIfPresent(aliases, packageName, join(packageRoot, 'src/index.ts'));
    addAliasIfPresent(
      aliases,
      `${packageName}/svelte`,
      join(packageRoot, 'src/svelte/index.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/sveltekit`,
      join(packageRoot, 'src/sveltekit/index.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/ui`,
      join(packageRoot, 'src/ui.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/routes`,
      join(packageRoot, 'src/route-module.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/playground`,
      join(packageRoot, 'src/playground.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/playground`,
      join(packageRoot, 'src/svelte/playground.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/manifest`,
      join(packageRoot, 'src/manifest/index.ts'),
    );
    addAliasIfPresent(
      aliases,
      `${packageName}/manifest.json`,
      join(packageRoot, 'src/manifest/manifest.json'),
    );
    // smrt-chat exposes an internal trusted agent-runtime subpath (S5 #1392).
    addAliasIfPresent(
      aliases,
      `${packageName}/internal/agent-runtime`,
      join(packageRoot, 'src/internal/agent-runtime.ts'),
    );
    // smrt-profiles exposes trusted OIDC primitives only to framework package
    // integrations, outside its application-facing root entry.
    addAliasIfPresent(
      aliases,
      `${packageName}/internal/oidc-provisioning`,
      join(packageRoot, 'src/internal/oidc-provisioning.ts'),
    );

    if (packageName === '@happyvertical/smrt-core') {
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/testing',
        join(packageRoot, 'src/testing.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/scanner',
        join(packageRoot, 'src/scanner/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/vite-plugin',
        join(packageRoot, 'src/vite-plugin/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/vite-plugin',
        join(packageRoot, 'src/vite-plugin.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/consumer-plugin',
        join(packageRoot, 'src/consumer-plugin/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/consumer-plugin',
        join(packageRoot, 'src/consumer-plugin.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/manifest',
        join(packageRoot, 'src/manifest/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/manifest/discover-base-classes',
        join(packageRoot, 'src/manifest/discover-base-classes.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/schema/utils',
        join(packageRoot, 'src/schema/utils.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/utils',
        join(packageRoot, 'src/utils.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/utils/import-workspace-module',
        join(packageRoot, 'src/utils/import-workspace-module.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/migrations',
        join(packageRoot, 'src/migrations.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/runtime',
        join(packageRoot, 'src/runtime.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/registry',
        join(packageRoot, 'src/registry.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators',
        join(packageRoot, 'src/generators.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators/mcp',
        join(packageRoot, 'src/generators/mcp.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/generators/rest',
        join(packageRoot, 'src/generators/rest.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/prebuild',
        join(packageRoot, 'src/prebuild.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-core/decorators',
        join(packageRoot, 'src/decorators/index.ts'),
      );
    }

    if (packageName === '@happyvertical/smrt-vitest') {
      // Shared Svelte component-test harness (S11 #1416). Flat `src/*.ts` files,
      // so the generic `/svelte` → `src/svelte/index.ts` convention misses them;
      // map the exact subpaths (every emitted alias matches exactly, so the
      // bare-package root alias can never shadow these).
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-vitest/svelte',
        join(packageRoot, 'src/svelte.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-vitest/svelte-setup',
        join(packageRoot, 'src/svelte-setup.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-vitest/a11y',
        join(packageRoot, 'src/a11y.ts'),
      );
    }

    if (packageName === '@happyvertical/smrt-ui') {
      // smrt-ui holds the domain-agnostic UI leaf (primitives, forms, feedback,
      // layout, calendar, chat, registry, theme system, i18n client). These
      // subpaths map to nested source dirs, so the generic `${packageName}/ui`
      // → `src/ui.ts` convention misses them; alias the exact source files.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/ui',
        join(packageRoot, 'src/components/ui/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/feedback',
        join(packageRoot, 'src/components/feedback/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/layout',
        join(packageRoot, 'src/components/layout/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/calendar',
        join(packageRoot, 'src/components/calendar/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/chat',
        join(packageRoot, 'src/components/chat/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/forms',
        join(packageRoot, 'src/components/forms/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/registry',
        join(packageRoot, 'src/registry/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/theme',
        join(packageRoot, 'src/theme/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/themes',
        join(packageRoot, 'src/themes/index.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/i18n',
        join(packageRoot, 'src/i18n/index.ts'),
      );
      // Test-support harness (a11y helper + setup) moved here with the leaf;
      // smrt-svelte's surviving component tests import it cross-package.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/test-support/a11y',
        join(packageRoot, 'src/test-support/a11y.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/test-support/setup',
        join(packageRoot, 'src/test-support/setup.ts'),
      );
      // utils ships nested helpers consumed by smrt-svelte's surviving forms.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/utils/forms/formatters.js',
        join(packageRoot, 'src/utils/forms/formatters.ts'),
      );
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-ui/utils/import-optional.js',
        join(packageRoot, 'src/utils/import-optional.ts'),
      );
    }

    if (packageName === '@happyvertical/smrt-web') {
      // The document-global WebMCP tool-name lock (#2613) ships as its own
      // dependency-free entry so a UI layer can reserve its fixed `smrt_ui_*`
      // names without pulling the client-data engine. Without this alias a
      // consumer test resolves it through the exports map to stale dist while
      // resolving the package root to source — two copies of the module.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-web/webmcp-tool-names',
        join(packageRoot, 'src/webmcp-tool-names.ts'),
      );
      // The declarative view-intent entry (#2588) is dependency-free for the
      // same reason and has the same stale-dist hazard.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-web/intents',
        join(packageRoot, 'src/intents.ts'),
      );
    }

    if (packageName === '@happyvertical/smrt-svelte') {
      // The domain-agnostic UI leaf subpaths moved to @happyvertical/smrt-ui
      // (#1582). smrt-svelte keeps the Node-only server i18n resolver here.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/i18n/server',
        join(packageRoot, 'src/i18n/server.ts'),
      );
      // Svelte 5 live-query bindings for smrt-web (#1761). The generic
      // `${packageName}/svelte` convention above does not cover `/web`, so the
      // subpath needs its own alias or consumer TESTS resolve to stale dist.
      addAliasIfPresent(
        aliases,
        '@happyvertical/smrt-svelte/web',
        join(packageRoot, 'src/web/index.ts'),
      );
    }
  }

  const { filter } = options;
  const kept = filter ? aliases.filter((entry) => filter(entry)) : aliases;

  return kept
    .sort((left, right) => right.find.length - left.find.length)
    .map(({ find, replacement }) => ({
      // Anchored exact match — see WorkspaceViteAlias. Without the anchors,
      // rolldown prefix-matches string finds and mangles unaliased subpath
      // imports (e.g. `@anytown/deploy/deploy/pipeline`, anytown.ai#707).
      find: new RegExp(`^${escapeRegExp(find)}$`),
      replacement,
    }));
}

function normalizeAliasEntries(
  alias: unknown,
): Array<{ find: string | RegExp; replacement: string }> {
  if (Array.isArray(alias)) {
    return alias.filter(
      (entry): entry is { find: string | RegExp; replacement: string } =>
        Boolean(entry) &&
        typeof entry === 'object' &&
        'find' in entry &&
        'replacement' in entry,
    );
  }

  if (alias && typeof alias === 'object') {
    return Object.entries(alias).map(([find, replacement]) => ({
      find,
      replacement: String(replacement),
    }));
  }

  return [];
}

/**
 * Discover SMRT packages from package.json dependencies
 */
function discoverSmrtPackages(
  root: string,
  additionalPackages: string[] = [],
): string[] {
  const packageJsonPath = join(root, 'package.json');

  if (!existsSync(packageJsonPath)) {
    console.warn('[smrt-vitest] No package.json found at', root);
    return additionalPackages;
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
    const allDeps = {
      ...packageJson.dependencies,
      ...packageJson.peerDependencies,
      ...packageJson.devDependencies,
    };

    // Find all @happyvertical/smrt-* packages (except smrt-vitest itself)
    const smrtPackages = Object.keys(allDeps).filter(
      (pkg) =>
        pkg.startsWith('@happyvertical/smrt-') &&
        pkg !== '@happyvertical/smrt-vitest',
    );

    // Combine with additional packages, removing duplicates
    const allPackages = [...new Set([...smrtPackages, ...additionalPackages])];

    return allPackages;
  } catch (error) {
    console.error('[smrt-vitest] Failed to read package.json:', error);
    return additionalPackages;
  }
}

/**
 * Find the root directory of a package
 * Tries require.resolve first, then falls back to node_modules lookup
 */
function findPackageRoot(packageName: string): string | null {
  const require = createRequire(`${process.cwd()}/package.json`);

  // Method 1: Try require.resolve to find package entry, then walk up to package.json
  try {
    const pkgMainPath = require.resolve(packageName);
    let dir = dirname(pkgMainPath);

    for (let i = 0; i < 10; i++) {
      const pkgJsonPath = join(dir, 'package.json');
      if (existsSync(pkgJsonPath)) {
        try {
          const content = readFileSync(pkgJsonPath, 'utf-8');
          const json = JSON.parse(content);
          if (json.name === packageName) {
            return dir;
          }
        } catch {
          // Keep walking up
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // Fall through to Method 2
  }

  // Method 2: Direct node_modules lookup (for file: protocol linked packages)
  const nodeModulesPath = join(process.cwd(), 'node_modules', packageName);
  const pkgJsonPath = join(nodeModulesPath, 'package.json');

  if (existsSync(pkgJsonPath)) {
    try {
      const content = readFileSync(pkgJsonPath, 'utf-8');
      const json = JSON.parse(content);
      if (json.name === packageName) {
        return nodeModulesPath;
      }
    } catch {
      // Fall through
    }
  }

  // Method 3: Workspace package (sibling in monorepo)
  const packageShortName = packageName.split('/').pop() || '';
  const packageWithoutScope = packageShortName.replace(/^smrt-/, '');

  const workspacePaths = [
    join(process.cwd(), '..', packageWithoutScope),
    join(process.cwd(), '..', packageShortName),
  ];

  for (const workspacePath of workspacePaths) {
    const workspacePkgPath = join(workspacePath, 'package.json');
    if (existsSync(workspacePkgPath)) {
      try {
        const content = readFileSync(workspacePkgPath, 'utf-8');
        const json = JSON.parse(content);
        if (json.name === packageName) {
          return workspacePath;
        }
      } catch {
        // Keep trying
      }
    }
  }

  return null;
}

async function importSmrtCoreModule(): Promise<
  typeof import('@happyvertical/smrt-core')
> {
  const specifier = '@happyvertical/smrt-core';

  try {
    return await import(specifier);
  } catch {
    const fallbackHref = new URL('../../core/src/index.ts', import.meta.url)
      .href;
    return await importWorkspaceSourceModule(fallbackHref);
  }
}

async function importSmrtCoreManifestModule(): Promise<
  typeof import('@happyvertical/smrt-core/manifest')
> {
  const specifier = '@happyvertical/smrt-core/manifest';

  try {
    return await import(specifier);
  } catch {
    const fallbackHref = new URL(
      '../../core/src/manifest/index.ts',
      import.meta.url,
    ).href;
    return await importWorkspaceSourceModule(fallbackHref);
  }
}

async function importDiscoverBaseClassesModule(): Promise<
  typeof import('@happyvertical/smrt-core/manifest/discover-base-classes')
> {
  const specifier = '@happyvertical/smrt-core/manifest/discover-base-classes';

  try {
    return await import(specifier);
  } catch {
    const fallbackHref = new URL(
      '../../core/src/manifest/discover-base-classes.ts',
      import.meta.url,
    ).href;
    return await importWorkspaceSourceModule(fallbackHref);
  }
}

/**
 * Load manifest from a package using ManifestManager
 *
 * This properly handles the manifest priority order:
 * 1. .smrt/manifest.json (test/dev manifest with all classes)
 * 2. dist/manifest.json (production manifest)
 */
async function loadAndRegisterManifest(
  packageName: string,
  verbose: boolean,
): Promise<boolean> {
  try {
    const { ObjectRegistry } = await importSmrtCoreModule();
    const { ManifestManager } = await importSmrtCoreManifestModule();

    // Find the package root directory
    const packageRoot = findPackageRoot(packageName);
    if (!packageRoot) {
      if (verbose) {
        console.log(
          `[smrt-vitest] Could not find package root for ${packageName}`,
        );
      }
      return false;
    }

    // Use ManifestManager to load manifest with proper priority
    // (.smrt/manifest.json -> dist/manifest.json)
    const manager = new ManifestManager(packageRoot);
    const manifest = manager.loadLocal();

    if (!manifest) {
      if (verbose) {
        console.log(`[smrt-vitest] No manifest found for ${packageName}`);
      }
      return false;
    }

    const registered = registerManifestObjects(
      ObjectRegistry,
      manifest,
      manifest.packageName || packageName,
    );

    if (verbose || registered > 0) {
      console.log(
        `[smrt-vitest] Loaded ${registered} classes from ${packageName}`,
      );
    }

    return true;
  } catch (error) {
    if (verbose) {
      console.error(
        `[smrt-vitest] Failed to load manifest from ${packageName}:`,
        error,
      );
    }
    return false;
  }
}

/**
 * Patterns identifying a manifest object as declared INLINE inside a test
 * file itself (`some-behavior.test.ts` decorating a throwaway class in the
 * same file), not merely located somewhere under a test-ish directory.
 * Deliberately narrower than `packages/core/src/scanner/test-file-patterns.ts`'s
 * `isTestFile()` (used there for a lower-stakes purpose, documentation/
 * API-surface visibility inference): a broader directory-based heuristic
 * (`__tests__/`, `fixtures?/`, `/test/`, `/mocks?/`) over-fires here and
 * wrongly excludes legitimate non-test model files that merely happen to
 * live under a `fixtures/`-named directory, such as
 * `packages/vitest/src/__tests__/fixtures/issue-2750-registry-fixture/src/models/widget.ts`
 * -- a full consumer-shaped fixture PROJECT (this very package's own #2750
 * regression test), not an inline test double. Matching only the file's own
 * `.test.`/`.spec.` suffix keeps the exclusion scoped to what it's actually
 * for: a class decorated directly inside test code (see
 * `registerManifestObjects` below).
 */
const TEST_FILE_PATTERNS = [
  /\.test\.(ts|tsx|js|jsx)$/,
  /\.spec\.(ts|tsx|js|jsx)$/,
];

function isManifestEntryFromTestFile(objectDef: unknown): boolean {
  const filePath = (objectDef as { filePath?: unknown } | null)?.filePath;
  return (
    typeof filePath === 'string' &&
    TEST_FILE_PATTERNS.some((pattern) => pattern.test(filePath))
  );
}

function registerManifestObjects(
  ObjectRegistry: {
    hasClass(name: string): boolean;
    registerFromManifest(
      name: string,
      objectDef: unknown,
      packageName?: string,
    ): void;
  },
  manifest: { objects?: Record<string, unknown>; packageName?: string } | null,
  packageName?: string,
): number {
  if (!manifest?.objects) {
    return 0;
  }

  // Skip manifest entries declared inside test files (#2750 follow-up): a
  // class decorated inline in a `*.test.ts`/`__tests__/` fixture (e.g. a
  // throwaway model used only by that one test file) is captured by the
  // package-wide manifest scan just like any production model, but it was
  // never meant to be visible outside the file that declares it -- on the
  // pre-#2750 decorator-only registration path, it simply never was, since
  // only classes reached by the currently-running test file's own import
  // graph got registered. #2750's worker-side re-registration (this file's
  // `setupSmrtManifests`, invoked from every worker via
  // `packages/vitest/src/setup.ts`) bulk-registers every manifest entry for
  // the package regardless of which test file is running, so a fixture
  // class now leaks into every other test file in the same package/worker
  // -- reproduced by `packages/chat`'s `chat-security.test.ts` (a
  // registry-wide audit of "every registered @happyvertical/smrt-chat
  // model") tripping over `ConvNote`, a full-CRUD test double declared in
  // `persona-conversation.test.ts`, once that file's manifest entry became
  // visible package-wide. The fixture's OWN file still registers it
  // correctly via ordinary decorator-import execution when that file
  // itself runs; only the manifest-driven BULK path is scoped down here.
  let registered = 0;
  for (const [name, objectDef] of Object.entries(manifest.objects)) {
    if (isManifestEntryFromTestFile(objectDef)) {
      continue;
    }
    if (!ObjectRegistry.hasClass(name)) {
      ObjectRegistry.registerFromManifest(name, objectDef, packageName);
      registered++;
    }
  }

  return registered;
}

async function loadAndRegisterLocalManifest(
  root: string,
  verbose: boolean,
): Promise<boolean> {
  try {
    const { ObjectRegistry } = await importSmrtCoreModule();
    const { ManifestManager } = await importSmrtCoreManifestModule();

    const manager = new ManifestManager(root);
    const manifest = manager.loadLocal();

    if (!manifest) {
      if (verbose) {
        console.log('[smrt-vitest] No local manifest found');
      }
      return false;
    }

    const registered = registerManifestObjects(
      ObjectRegistry,
      manifest,
      manifest.packageName,
    );

    if (verbose || registered > 0) {
      console.log(
        `[smrt-vitest] Loaded ${registered} classes from local manifest`,
      );
    }

    return true;
  } catch (error) {
    if (verbose) {
      console.error('[smrt-vitest] Failed to load local manifest:', error);
    }
    return false;
  }
}

/**
 * Generate local manifest using ManifestBuilder
 *
 * This ensures the manifest is always fresh after adding new classes/fields.
 * The ~1-2s overhead is minimal compared to test execution time.
 */
async function generateLocalManifest(
  _root: string,
  options: SmrtVitestPluginOptions,
  verbose: boolean,
): Promise<boolean> {
  try {
    console.log('[smrt-vitest] Generating test manifest...');

    const { ManifestBuilder } = await importSmrtCoreManifestModule();
    const { discoverBaseClasses } = await importDiscoverBaseClassesModule();

    // Discover base classes from external SMRT packages
    const baseClasses = await discoverBaseClasses();

    if (verbose) {
      console.log(
        `[smrt-vitest] Discovered ${baseClasses.length} base classes (including ${baseClasses.length - 3} from external packages)`,
      );
    }

    const builder = new ManifestBuilder();
    const manifest = await builder.generate({
      // File discovery
      include: options.include || ['src/**/*.ts'],
      exclude: options.exclude || [
        '**/*.d.ts',
        '**/node_modules/**',
        '**/dist/**',
      ],

      // Scanner configuration
      baseClasses,
      followImports: true,
      loadViteConfig: true,
      discoverExternalPackages: true,
      includeExternalBaseClasses: true,
      includePrivateMethods: false,
      includeStaticMethods: true,

      // Output configuration - write to .smrt directory (ManifestManager default)
      outputDir: '.smrt',
      outputName: 'manifest.json',
      generateTypeStub: false,

      // Metadata
      injectPackageInfo: true,
      moduleType: 'smrt',
    });

    const objectCount = Object.keys(manifest.objects).length;
    console.log(
      `[smrt-vitest] ✓ Generated manifest with ${objectCount} object(s)`,
    );

    return true;
  } catch (error) {
    console.error('[smrt-vitest] Failed to generate manifest:', error);
    return false;
  }
}

/**
 * Vitest's `test.retry` accepts a plain count or an object form
 * (`{ count, delay }`). Mirror that so explicit object configs survive.
 */
type RetryConfig = number | { count?: number; delay?: number };

/**
 * Build the `oxc` transform defaults injected into the consumer config.
 *
 * Vite 8 (rolldown) transforms TypeScript with oxc and ignores the old
 * `esbuild.tsconfigRaw` escape hatch, which breaks SMRT projects in two ways
 * (evidence: anytown.ai#707, willgriffin.dev#220):
 *
 * - `@smrt()` legacy decorators reach the bundle untransformed unless
 *   `oxc.decorator.legacy` is enabled;
 * - oxc elides imports that are only referenced in type positions, silently
 *   dropping side-effect model imports (SMRT object registration) in test
 *   files that sit outside the tsconfig `include`, unless
 *   `oxc.typescript.onlyRemoveTypeImports` is enabled.
 *
 * Every field the consumer configured themselves is left alone — a default is
 * only injected when the consumer has not set that field, so explicit
 * consumer values always win (vite deep-merges the rest). `oxc: false`
 * disables the oxc transform entirely and suppresses all injection. The keys
 * are inert on esbuild-based vite ≤ 7.
 */
function resolveOxcDefaults(
  userOxc: unknown,
): Record<string, unknown> | undefined {
  if (
    userOxc !== undefined &&
    (typeof userOxc !== 'object' || userOxc === null)
  ) {
    return undefined;
  }

  const user = (userOxc ?? {}) as {
    decorator?: unknown;
    tsconfig?: unknown;
    typescript?: unknown;
  };

  const defaults: Record<string, unknown> = {};

  if (user.decorator === undefined) {
    defaults.decorator = {
      legacy: true,
      emitDecoratorMetadata: true,
    };
    // The tsconfig compiler-option mirror only makes sense alongside the
    // decorator default — a consumer overriding `decorator` owns both.
    if (user.tsconfig === undefined) {
      defaults.tsconfig = {
        compilerOptions: {
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
        },
      };
    }
  }

  const typescriptConfigured =
    user.typescript !== undefined &&
    (typeof user.typescript !== 'object' ||
      user.typescript === null ||
      'onlyRemoveTypeImports' in user.typescript);
  if (!typescriptConfigured) {
    defaults.typescript = { onlyRemoveTypeImports: true };
  }

  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

/**
 * Resolve the per-test `retry` injected into the vitest config.
 *
 * Precedence: `SMRT_VITEST_RETRY` (a digits-only, non-negative integer) wins;
 * otherwise an explicit consumer value is preserved as-is — including the object
 * form (`{ count, delay }`) — so options aren't dropped; otherwise the default is
 * 2 retries in CI (`process.env.CI`) and 0 everywhere else, so local runs surface
 * flaky tests immediately while the shared cross-package CI job tolerates rare
 * transient timing flakes.
 */
function resolveRetry(explicitRetry?: RetryConfig): RetryConfig {
  const override = process.env.SMRT_VITEST_RETRY;
  // Digits-only so "2x"/"2.5"/"-1" fall through to the explicit/default value
  // rather than being silently coerced by parseInt.
  if (override != null && /^\d+$/.test(override)) {
    return Number.parseInt(override, 10);
  }
  if (explicitRetry != null) {
    return explicitRetry;
  }
  return process.env.CI ? 2 : 0;
}

/**
 * Create the SMRT Vitest plugin
 *
 * This plugin automatically generates and loads manifests before tests run,
 * enabling cross-package integration tests without needing to run `smrt test` first.
 *
 * @param options - Plugin configuration options
 * @returns Vitest plugin
 *
 * @example Basic usage
 * ```typescript
 * import { defineConfig } from 'vitest/config';
 * import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
 *
 * export default defineConfig({
 *   plugins: [smrtVitestPlugin()],
 * });
 * ```
 *
 * @example With additional packages
 * ```typescript
 * import { defineConfig } from 'vitest/config';
 * import { smrtVitestPlugin } from '@happyvertical/smrt-vitest';
 *
 * export default defineConfig({
 *   plugins: [
 *     smrtVitestPlugin({
 *       packages: ['@my-org/custom-smrt-package'],
 *       verbose: true,
 *     }),
 *   ],
 * });
 * ```
 *
 * @example Disable auto-generation (use pre-built manifest)
 * ```typescript
 * export default defineConfig({
 *   plugins: [
 *     smrtVitestPlugin({
 *       generateManifest: false, // Use existing manifest only
 *     }),
 *   ],
 * });
 * ```
 */
export function smrtVitestPlugin(
  options: SmrtVitestPluginOptions = {},
): Plugin {
  const {
    packages = [],
    verbose = false,
    root = process.cwd(),
    generateManifest = true,
    setupFile = resolveDefaultSetupFile(),
    aliasFilter,
  } = options;

  let manifestsLoaded = false;
  const setupFileId = setupFile;
  const workspaceAliases = getWorkspaceViteAliases(root, {
    filter: aliasFilter,
  });

  const ensureSetupFiles = (value: string | string[] | undefined): string[] => {
    const setupFiles = Array.isArray(value) ? [...value] : value ? [value] : [];

    if (!setupFiles.includes(setupFileId)) {
      setupFiles.push(setupFileId);
    }

    return setupFiles;
  };

  const applyTestDefaultsToProjects = (
    projects: unknown[] | undefined,
    rootRetry: RetryConfig | undefined,
  ): void => {
    projects?.forEach((project) => {
      if (!project || typeof project !== 'object' || !('test' in project)) {
        return;
      }

      const projectConfig = project as Record<string, unknown> & {
        test?: { setupFiles?: string | string[]; retry?: RetryConfig };
      };

      projectConfig.test = {
        ...projectConfig.test,
        // Vitest does NOT inherit the root `test.retry` into per-project configs,
        // so apply it here, falling back to the root retry (then the CI default)
        // when the project has none. resolveRetry preserves an explicit
        // per-project value unless SMRT_VITEST_RETRY forces one.
        retry: resolveRetry(projectConfig.test?.retry ?? rootRetry),
        setupFiles: ensureSetupFiles(projectConfig.test?.setupFiles),
      };
    });
  };

  return {
    name: 'smrt-vitest',

    config(userConfig) {
      // Propagate manifest-registration options to every worker process this
      // early — before Vitest spawns any pool worker — so ./setup.ts can
      // re-run registration inside the worker's own process/realm (#2750).
      // Must happen in `config()`, not `configResolved()`: Vitest begins
      // spawning/pre-warming pool workers (which snapshot `process.env` at
      // `child_process.fork()`/`worker_threads` spawn time) concurrently
      // with plugin config resolution, and `configResolved()` running later
      // than that spawn left already-forked workers with a stale (missing)
      // env var — confirmed empirically: moving this call to
      // `configResolved()` broke the fixture regression test even though
      // `configResolved()` is still awaited before the FIRST test file runs.
      // `config()` is the earliest hook available and keeps the working
      // behavior from #2750's original fix.
      //
      // Keyed by `root` (merged into any existing payload, never
      // overwritten, normalized through `normalizeRootKey` to resolve
      // symlinks) rather than a single flat value: several
      // `smrtVitestPlugin()` instances -- with different options, or none at
      // all next to one that has options -- can run inside the SAME
      // orchestrator process (e.g. a Vitest multi-project `test.projects`
      // run), and `process.env` is process-global. A flat value let the
      // last project's call silently overwrite every earlier project's
      // options, contaminating unrelated projects' worker registration.
      // `setup.ts` looks its own (`normalizeRootKey`-d) `process.cwd()` up
      // in this map.
      //
      // Known residual limitation: `root` here is this closure's
      // construction-time value (`options.root ?? process.cwd()`), not a
      // per-project Vite-resolved root -- Vite never `chdir`s while loading
      // project configs, so every `smrtVitestPlugin()` instance in one
      // `test.projects` array that leaves `root` at its default computes the
      // identical key regardless of which project subdirectory it actually
      // lives in, and the last one to call `config()` wins for all of them.
      // Bounded by `registerManifestObjects()`'s `hasClass()` guard to extra
      // additive registrations (never corruption) plus extra `verbose`
      // logging; a project needing distinct isolation in that shape should
      // pass an explicit, distinct `root` to `smrtVitestPlugin()`.
      setManifestRegistrationOptionsForRoot(root, { packages, root, verbose });

      const rootRetry = userConfig.test?.retry as RetryConfig | undefined;
      applyTestDefaultsToProjects(userConfig.test?.projects, rootRetry);
      const setupFiles = ensureSetupFiles(userConfig.test?.setupFiles);
      const resolveConfig =
        userConfig.resolve && typeof userConfig.resolve === 'object'
          ? (userConfig.resolve as { alias?: unknown })
          : undefined;
      const alias = normalizeAliasEntries(resolveConfig?.alias);

      return {
        // Vite 8 (rolldown/oxc) defaults — legacy @smrt() decorators and
        // type-import elision (see resolveOxcDefaults). Fields the consumer
        // configured are never injected; `undefined` is dropped by vite's
        // config merge, so this key vanishes when there is nothing to add.
        oxc: resolveOxcDefaults((userConfig as { oxc?: unknown }).oxc),
        resolve: {
          alias: [...workspaceAliases, ...alias],
        },
        test: {
          setupFiles,
          // Re-run a failed test before failing the run, in CI only. Several
          // packages have rare, CI-environment-specific timing flakes that pass
          // on re-run (observed: every flaky "Test Packages" failure went green
          // on rerun, on a different package each time, none reproducible
          // locally). Retry keeps the shared cross-package CI job reliable
          // WITHOUT masking real failures — a deterministic failure still fails
          // all attempts, and vitest reports retried tests as "flaky" so they
          // stay visible. An explicit `test.retry` in the consumer config is
          // preserved (including the object form); override with
          // SMRT_VITEST_RETRY=<n>.
          retry: resolveRetry(rootRetry),
        },
      };
    },

    // Run during config resolution to ensure manifests are loaded before tests
    async configResolved() {
      if (manifestsLoaded) return;

      // Step 1: Generate local manifest if enabled (default: true)
      // This ensures manifest is always fresh after adding new classes/fields
      if (generateManifest) {
        await generateLocalManifest(root, options, verbose);
      }

      // Step 2: Load the local manifest so late-imported local classes are
      // available to schema preparation before the first DB call.
      await loadAndRegisterLocalManifest(root, verbose);

      // Step 3: Discover and load manifests from SMRT peer dependencies
      const smrtPackages = discoverSmrtPackages(root, packages);

      if (smrtPackages.length === 0) {
        if (verbose) {
          console.log('[smrt-vitest] No SMRT packages found to load');
        }
      } else {
        if (verbose) {
          console.log(
            `[smrt-vitest] Discovered ${smrtPackages.length} SMRT packages:`,
            smrtPackages,
          );
        }

        // Load manifests from all discovered packages
        const results = await Promise.all(
          smrtPackages.map((pkg) => loadAndRegisterManifest(pkg, verbose)),
        );

        const successCount = results.filter(Boolean).length;
        console.log(
          `[smrt-vitest] Loaded manifests from ${successCount}/${smrtPackages.length} packages`,
        );
      }

      // Step 4: Validate local manifest is loaded
      try {
        const { ManifestManager } = await importSmrtCoreManifestModule();
        const manager = new ManifestManager(root);
        const localManifest = manager.loadLocal();

        if (localManifest) {
          console.log(
            `[smrt-vitest] ✓ Local manifest: ${Object.keys(localManifest.objects).length} objects`,
          );
        } else if (!generateManifest) {
          // Only show warning if auto-generation is disabled
          // (if enabled and still missing, generateLocalManifest already logged an error)
          const devPath = manager.getOutputPath('dev');
          const buildPath = manager.getOutputPath('build');

          console.warn(`
╔═══════════════════════════════════════════════════════════════════════╗
║  [smrt-vitest] WARNING: No local manifest found                       ║
╠═══════════════════════════════════════════════════════════════════════╣
║  Tests may fail with "No field metadata found" errors.                ║
║                                                                       ║
║  Checked locations:                                                   ║
║    • ${devPath.padEnd(55)}║
║    • ${buildPath.padEnd(55)}║
║                                                                       ║
║  To fix, either:                                                      ║
║    • Enable generateManifest: true in plugin options (default)        ║
║    • Run: smrt generate:test                                          ║
║    • Run: npm run build (if manifest is part of build)                ║
╚═══════════════════════════════════════════════════════════════════════╝
          `);
        }
      } catch (error) {
        if (verbose) {
          console.warn(
            '[smrt-vitest] Could not validate local manifest:',
            error,
          );
        }
      }

      manifestsLoaded = true;
    },
  };
}

/**
 * Discover and register SMRT manifests from peer dependencies.
 *
 * An imperative alternative to {@link smrtVitestPlugin} for environments
 * where a Vite plugin is not available (e.g., a plain `globalSetup` file or
 * a custom test runner bootstrap).
 *
 * The function reads `package.json` in the working directory, finds all
 * `@happyvertical/smrt-*` dependencies, locates their manifest files, and
 * registers every class in the global `ObjectRegistry`.  It does **not**
 * generate a new manifest — use `smrtVitestPlugin()` with
 * `generateManifest: true` (the default) if auto-generation is needed.
 *
 * @param options - Same options accepted by {@link smrtVitestPlugin}.
 *   Relevant fields: `packages`, `verbose`, `root`.
 * @returns A promise that resolves once all manifests have been loaded.
 *
 * @example
 * ```typescript
 * // vitest.config.ts
 * import { defineConfig } from 'vitest/config';
 *
 * export default defineConfig({
 *   test: {
 *     globalSetup: ['@happyvertical/smrt-vitest/setup'],
 *   },
 * });
 * ```
 *
 * @example Calling directly in a custom bootstrap
 * ```typescript
 * import { setupSmrtManifests } from '@happyvertical/smrt-vitest';
 *
 * await setupSmrtManifests({ verbose: true });
 * ```
 *
 * @see {@link smrtVitestPlugin} for the recommended Vite-plugin approach that
 *   also handles manifest generation.
 */
export async function setupSmrtManifests(
  options: SmrtVitestPluginOptions = {},
): Promise<void> {
  const { packages = [], verbose = false, root = process.cwd() } = options;

  await loadAndRegisterLocalManifest(root, verbose);

  const smrtPackages = discoverSmrtPackages(root, packages);

  if (smrtPackages.length === 0) {
    return;
  }

  if (verbose) {
    console.log(
      `[smrt-vitest] Discovered ${smrtPackages.length} SMRT packages:`,
      smrtPackages,
    );
  }

  // Load manifests from all discovered packages
  const results = await Promise.all(
    smrtPackages.map((pkg) => loadAndRegisterManifest(pkg, verbose)),
  );

  const successCount = results.filter(Boolean).length;
  console.log(
    `[smrt-vitest] Loaded manifests from ${successCount}/${smrtPackages.length} packages`,
  );
}

export default smrtVitestPlugin;

// Export test database utilities
export {
  createIsolatedTestDb,
  createIsolatedTestDbFromManifest,
  createTestDb,
  getAdapterDisplayName,
  getInMemoryDbConfig,
  getTestAdapter,
  getTestDbConfig,
  type IsolatedTestDbOptions,
  type IsolatedTestDbResult,
  isPostgresAvailable,
  type ManifestTestDbOptions,
  type TestDbAdapter,
  type TestDbConfig,
} from './test-db.js';

// Export transaction types (temporary until SDK #722 is merged)
export type { TransactionHandle } from './types.js';
