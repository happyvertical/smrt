/**
 * Ownership of generated SvelteKit route files.
 *
 * A route file belongs to the generator only when it is a `+server.ts` that
 * starts with {@link AUTO_GENERATED_ROUTE_HEADER}. Cleanup removes exactly
 * those files, so every other server module in a route directory (a `.ts`
 * without the header, or any `+server.js`, which the generator never writes)
 * is application code. Every route writer checks this one rule before it
 * writes, and generation checks every destination before it sweeps, so
 * generation never replaces application code and never leaves a generated
 * `+server.ts` beside an application `+server.js` (SvelteKit rejects a route
 * with two endpoint files).
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { canonicalSvelteKitPath } from './sveltekit-path.js';

/** Server-module file names SvelteKit resolves by default. */
export const SVELTEKIT_SERVER_MODULE_NAMES = ['+server.ts', '+server.js'];

/**
 * The application-owned server module in `routeDir`, if any: a `+server.ts`
 * without the generated-route header, or a `+server.js`.
 */
export function findApplicationServerModule(
  routeDir: string,
): string | undefined {
  for (const name of SVELTEKIT_SERVER_MODULE_NAMES) {
    const file = join(routeDir, name);
    if (!existsSync(file)) continue;
    if (name !== '+server.ts') return file;
    if (!readFileSync(file, 'utf-8').startsWith(AUTO_GENERATED_ROUTE_HEADER)) {
      return file;
    }
  }
  return undefined;
}

/** Error raised when application code occupies a path the generator needs. */
export class ApplicationRouteConflictError extends Error {
  constructor(
    readonly file: string,
    readonly route: string,
    options?: { cause?: unknown },
  ) {
    super(
      `[smrt] Cannot generate ${route}: ${file} is application code (it does ` +
        `not start with "${AUTO_GENERATED_ROUTE_HEADER}"), and generation ` +
        'never overwrites or shadows it. Move or rename that file, or stop ' +
        'generating this route (for example `api: false`, `api.exclude`, or ' +
        "the route's `enabled: false` option).",
      options,
    );
    this.name = 'ApplicationRouteConflictError';
  }
}

/** Throw unless `routeDir` holds no application-owned server module. */
export function assertGeneratedRouteDestination(
  routeDir: string,
  route: string,
): void {
  const file = findApplicationServerModule(routeDir);
  if (file) throw new ApplicationRouteConflictError(file, route);
}

/**
 * Write `routeDir/+server.ts` after checking ownership. The content must
 * start with the generated-route header so cleanup can reclaim it.
 *
 * @returns The written file path.
 */
export function writeGeneratedRouteFile(
  routeDir: string,
  content: string,
  route: string,
): string {
  if (!content.startsWith(AUTO_GENERATED_ROUTE_HEADER)) {
    throw new Error(
      `[smrt] Generated route content for ${route} must start with the generated-route header`,
    );
  }
  assertGeneratedRouteDestination(routeDir, route);
  mkdirSync(routeDir, { recursive: true });
  const file = join(routeDir, '+server.ts');
  writeFileSync(file, content, 'utf-8');
  return file;
}

/**
 * Every application-owned server module below `routesRoot`, keyed by the
 * canonical path of the `+server.ts` a generator would write in its
 * directory. Directory symlinks are followed once, as route cleanup does.
 */
export function collectApplicationServerModules(
  routesRoot: string,
  protectedRouteRoots: ReadonlySet<string> = new Set(),
): Map<string, string> {
  const found = new Map<string, string>();
  const visited = new Set<string>();
  const visit = (dir: string) => {
    const canonical = canonicalSvelteKitPath(dir);
    if (visited.has(canonical) || protectedRouteRoots.has(canonical)) return;
    if (!existsSync(dir)) return;
    visited.add(canonical);
    const application = findApplicationServerModule(dir);
    if (application) {
      found.set(canonicalSvelteKitPath(join(dir, '+server.ts')), application);
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      let isDirectory = entry.isDirectory();
      if (!isDirectory && entry.isSymbolicLink()) {
        try {
          isDirectory = statSync(entryPath).isDirectory();
        } catch {
          isDirectory = false;
        }
      }
      if (isDirectory) visit(entryPath);
    }
  };
  visit(routesRoot);
  return found;
}
