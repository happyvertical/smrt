/**
 * Resolve the import specifier for the generated application's SMRT config.
 *
 * SvelteKit maps `src/lib` to `$lib`; preserve that concise public convention
 * where possible. Configurations outside `src/lib` remain supported through a
 * route-relative import so generated server routes do not assume an alias the
 * consumer did not configure.
 */

import { join, relative } from 'node:path';

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
