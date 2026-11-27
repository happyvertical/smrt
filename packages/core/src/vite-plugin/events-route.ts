/**
 * SvelteKit `_events` route generation — live change signals (issue #1763,
 * SERVER half; parent PRD #1755).
 *
 * Emits `{routesDir}/_events/+server.ts` — an auth-guarded, tenant-scoped
 * Server-Sent-Events endpoint that streams coarse change signals (no row
 * payloads). It is the push companion to the generated `_changes` route
 * (#1758). Kept in its own module so `sveltekit-generator.ts` only carries a
 * one-line registration.
 *
 * The stream lifecycle (subscribe, catch-up, heartbeat, teardown) lives in
 * core's `buildChangeEventStream`, imported by the generated file — so the
 * emitted route stays THIN and the stream logic is written and tested once.
 *
 * Design notes (mirror `changes-route.ts`):
 * - **Fail-closed auth** (#1540 posture): the handler requires an authenticated
 *   principal on `locals`, decided by the shared `authorize` (`route-authz.ts`,
 *   #5195) exactly as REST decides it for `_events`: a model-less `_feed`
 *   collection that opens nothing, so the answer is 401
 *   `AUTHENTICATION_REQUIRED`. The signal stream spans every table, so
 *   per-model `api: { public }` opt-outs deliberately do not apply.
 * - **CORS** (#1861, #5195): through the shared policy (`generators/cors.ts`)
 *   by `applyRouteCors`, like every other generated route, so `Vary: Origin`,
 *   the preflight and the headers on a 401 match REST's `_events`.
 * - **Tenant scoping**: when the project has tenant-scoped objects, the route
 *   establishes tenant context from `locals` exactly like the `_changes` route,
 *   then captures the resolved scope ONCE at connection open and passes it to
 *   the stream (delivery filters against that fixed value — it cannot
 *   re-resolve per signal outside the request's ALS context).
 * - **Table/row authorization** (#3020): `locals` is forwarded to
 *   `buildChangeEventStream`, which — if the consumer registered
 *   `authorizeChangeFeed`/`isChangeFeedEntryVisible`
 *   (`@happyvertical/smrt-core`'s `change-feed-authz.ts`) — resolves the
 *   allowed tables ONCE at connection open (same reasoning as tenant scope)
 *   and applies both hooks to catch-up replay AND every live signal before it
 *   is enqueued. Unregistered, behavior is unchanged from pre-#3020.
 * - **Database resolution**: anchors on the project's first generated
 *   collection (alphabetical) via `getCollection()`, exactly as `_changes`.
 * - Cleanup rides the generated-route sweep: the file starts with
 *   {@link AUTO_GENERATED_ROUTE_HEADER}.
 */

import { join } from 'node:path';
import type { SmartObjectManifest } from '../scanner/types';
import {
  manifestHasTenantScopedObject,
  resolveAnchorClassName,
} from './changes-route.js';
import type { RouteFilePlan } from './generated-route-files.js';
import { applyRouteCors, type SvelteKitCorsOptions } from './route-cors.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import { applyRouteMetering } from './route-metering.js';
import { generateCollectionAccessImports } from './sveltekit-config-import.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

/**
 * Plan the `_events/+server.ts` route. Returns true when a route was emitted
 * into `plan`. Disabled with `sveltekit: { eventsRoute: { enabled: false } }`;
 * skipped (with a log line) when the manifest has no objects to anchor on.
 */
export function generateEventsRoute(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
  plan: RouteFilePlan,
  webManifestHash?: string,
): boolean {
  if (options.eventsRoute?.enabled === false) {
    return false;
  }

  const anchorClassName = resolveAnchorClassName(manifest);
  if (!anchorClassName) {
    console.log(
      '[smrt] Skipping _events route - no SMRT objects to anchor the database on',
    );
    return false;
  }

  // `eventsRoute.allowedOrigins` wins for `_events` when it is set, an empty
  // list included (it opts the stream out of `sveltekit.cors`); without one the
  // route inherits the shared `cors` allow-list (#5195).
  const own = options.eventsRoute?.allowedOrigins;
  const eventsCors: SvelteKitCorsOptions | undefined = Array.isArray(own)
    ? {
        allowedOrigins: own,
        allowCredentials: options.eventsRoute?.allowCredentials === true,
      }
    : options.cors;
  const routeDir = join(projectRoot, options.routesDir, '_events');
  const content = generateEventsRouteTemplate(
    anchorClassName,
    manifestHasTenantScopedObject(manifest),
    webManifestHash,
    options.eventsRoute?.maxSubscribers,
    generateCollectionAccessImports(projectRoot, routeDir, options, [
      'getCollection',
    ]),
  );

  plan.emit({
    root: join(projectRoot, options.routesDir),
    routeDir,
    content: applyRouteCors(applyRouteMetering(content), eventsCors),
    label: '_events',
  });
  return true;
}

