/**
 * SvelteKit `_resources` route generation — CLI discovery endpoint (#2663;
 * parent epic #2655).
 *
 * Emits `{routesDir}/_resources/+server.ts`: `GET /api/_resources`, the
 * endpoint the distributable CLI (`@happyvertical/smrt-app-cli`) reads to
 * learn which resources and commands it can invoke. Every other generated
 * route lives in `sveltekit-generator.ts` or a sibling emitter; this one is
 * kept in its own module for the same reason `changes-route.ts` and
 * `events-route.ts` are — a one-line registration hook in the shared
 * generator file.
 *
 * ## The dependency constraint
 *
 * The handler this route delegates to, `createResourceListHandler`, lives in
 * `@happyvertical/smrt-users` — and `smrt-users` depends on `smrt-core`, not
 * the reverse, so core cannot import it directly. That is not a problem for
 * *emitting* the import: the generated file is written into the consumer's
 * own `src/routes/`, where `@happyvertical/smrt-users` resolves through the
 * consumer's own dependency graph, exactly like the `@happyvertical/smrt-tenancy`
 * import `sveltekit-generator.ts`'s `generateTenantContextHelper` already
 * emits into tenant-scoped routes (see the comment above that function). The
 * only question is *when* it is safe to emit — a consumer that never took a
 * dependency on `smrt-users` must never receive a route whose import cannot
 * resolve, or a working build turns red.
 *
 * ## Detection mechanism
 *
 * Unlike the tenancy guard — which reads a semantic signal already present in
 * the manifest (whether any object is `@TenantScoped`, which itself implies
 * the app depends on `smrt-tenancy`) — nothing in the manifest indicates
 * whether a consumer has taken on `smrt-users`. Objects don't declare an
 * auth dependency; the app does, at the package level.
 *
 * So this route uses a **resolvable-dependency check**: does the exact
 * subpath the generated file imports — `@happyvertical/smrt-users/sveltekit`
 * — resolve under ESM import conditions from the consumer's `projectRoot`,
 * anchored to its own `package.json` URL? That is stronger than reading
 * `package.json`'s `dependencies` block (which can list a package that was
 * never installed) and, unlike a single hardcoded
 * `node_modules/@happyvertical/smrt-users/package.json` path, it uses
 * Node's real module resolution — so it also finds the package when a
 * workspace hoists shared dependencies to an ancestor `node_modules` (npm/
 * yarn workspaces, or pnpm with `node-linker=hoisted`) rather than
 * installing them directly under the consumer's own `projectRoot`.
 * Resolving the `/sveltekit` subpath specifically, rather than the
 * package's bare `package.json`, matters too: `smrt-users`'s `exports` map
 * does not list `./package.json`, so resolving that path would throw
 * `ERR_PACKAGE_PATH_NOT_EXPORTED` even when the package is genuinely
 * installed — resolving the subpath the route actually imports sidesteps
 * that and checks precisely the thing that must succeed at build time. Use
 * import conditions because the published subpath may expose only `types` and
 * `import`, without a CommonJS `require` or `default` branch. The ESM resolver
 * can return a URL for a missing file or directory, so verify that the selected
 * target is an existing file before emitting a route that imports it.
 *
 * An explicit `sveltekit: { resourcesRoute: { enabled: false } }` escape
 * hatch is also available, matching `changesRoute`/`eventsRoute`, for a
 * consumer that has `smrt-users` installed but wants to keep hand-writing
 * (or omit) `_resources`.
 *
 * ## Preserving a hand-written route
 *
 * Every consumer today hand-writes this route (the reference implementation
 * in the issue). The generated-route sweep deletes only files the
 * generated-route predicate (`generated-route-files.ts`) accepts, so a
 * hand-written `_resources` route survives it. This route is emitted with
 * the `yield` policy: when it is the only claimant of its path and an
 * application `+server.ts` or `+server.js` occupies it, the preflight leaves
 * that handler alone and nothing is written. A generated handler with lines
 * added above its header is neither, so generation refuses and names it.
 *
 * Once a consumer's `_resources` route IS generator-owned (no hand-written
 * file present, `smrt-users` resolvable), its path is generator-owned for
 * `.gitignore` purposes too — it is included in `generatedRoutePaths` like
 * any other emitted route, so `updateGitignore` puts it in the managed
 * block. A project that migrated from a hand-written route to a fully
 * generated one may still carry a stale `# Application-owned rule` comment
 * above the same literal path from before the migration; `updateGitignore`
 * only ever touches its own managed block, so that stale comment is left as
 * project history for the consumer to clean up — the same way any other
 * manual `.gitignore` edit outside the managed block is preserved.
 */

import { join } from 'node:path';
import { consumerResolvesImport } from './consumer-import.js';
import {
  inspectRouteDirectory,
  type RouteFilePlan,
} from './generated-route-files.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { resolveSvelteKitConfigImport } from './sveltekit-config-import.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

