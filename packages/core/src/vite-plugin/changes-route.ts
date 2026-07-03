/**
 * SvelteKit `_changes` route generation for the change feed (issue #1758).
 *
 * Emits `{routesDir}/_changes/+server.ts` — an auth-guarded, tenant-scoped
 * GET endpoint over the `_smrt_changes` log, part of the client/mobile sync
 * contract (PRD #1755). Kept in its own module so `sveltekit-generator.ts`
 * only carries a one-line registration.
 *
 * Design notes:
 * - **Fail-closed auth** (#1540 posture): the handler requires an
 *   authenticated principal on `locals`. The feed spans every table, so
 *   per-model `api: { public }` opt-outs deliberately do not apply.
 * - **Tenant scoping**: when the project has tenant-scoped objects, the
 *   route establishes tenant context from `locals` exactly like generated
 *   collection routes, then reads through
 *   `getTenantScopedChangesSince()` — a tenant only ever sees its own
 *   changes plus global rows.
 * - **Database resolution**: the route anchors on the project's first
 *   generated collection (alphabetical) via the consumer's existing
 *   `getCollection()` helper, inheriting its configuration, request-scoped
 *   database support and system-table bootstrap. Multi-database projects
 *   (per-object `db` overrides) see the anchor collection's feed.
 * - Cleanup rides the existing generated-route sweep: the emitted file
 *   starts with {@link AUTO_GENERATED_ROUTE_HEADER}.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  SmartObjectDefinition,
  SmartObjectManifest,
} from '../scanner/types';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

/**
 * Mirrors `isCollectionClass` in `sveltekit-generator.ts` (module-private
 * there): collection classes share route paths with their item class and
 * never anchor routes themselves.
 */
function isCollectionDefinition(objectDef: SmartObjectDefinition): boolean {
  return objectDef.extends === 'SmrtCollection' || !!objectDef.extendsTypeArg;
}

/**
 * Pick the class the route resolves its database through: the first
 * non-collection object by sorted manifest key, for determinism across
 * builds.
 *
 * Returns the manifest **registry key** verbatim (which may be
 * package-qualified, e.g. `@happyvertical/smrt-ledgers:Account`) — the emitted
 * route passes it straight to `getCollection()`, exactly as the generated CRUD
 * routes do. Collapsing it to a simple class name would resolve ambiguously
 * when two loaded packages declare the same simple name (mirrors the #1778
 * verbatim-key fix and the sync-apply route's `registryKey`).
 */
function resolveAnchorClassName(manifest: SmartObjectManifest): string | null {
  const sortedNames = Object.keys(manifest.objects).sort();
  for (const name of sortedNames) {
    const def = manifest.objects[name];
    if (def && !isCollectionDefinition(def)) {
      return name;
    }
  }
  return null;
}

function manifestHasTenantScopedObject(manifest: SmartObjectManifest): boolean {
  return Object.values(manifest.objects).some(
    (def) =>
      !isCollectionDefinition(def) && !!def.decoratorConfig?.tenantScoped,
  );
}

/**
 * Generate the `_changes/+server.ts` route. Returns true when a route was
 * written. Disabled with `sveltekit: { changesRoute: { enabled: false } }`;
 * skipped (with a log line) when the manifest has no objects to anchor the
 * database on.
 */
export function generateChangesRoute(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
): boolean {
  if (options.changesRoute?.enabled === false) {
    return false;
  }

  const anchorClassName = resolveAnchorClassName(manifest);
  if (!anchorClassName) {
    console.log(
      '[smrt] Skipping _changes route - no SMRT objects to anchor the database on',
    );
    return false;
  }

  const routeDir = join(projectRoot, options.routesDir, '_changes');
  const content = generateChangesRouteTemplate(
    anchorClassName,
    manifestHasTenantScopedObject(manifest),
  );

  if (!existsSync(routeDir)) {
    mkdirSync(routeDir, { recursive: true });
  }
  const filePath = join(routeDir, '+server.ts');
  writeFileSync(filePath, content, 'utf-8');
  console.log(`[smrt] Generated: ${filePath}`);
  return true;
}

function generateChangesRouteTemplate(
  anchorClassName: string,
  tenantScoped: boolean,
): string {
  const tenantHelper = tenantScoped
    ? `
import { enterTenantContext, hasTenantContext } from '@happyvertical/smrt-tenancy';

function establishTenantContext(locals: unknown): void {
  if (hasTenantContext()) return;
  if (!locals || typeof locals !== 'object') return;
  const l = locals as Record<string, unknown>;
  const user = l.user as Record<string, unknown> | undefined;
  const session = l.session as Record<string, unknown> | undefined;
  const tenantId = l.tenantId ?? user?.tenantId ?? session?.tenantId;
  if (typeof tenantId === 'string' && tenantId) {
    enterTenantContext({ tenantId });
  }
}
`
    : '';
  const tenantCall = tenantScoped ? '\n  establishTenantContext(locals);' : '';

  return `${AUTO_GENERATED_ROUTE_HEADER}
// DO NOT EDIT - changes will be overwritten
//
// GET /_changes — cursor read over the _smrt_changes change feed (#1758).
// Part of the client/mobile sync contract: poll with the returned cursor to
// observe every committed framework save/delete (deletes are tombstones)
// exactly once. Query params: since (cursor, default 0), tables
// (comma-separated), limit. A response with resyncRequired: true (still
// HTTP 200 — protocol state, not an error) means the cursor cannot be
// served incrementally (pruned or foreign) and the client must re-fetch
// in full before resuming polling.

import { error, json } from '@sveltejs/kit';
import { getTenantScopedChangesSince } from '@happyvertical/smrt-core';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

// Fail-closed authorization (#1540): the change feed spans every table, so
// it is never public — an authenticated principal on \`locals\` is required.
function hasAuthenticatedPrincipal(locals: unknown): boolean {
  if (!locals || typeof locals !== 'object') return false;
  const l = locals as Record<string, unknown>;
  const isResolvedPrincipal = (v: unknown) =>
    typeof v === 'object' && v !== null;
  return (
    isResolvedPrincipal(l.user) ||
    isResolvedPrincipal(l.session) ||
    l.smrtAuth === true
  );
}

function requireRouteAuth(locals: unknown): void {
  if (!hasAuthenticatedPrincipal(locals)) {
    throw error(401, 'Authentication required');
  }
}
${tenantHelper}
export const GET: RequestHandler = async ({ locals, url }) => {
  requireRouteAuth(locals);${tenantCall}

  const since = Number(url.searchParams.get('since') ?? '0');
  if (!Number.isFinite(since) || since < 0) {
    throw error(400, "'since' must be a non-negative number");
  }

  let limit: number | undefined;
  const limitParam = url.searchParams.get('limit');
  if (limitParam !== null) {
    limit = Number(limitParam);
    if (!Number.isFinite(limit) || limit < 1) {
      throw error(400, "'limit' must be a positive number");
    }
  }

  const tablesParam = url.searchParams.get('tables');
  const tables = tablesParam
    ? tablesParam
        .split(',')
        .map((table) => table.trim())
        .filter(Boolean)
    : undefined;

  // The feed lives in the project's database; anchor on the
  // ${anchorClassName} collection to reuse its configured connection.
  const collection = await getCollection('${anchorClassName}');
  const page = await getTenantScopedChangesSince(collection.db, {
    since,
    tables,
    limit,
  });
  return json(page);
};
`;
}
