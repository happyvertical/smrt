/**
 * Single-plugin Vite preset for SMRT applications.
 *
 * `plugins: [sveltekit(), smrt()]` replaces the hand-copied glue every app
 * carried: the Oxc legacy-decorator block, `smrtConsumer({...})` with an
 * explicit package list, and `smrtPlugin({...})` with the SvelteKit path
 * options. `smrtConsumer` and `smrtPlugin` stay public and unchanged.
 */

import { smrtConsumer } from '../consumer-plugin/index.js';
import {
  type HostToolNameDeclaration,
  type SmrtPluginOptions,
  smrtPlugin,
} from '../vite-plugin/index.js';
import type {
  SmrtDecoratorConfig,
  SmrtUserConfig,
  SmrtVitePlugin,
} from '../vite-plugin/plugin-contract.js';
import { resolveCookbookHostedObjects } from './cookbook-exposure.js';

export interface SmrtPresetOptions {
  /**
   * SMRT packages whose object manifests this app consumes. Takes precedence
   * over `consumer.packages` in `smrt.config.ts`. An empty array declares that
   * the app consumes none. Tooling/UI packages must not be listed.
   */
  packages?: readonly string[];
  /**
   * Consumed package models to host over generated REST routes, as
   * provider-qualified refs (`@scope/pkg:Model`). This is an HTTP exposure
   * boundary: each model's own `api` config still applies, so an `api: false`
   * model stays closed. Omit to derive it from `smrt.cookbook.json` (the models
   * of its recipes and `features`, minus those its `exposure` turns off for
   * `api`); without a cookbook nothing is hosted. `[]` hosts nothing.
   */
  expose?: readonly string[];
  /**
   * Project root. Omit to follow the root Vite/SvelteKit resolve (the launch
   * cwd); `smrt.config.ts` is searched from this value or `process.cwd()`.
   */
  projectRoot?: string;
  /** Directory of the app's own `@smrt()` objects. Default `src/lib/objects`. */
  objectsDir?: string;
  /** Generated type declarations. Default `src/lib/types/smrt-generated`. */
  typesDir?: string;
  /** Generated API routes. Default `src/routes/api`. */
  routesDir?: string;
  /** Directory holding the generated runtime config module. Default `src/lib/server`. */
  configPath?: string;
  /** File name of that module. Default `smrt.ts`. */
  configFileName?: string;
  /** Source globs scanned for objects. Default `<objectsDir>/**\/*.ts`. */
  include?: string[];
  /** Source globs excluded from the scan. Default test and spec files. */
  exclude?: string[];
  /**
   * Apply the Oxc legacy-decorator config. Default `true`. Values the app sets
   * under `oxc.decorator` itself are never overwritten.
   */
  decorators?: boolean;
  /**
   * Host-declared agent tool names (workflow, bespoke WebMCP and MCP tools),
   * forwarded unchanged to `smrtPlugin({ hostToolNames })`. A name two
   * different declarations claim, or that shadows a generated model tool,
   * fails the build; one operation (`declaredBy`) on several surfaces is
   * allowed. Omit to skip the check.
   */
  hostToolNames?: readonly HostToolNameDeclaration[];
}

export const SMRT_PRESET_DEFAULTS = {
  objectsDir: 'src/lib/objects',
  typesDir: 'src/lib/types/smrt-generated',
  routesDir: 'src/routes/api',
  configPath: 'src/lib/server',
  configFileName: 'smrt.ts',
  exclude: ['**/*.test.ts', '**/*.spec.ts'],
} as const;

function validatePackages(value: unknown, source: string): string[] {
  if (
    !Array.isArray(value) ||
    value.some((p) => typeof p !== 'string' || p.trim() === '')
  ) {
    throw new Error(
      `[smrt] ${source} must be an array of non-empty package names, got ${JSON.stringify(value)}.`,
    );
  }
  return [...new Set(value.map((p: string) => p.trim()))];
}