/**
 * Whether `@happyvertical/smrt-users/sveltekit` — the exact subpath the
 * generated route imports — is resolvable from the consumer at
 * `projectRoot`. See the module doc for why this check (rather than reading
 * `package.json`'s declared `dependencies`, or checking one hardcoded
 * physical path) is the chosen signal.
 */
export function consumerHasSmrtUsers(projectRoot: string): boolean {
  return consumerResolvesImport(
    projectRoot,
    '@happyvertical/smrt-users/sveltekit',
  );
}

/** Whether this invocation will own the `_resources` output file. */
export function willGenerateResourcesRoute(
  projectRoot: string,
  options: SvelteKitOptions,
): boolean {
  if (
    options.resourcesRoute?.enabled === false ||
    !consumerHasSmrtUsers(projectRoot)
  ) {
    return false;
  }
  return !resourcesRouteOccupied(projectRoot, options);
}

/** Whether an application file (or an uninspectable entry) holds `_resources`. */
function resourcesRouteOccupied(
  projectRoot: string,
  options: SvelteKitOptions,
): boolean {
  const routesRoot = join(projectRoot, options.routesDir);
  const inspection = inspectRouteDirectory(
    routesRoot,
    join(routesRoot, '_resources'),
  );
  return inspection.application.length > 0 || inspection.blocking.length > 0;
}

/** Whether `_resources` is occupied by its generated utility or a preserved
 * handwritten SvelteKit server module. This is used only by route collision
 * preflight: the emitter remains file-aware and never overwrites handwriting. */
export function reservesResourcesRoute(
  projectRoot: string,
  options: SvelteKitOptions,
): boolean {
  if (willGenerateResourcesRoute(projectRoot, options)) return true;
  return resourcesRouteOccupied(projectRoot, options);
}

/**
 * Plan the `_resources/+server.ts` route. Returns true when a route was
 * emitted into `plan`. Disabled with `sveltekit: { resourcesRoute: { enabled:
 * false } }`; skipped (with a log line) when `@happyvertical/smrt-users` is
 * not resolvable from the consumer. The route is a fallback: it is emitted
 * only when no other route claims its path, and it yields to a hand-written
 * handler (see the module doc).
 */
export function generateResourcesRoute(
  projectRoot: string,
  options: SvelteKitOptions,
  plan: RouteFilePlan,
): boolean {
  if (options.resourcesRoute?.enabled === false) {
    return false;
  }

  if (!consumerHasSmrtUsers(projectRoot)) {
    console.log(
      '[smrt] Skipping _resources route - @happyvertical/smrt-users is not ' +
        'resolvable; createResourceListHandler would not resolve in the ' +
        'consumer build',
    );
    return false;
  }

  const routeDir = join(projectRoot, options.routesDir, '_resources');
  // A fallback: an earlier route at this path (a model whose collection is
  // `_resources`) keeps its content.
  if (plan.claims(routeDir)) return false;

  // The preflight preserves a hand-written handler, `+server.ts` or
  // `+server.js` (both server-module extensions SvelteKit resolves by default,
  // https://svelte.dev/docs/kit/configuration#moduleExtensions), rather than
  // clobbering a consumer's customized discovery route or writing a second
  // endpoint beside it.
  plan.emit({
    root: join(projectRoot, options.routesDir),
    routeDir,
    content: generateResourcesRouteTemplate(
      resolveSvelteKitConfigImport(projectRoot, routeDir, options),
      resolveSvelteKitConfigImport(projectRoot, routeDir, {
        configPath: options.configPath,
        configFileName: 'smrt-register.ts',
      }),
      options,
    ),
    label: '_resources',
    policy: 'yield',
    onYield: (file) =>
      console.log(
        `[smrt] Preserving hand-written _resources route (${file}, not generator-owned)`,
      ),
  });
  return true;
}

function generateResourcesRouteTemplate(
  configImport: string,
  registerImport: string,
  options: SvelteKitOptions,
): string {
  const kebabRoutesOption = options.kebabRoutes ? '\n  kebabRoutes: true,' : '';

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten
//
// GET /api/_resources — CLI discovery endpoint (#2663). Returns the auth-aware
// list of resources and commands the distributable CLI
// (@happyvertical/smrt-app-cli) can invoke, derived from ObjectRegistry by
// createResourceListHandler. Subsumes the route every consumer previously
// hand-wrote (see the issue for the reference implementation this replaces).

import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';
// Side effect: registers @smrt() classes in ObjectRegistry before the
// handler walks it (the generated registration, then the app's SMRT config
// module, as the CRUD/changes/events routes import them).
import '${registerImport}';
import '${configImport}';

export const GET = createResourceListHandler({
  ensureRegistry: async () => {
    await import('${registerImport}');
    await import('${configImport}');
  },${kebabRoutesOption}
});
`;
}
