/**
 * Single-plugin Vite preset for SMRT applications.
 *
 * `plugins: [sveltekit(), smrt()]` replaces the hand-copied glue every app
 * carried: the Oxc legacy-decorator block, `smrtConsumer({...})` with an
 * explicit package list, and `smrtPlugin({...})` with the SvelteKit path
 * options. `smrtConsumer` and `smrtPlugin` stay public and unchanged.
 */
import type { Plugin, UserConfig } from 'vite';
import { smrtConsumer } from '../consumer-plugin/index.js';
import { type SmrtPluginOptions, smrtPlugin } from '../vite-plugin/index.js';

export interface SmrtPresetOptions {
  /**
   * SMRT packages whose object manifests this app consumes. Takes precedence
   * over `consumer.packages` in `smrt.config.ts`. An empty array declares that
   * the app consumes none. Tooling/UI packages must not be listed.
   */
  packages?: readonly string[];
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

function decoratorPlugin(): Plugin {
  return {
    name: 'smrt:decorators',
    // Vite merges a hook's result over the user config, so fill only the
    // values the app has not set itself.
    config(user: UserConfig) {
      const decorator = (
        user as { oxc?: { decorator?: Record<string, unknown> } }
      ).oxc?.decorator;
      const fill: Record<string, boolean> = {};
      if (decorator?.legacy === undefined) fill.legacy = true;
      if (decorator?.emitDecoratorMetadata === undefined) {
        fill.emitDecoratorMetadata = true;
      }
      return Object.keys(fill).length
        ? ({ oxc: { decorator: fill } } as UserConfig)
        : undefined;
    },
  };
}

/**
 * SMRT Vite preset: decorators, dependency manifests, and app object
 * generation in one entry. Returns a promise because the package list is read
 * from `smrt.config.ts`; Vite accepts promised plugins.
 */
export async function smrt(options: SmrtPresetOptions = {}): Promise<Plugin[]> {
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

  const plugins: Plugin[] = [];
  if (options.decorators !== false) plugins.push(decoratorPlugin());
  // smrtConsumer must precede smrtPlugin, as in the template's hand-written form.
  // With no declared packages there is nothing to consume, and an empty list
  // would otherwise trigger dependency discovery.
  if (packages.length > 0) {
    plugins.push(
      smrtConsumer({
        ...rootOption,
        packages,
        generateTypes: true,
        typesDir,
        svelteKit: true,
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
  plugins.push(smrtPlugin(pluginOptions));
  return plugins;
}
