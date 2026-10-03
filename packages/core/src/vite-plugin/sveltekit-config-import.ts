/**
 * Resolve the import specifier for the generated application's SMRT config.
 *
 * SvelteKit maps `src/lib` to `$lib`; preserve that concise public convention
 * where possible. Configurations outside `src/lib` remain supported through a
 * route-relative import so generated server routes do not assume an alias the
 * consumer did not configure.
 */

import { basename, join, relative } from 'node:path';

export interface SvelteKitConfigImportOptions {
  configPath?: string;
  configFileName?: string;
}

// Generated config files have historically imported TypeScript files without
// their `.ts` suffix. Keep every other supplied extension intact: it may carry
// a consumer-selected module format (for example `.mts`).
const TYPESCRIPT_EXTENSION = /\.ts$/i;

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}

function moduleSpecifierPath(fileName: string): string {
  return fileName.replace(TYPESCRIPT_EXTENSION, '');
}

/**
 * Return an extensionless specifier because Vite resolves generated route
 * imports through its source-module resolver. `routeDir` is the absolute
 * directory which will contain the generated `+server.ts` file.
 */
export function resolveSvelteKitConfigImport(
  projectRoot: string,
  routeDir: string,
  options: SvelteKitConfigImportOptions,
): string {
  const configPath = normalizePath(options.configPath || 'src/lib/server');
  const configModule = moduleSpecifierPath(options.configFileName || 'smrt.ts');

  if (configPath === 'src/lib' || configPath.startsWith('src/lib/')) {
    const libPath = configPath.slice('src/lib'.length).replace(/^\//, '');
    return libPath ? `$lib/${libPath}/${configModule}` : `$lib/${configModule}`;
  }

  const configFile = join(projectRoot, configPath, configModule);
  const routeRelative = relative(routeDir, configFile).replace(/\\/g, '/');
  return routeRelative.startsWith('.') ? routeRelative : `./${routeRelative}`;
}

/** Collection accessors a generated route can take from the access prelude. */
export type GeneratedCollectionAccessor = 'getCollection' | 'getSmrtConfig';

/**
 * Import block giving a generated route its collection accessors (#3416).
 *
 * The route imports the generated registration module (written beside the
 * config module in the same generation pass, so it always exists), then
 * resolves `getCollection`/`getSmrtConfig` through
 * `createGeneratedCollectionAccess()` over the application's config module:
 * its exported `runtime` (`runtime.getCollection()`, request-scoped), or a
 * deprecated `getCollection`/`getSmrtConfig` export. The application no longer
 * hand-writes the accessors generated routes need.
 */
export function generateCollectionAccessImports(
  projectRoot: string,
  routeDir: string,
  options: SvelteKitConfigImportOptions,
  accessors: readonly GeneratedCollectionAccessor[],
): string {
  const configImport = resolveSvelteKitConfigImport(
    projectRoot,
    routeDir,
    options,
  );
  const registerImport = resolveSvelteKitConfigImport(projectRoot, routeDir, {
    configPath: options.configPath,
    configFileName: 'smrt-register.ts',
  });
  const source = `${normalizePath(options.configPath || 'src/lib/server')}/${
    options.configFileName || 'smrt.ts'
  }`;
  return [
    `import '${registerImport}';`,
    "import { createGeneratedCollectionAccess } from '@happyvertical/smrt-core';",
    `import * as smrtApplication from '${configImport}';`,
    '',
    `const { ${accessors.join(', ')} } = createGeneratedCollectionAccess(`,
    '  smrtApplication,',
    `  '${source.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}',`,
    ');',
  ].join('\n');
}

/** Base name of the generated registration module beside the config module. */
const REGISTRATION_MODULE_NAME = /^smrt-register(?:\.[cm]?[jt]sx?)?$/i;

/**
 * Fail generation, before anything is written, when the configured config
 * module would resolve to the generated registration module (any script
 * extension or case). Generation overwrites `smrt-register.ts`, and generated
 * routes import the config module as the application's runtime, so such a
 * name would destroy the authored file and leave routes without a runtime.
 */
export function assertSvelteKitConfigModuleNotReserved(
  options: SvelteKitConfigImportOptions,
): void {
  const configFileName = options.configFileName || 'smrt.ts';
  if (REGISTRATION_MODULE_NAME.test(basename(normalizePath(configFileName)))) {
    throw new Error(
      `[smrt] svelteKit.configFileName '${configFileName}' is reserved for the ` +
        'generated registration module (smrt-register.ts). Name the ' +
        "application's SMRT config module something else, for example smrt.ts.",
    );
  }
}
