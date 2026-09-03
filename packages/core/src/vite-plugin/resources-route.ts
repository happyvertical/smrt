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
 * So this route uses a **resolvable-dependency check**: does
 * `node_modules/@happyvertical/smrt-users/package.json` exist under the
 * consumer's `projectRoot`? That is the strongest available signal (stronger
 * than reading `package.json`'s `dependencies` block, which can list a
 * package that was never installed) that the emitted import will actually
 * resolve at build time, and it costs one `existsSync` — no dependency
 * graph walk, no `require.resolve` machinery, no risk of resolving a
 * hoisted transitive copy that happens to be present but isn't what the
 * consumer's own build would see. It also mirrors the pattern the
 * `sveltekit-generator.runtime.test.ts` shims already use to make a real
 * `@happyvertical/smrt-tenancy` resolvable for its esbuild-and-execute
 * assertions.
 *
 * An explicit `sveltekit: { resourcesRoute: { enabled: false } }` escape
 * hatch is also available, matching `changesRoute`/`eventsRoute`, for a
 * consumer that has `smrt-users` installed but wants to keep hand-writing
 * (or omit) `_resources`.
 *
 * ## Preserving a hand-written route
 *
 * Every consumer today hand-writes this route (the reference implementation
 * in the issue). `clearGeneratedRouteFiles` (in `sveltekit-generator.ts`)
 * already only deletes `+server.ts` files that start with
 * {@link AUTO_GENERATED_ROUTE_HEADER}, so a hand-written `_resources` route —
 * which never carries that header — survives the pre-generation sweep
 * untouched. This emitter additionally checks `existsSync` on the target
 * path before writing: by the time it runs, anything still there is
 * necessarily hand-written (a generator-owned copy would already have been
 * swept), so its mere presence is sufficient to skip generation and leave it
 * alone.
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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

/**
 * Whether `@happyvertical/smrt-users` is resolvable from the consumer at
 * `projectRoot`. See the module doc for why this check (rather than reading
 * `package.json`'s declared `dependencies`) is the chosen signal.
 */
export function consumerHasSmrtUsers(projectRoot: string): boolean {
  return existsSync(
    join(
      projectRoot,
      'node_modules',
      '@happyvertical',
      'smrt-users',
      'package.json',
    ),
  );
}

/**
 * Generate the `_resources/+server.ts` route. Returns true when a route was
 * written. Disabled with `sveltekit: { resourcesRoute: { enabled: false } }`;
 * skipped (with a log line) when `@happyvertical/smrt-users` is not
 * resolvable from the consumer, or when a hand-written route already
 * occupies the path.
 */
export function generateResourcesRoute(
  projectRoot: string,
  options: SvelteKitOptions,
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
  const filePath = join(routeDir, '+server.ts');

  // By this point in generation, clearGeneratedRouteFiles has already swept
  // any previously generator-owned copy at this path — anything still here
  // is necessarily hand-written. Preserve it rather than clobbering a
  // consumer's customized discovery route.
  if (existsSync(filePath)) {
    console.log(
      '[smrt] Preserving hand-written _resources route (not generator-owned)',
    );
    return false;
  }

  if (!existsSync(routeDir)) {
    mkdirSync(routeDir, { recursive: true });
  }
  writeFileSync(filePath, generateResourcesRouteTemplate(options), 'utf-8');
  console.log(`[smrt] Generated: ${filePath}`);
  return true;
}

function generateResourcesRouteTemplate(options: SvelteKitOptions): string {
  const kebabRoutesOption = options.kebabRoutes ? '\n  kebabRoutes: true,' : '';

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten
//
// GET /_resources — CLI discovery endpoint (#2663). Returns the auth-aware
// list of resources and commands the distributable CLI
// (@happyvertical/smrt-app-cli) can invoke, derived from ObjectRegistry by
// createResourceListHandler. Subsumes the route every consumer previously
// hand-wrote (see the issue for the reference implementation this replaces).

import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';
// Side effect: registers @smrt() classes in ObjectRegistry before the
// handler walks it (mirrors the generated CRUD/changes/events routes'
// $lib/server/smrt import).
import '$lib/server/smrt';

export const GET = createResourceListHandler({
  ensureRegistry: async () => {
    await import('$lib/server/smrt');
  },${kebabRoutesOption}
});
`;
}