function generateEventsRouteTemplate(
  anchorClassName: string,
  tenantScoped: boolean,
  manifestHash: string | undefined,
  maxSubscribers: number | undefined,
  collectionAccessImports: string,
): string {
  const configuredMaxSubscribers =
    maxSubscribers !== undefined &&
    Number.isFinite(maxSubscribers) &&
    maxSubscribers >= 0
      ? Math.floor(maxSubscribers)
      : undefined;
  const maxSubscribersArg =
    configuredMaxSubscribers === undefined
      ? ''
      : `, ${JSON.stringify(configuredMaxSubscribers)}`;
  const manifestHashLiteral =
    manifestHash === undefined ? 'undefined' : JSON.stringify(manifestHash);
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
// GET /_events — Server-Sent-Events stream of coarse change signals (#1763).
// Part of the client/mobile sync contract: each event names {table, operation,
// rowId, tenantId} (NEVER a row payload — authorization stays on the read path)
// and carries a seq cursor in the SSE id: field. A reconnecting EventSource
// resends Last-Event-ID; the route replays missed changes from it, then streams
// live. Same-origin only unless an origin allowlist is configured (#1861,
// #5195): the CORS wrapper is added around this file by \`applyRouteCors\`.

import { error } from '@sveltejs/kit';
import {
  apiPrincipalFromLocals,
  authorize,
  buildChangeEventStream,
  enforceRouteLimits,
  eventStreamCapacityExceededResponse,
  getRequestTenantContext,
  resolveDispatchTenantScope,
  tryReserveChangeEventSubscriberSlot,
} from '@happyvertical/smrt-core';
import type { RequestHandler } from './$types';
${collectionAccessImports}

const MANIFEST_HASH = ${manifestHashLiteral};

// Fail-closed authorization (#1540, #5195): the signal stream spans every
// table, so it is never public. The shared decision REST makes for \`_events\`
// is asked for the principal of \`locals\`: sign-in alone, on a collection that
// opens nothing (401 AUTHENTICATION_REQUIRED).
function requireRouteAuth(locals: unknown): void {
  const decision = authorize({
    principal: apiPrincipalFromLocals(locals),
    op: 'read',
    permissionCollection: '_feed',
    publicAccess: false,
  });
  if (!decision.allow) {
    // A variable, not a literal: SvelteKit types the body of error() as
    // App.Error, which has no code, and only a literal is checked for it.
    const body: { message: string; code: string } = {
      message: decision.message,
      code: decision.code,
    };
    throw error(decision.status, body);
  }
}

// Last-Event-ID (auto-reconnect) takes precedence over ?since=; default is
// live-forward only (no catch-up replay).
function parseCursor(request: Request, url: URL): number | null {
  const lastEventId = request.headers.get('Last-Event-ID');
  if (lastEventId !== null && lastEventId.trim() !== '') {
    const n = Number(lastEventId);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const since = url.searchParams.get('since');
  if (since !== null && since.trim() !== '') {
    const n = Number(since);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  return null;
}
${tenantHelper}
// Route limits (#5198), as REST applies them before \`onRequest\`.
function routeRateLimit(locals: unknown, request: Request, clientAddress: () => string): Response | undefined {
  const active = (getRequestTenantContext() as { tenantId?: unknown } | undefined)?.tenantId;
  const principal = apiPrincipalFromLocals(locals, typeof active === 'string' && active ? active : null);
  let address: string | null = null;
  try { address = clientAddress(); } catch { /* no peer address: the limiter falls back */ }
  return enforceRouteLimits({
    request,
    clientAddress: address,
    tenantId: principal.tenantId,
    userId: principal.userId ?? null,
    callerKind: principal.callerKind ?? null,
  });
}

export const GET: RequestHandler = async ({ locals, url, request, getClientAddress }) => {
  const limited = routeRateLimit(locals, request, getClientAddress);
  if (limited) return limited;
  requireRouteAuth(locals);${tenantCall}

  const cursor = parseCursor(request, url);
  // Capture the tenant scope ONCE at connection open — signal delivery runs
  // outside this request's tenant context and must filter against a fixed
  // value, not a per-signal re-resolution. resolveDispatchTenantScope() reads
  // the context established above (fail-closed: tenancy on + no tenant → global
  // rows only; tenancy off → unenforced, all rows).
  const tenantScope = resolveDispatchTenantScope();

  // The feed lives in the project's database; anchor on the
  // ${anchorClassName} collection to reuse its configured connection.
  const collection = await getCollection('${anchorClassName}');
  const releaseSubscriberSlot = tryReserveChangeEventSubscriberSlot(collection.db${maxSubscribersArg});
  if (!releaseSubscriberSlot) {
    return eventStreamCapacityExceededResponse();
  }
  return new Response(
    buildChangeEventStream(collection.db, {
      cursor,
      tenantScope,
      manifestHash: MANIFEST_HASH,
      releaseSubscriberSlot,
      locals,
      request,
    }),
    {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
};
`;
}