/** Resolve the declared consumer package list: option first, then smrt.config. */
async function resolvePackages(
  options: SmrtPresetOptions,
  searchFrom: string,
): Promise<string[]> {
  if (options.packages !== undefined) {
    return validatePackages(options.packages, 'smrt({ packages })');
  }

  let declared: unknown;
  try {
    const { loadConfig } = await import('@happyvertical/smrt-config');
    const config = await loadConfig({ cache: false, searchFrom });
    declared = config.consumer?.packages;
  } catch (error) {
    throw new Error(
      `[smrt] Could not read smrt.config to resolve consumer packages: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (declared === undefined) {
    throw new Error(
      '[smrt] No consumer package list declared. Set `consumer: { packages: [...] }` in smrt.config.ts ' +
        '(use [] when the app consumes no SMRT packages) or pass `smrt({ packages })`. ' +
        'The list is explicit so runtime registration is deterministic; it is never inferred from package.json.',
    );
  }
  return validatePackages(declared, 'smrt.config `consumer.packages`');
}

function decoratorPlugin(): SmrtVitePlugin {
  return {
    name: 'smrt:decorators',
    // Vite merges a hook's result over the user config, so fill only the
    // values the app has not set itself.
    config(user: SmrtUserConfig) {
      const decorator = user.oxc ? user.oxc.decorator : undefined;
      const fill: SmrtDecoratorConfig = {};
      if (decorator?.legacy === undefined) fill.legacy = true;
      if (decorator?.emitDecoratorMetadata === undefined) {
        fill.emitDecoratorMetadata = true;
      }
      return Object.keys(fill).length
        ? { oxc: { decorator: fill } }
        : undefined;
    },
  };
}

/**
 * Packages SMRT's SvelteKit entries share with the app by identity. SvelteKit
 * recognizes `redirect()`/`fail()` results by class, so a server entry such as
 * `@happyvertical/smrt-app-runtime/sveltekit` must import the app's own copy.
 * Deduping selects the app peer for linked/workspace packages. The runtime
 * must also enter the SSR bundle: adapter-node bundles Kit itself, so leaving
 * runtime external would import a second Kit class through Node even when
 * both resolve to the same installed version.
 */
export const SMRT_SHARED_RUNTIME_PACKAGES = ['@sveltejs/kit'] as const;

function sharedRuntimePlugin(): SmrtVitePlugin {
  let isBuild = false;
  return {
    name: 'smrt:shared-runtime',
    enforce: 'pre',
    resolveId(id, _importer, options) {
      // ssr.external on the package root would externalize every subpath.
      // Keep only this exact entry external, preserving native dependencies.
      if (isBuild && options.ssr && id === '@happyvertical/smrt-app-runtime') {
        return { id, external: true };
      }
    },
    config(_user, { command }) {
      // Only adapter builds need this split. Dev import analysis ignores a
      // resolver's external flag, so it must retain normal externalization.
      isBuild = command === 'build';
      return {
        resolve: { dedupe: [...SMRT_SHARED_RUNTIME_PACKAGES] },
        ...(isBuild
          ? {
              ssr: {
                noExternal: ['@happyvertical/smrt-app-runtime'],
                external: ['@happyvertical/smrt-app-runtime/sveltekit-runtime'],
              },
            }
          : {}),
      };
    },
  };
}

/**
 * SMRT Vite preset: decorators, dependency manifests, and app object
 * generation in one entry. Returns a promise because the package list is read
 * from `smrt.config.ts`; Vite accepts promised plugins.
 */
export async function smrt(
  options: SmrtPresetOptions = {},
): Promise<SmrtVitePlugin<unknown>[]> {
  const D = SMRT_PRESET_DEFAULTS;
  const objectsDir = options.objectsDir ?? D.objectsDir;
  const typesDir = options.typesDir ?? D.typesDir;
  const routesDir = options.routesDir ?? D.routesDir;
  const configPath = options.configPath ?? D.configPath;
  const configFileName = options.configFileName ?? D.configFileName;
  const rootOption = options.projectRoot
    ? { projectRoot: options.projectRoot }
    : {};

  const packages = await resolvePackages(
    options,
    options.projectRoot ?? process.cwd(),
  );

  const plugins: SmrtVitePlugin<unknown>[] = [];
  if (options.decorators !== false) plugins.push(decoratorPlugin());
  plugins.push(sharedRuntimePlugin());
  // smrtConsumer must precede smrtPlugin, as in the template's hand-written form.
  // With no declared packages there is nothing to consume, and an empty list
  // would otherwise trigger dependency discovery.
  if (packages.length > 0) {
    const hosted = options.expose
      ? validatePackages(options.expose, 'smrt({ expose })')
      : resolveCookbookHostedObjects(
          options.projectRoot ?? process.cwd(),
          packages,
        );
    plugins.push(
      smrtConsumer({
        ...rootOption,
        packages,
        generateTypes: true,
        typesDir,
        svelteKit:
          hosted.length > 0
            ? {
                objects: hosted,
                routesDir,
                objectsDir,
                configPath,
                configFileName,
              }
            : true,
      }),
    );
  }
  const pluginOptions: SmrtPluginOptions = {
    ...rootOption,
    include: options.include ?? [`${objectsDir}/**/*.ts`],
    exclude: options.exclude ?? [...D.exclude],
    generateTypes: true,
    typeDeclarationsPath: typesDir,
    svelteKit: {
      enabled: true,
      routesDir,
      objectsDir,
      configPath,
      configFileName,
    },
  };
  if (options.hostToolNames)
    pluginOptions.hostToolNames = options.hostToolNames;
  plugins.push(smrtPlugin(pluginOptions));
  return plugins;
}
