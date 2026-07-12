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
 *   principal on `locals`. The signal stream spans every table, so per-model
 *   `api: { public }` opt-outs deliberately do not apply.
 * - **Tenant scoping**: when the project has tenant-scoped objects, the route
 *   establishes tenant context from `locals` exactly like the `_changes` route,
 *   then captures the resolved scope ONCE at connection open and passes it to
 *   the stream (delivery filters against that fixed value — it cannot
 *   re-resolve per signal outside the request's ALS context).
 * - **Database resolution**: anchors on the project's first generated
 *   collection (alphabetical) via `getCollection()`, exactly as `_changes`.
 * - Cleanup rides the generated-route sweep: the file starts with
 *   {@link AUTO_GENERATED_ROUTE_HEADER}.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SmartObjectManifest } from '../scanner/types';
import {
  manifestHasTenantScopedObject,
  resolveAnchorClassName,
} from './changes-route.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

/**
 * Generate the `_events/+server.ts` route. Returns true when a route was
 * written. Disabled with `sveltekit: { eventsRoute: { enabled: false } }`;
 * skipped (with a log line) when the manifest has no objects to anchor on.
 */
export function generateEventsRoute(
  projectRoot: string,
  manifest: SmartObjectManifest,
  options: SvelteKitOptions,
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

  const routeDir = join(projectRoot, options.routesDir, '_events');
  const content = generateEventsRouteTemplate(
    anchorClassName,
    manifestHasTenantScopedObject(manifest),
    webManifestHash,
    options.eventsRoute?.maxSubscribers,
    normalizeAllowedOrigins(options.eventsRoute?.allowedOrigins),
    options.eventsRoute?.allowCredentials === true,
  );

  if (!existsSync(routeDir)) {
    mkdirSync(routeDir, { recursive: true });
  }
  const filePath = join(routeDir, '+server.ts');
  writeFileSync(filePath, content, 'utf-8');
  console.log(`[smrt] Generated: ${filePath}`);
  return true;
}

/**
 * Trim, de-duplicate, and drop empty entries from a configured origin
 * allowlist. An `undefined`/empty result means "same-origin only" — the
 * generated route emits no CORS surface at all (fail-closed default, #1861).
 */
function normalizeAllowedOrigins(
  origins: string[] | undefined,
): string[] | undefined {
  if (!Array.isArray(origins)) return undefined;
  const cleaned = [
    ...new Set(
      origins
        .filter((o): o is string => typeof o === 'string')
        .map((o) => o.trim())
        .filter((o) => o.length > 0),
    ),
  ];
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Build the CORS fragments injected into the generated `_events` route (#1861)
 * when an origin allowlist is configured. Mirrors the runtime REST generator's
 * posture: the request `Origin` is echoed only when it is on the allowlist
 * (never `*`), `Vary: Origin` is always set on a matched response, and
 * `Access-Control-Allow-Credentials: true` is added only when credentials are
 * opted in — so cookies flow to an allow-listed cross-origin `EventSource`
 * while an unmatched origin gets no CORS surface (fail-closed).
 */
function buildEventsCorsBlock(
  allowedOrigins: string[],
  allowCredentials: boolean,
): {
  helpers: string;
  streamHeadersSpread: string;
  capacityReturn: string;
  optionsHandler: string;
} {
  const originsLiteral = JSON.stringify(allowedOrigins);
  const credentialsLine = allowCredentials
    ? "\n  headers['Access-Control-Allow-Credentials'] = 'true';"
    : '';
  const helpers = `
// Credentialed cross-origin CORS (#1861). Opt-in via
// \`sveltekit.eventsRoute.allowedOrigins\` (+ \`allowCredentials\`); an unmatched or
// absent Origin gets no CORS surface, so this route stays same-origin only by
// default. The Origin is echoed only when allow-listed (never \`*\`), which is
// what makes credentialed CORS safe. CORS never authorizes — the fail-closed
// \`requireRouteAuth\` guard below is unchanged; CORS only lets an allow-listed
// browser's cookies reach it.
const CORS_ALLOWED_ORIGINS = new Set(${originsLiteral});

function eventsCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin');
  if (!origin || !CORS_ALLOWED_ORIGINS.has(origin)) return {};
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };${credentialsLine}
  return headers;
}

function applyEventsCors(response: Response, request: Request): Response {
  for (const [key, value] of Object.entries(eventsCorsHeaders(request))) {
    response.headers.set(key, value);
  }
  return response;
}
`;
  const streamHeadersSpread = '...eventsCorsHeaders(request),\n        ';
  const capacityReturn =
    '    return applyEventsCors(eventStreamCapacityExceededResponse(), request);';
  const optionsHandler = `
// Preflight for a credentialed cross-origin subscription. \`EventSource\` GETs
// are "simple" requests (no preflight), but a fetch-based SSE client may
// preflight — answer it for allow-listed origins only.
export const OPTIONS: RequestHandler = async ({ request }) => {
  const headers = eventsCorsHeaders(request);
  if (!('Access-Control-Allow-Origin' in headers)) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, {
    status: 204,
    headers: {
      ...headers,
      'Access-Control-Allow-Methods': 'GET,OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization,Last-Event-ID,Content-Type',
      'Access-Control-Max-Age': '86400',
    },
  });
};
`;
  return { helpers, streamHeadersSpread, capacityReturn, optionsHandler };
}

function generateEventsRouteTemplate(
  anchorClassName: string,
  tenantScoped: boolean,
  manifestHash: string | undefined,
  maxSubscribers: number | undefined,
  allowedOrigins: string[] | undefined,
  allowCredentials: boolean,
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
  // CORS is emitted only when an explicit allowlist is configured (#1861).
  // Without one the generated route carries no CORS surface — same-origin only,
  // byte-for-byte the pre-#1861 output.
  const corsEnabled = allowedOrigins !== undefined;
  const corsBlock = corsEnabled
    ? buildEventsCorsBlock(allowedOrigins, allowCredentials)
    : {
        helpers: '',
        streamHeadersSpread: '',
        capacityReturn: '    return eventStreamCapacityExceededResponse();',
        optionsHandler: '',
      };
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
// live. Same-origin only unless an origin allowlist is configured (#1861).

import { error } from '@sveltejs/kit';
import {
  buildChangeEventStream,
  eventStreamCapacityExceededResponse,
  resolveDispatchTenantScope,
  tryReserveChangeEventSubscriberSlot,
} from '@happyvertical/smrt-core';
import { getCollection } from '$lib/server/smrt';
import type { RequestHandler } from './$types';

const MANIFEST_HASH = ${manifestHashLiteral};
${corsBlock.helpers}
// Fail-closed authorization (#1540): the signal stream spans every table, so
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
export const GET: RequestHandler = async ({ locals, url, request }) => {
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
${corsBlock.capacityReturn}
  }
  return new Response(
    buildChangeEventStream(collection.db, {
      cursor,
      tenantScope,
      manifestHash: MANIFEST_HASH,
      releaseSubscriberSlot,
    }),
    {
      status: 200,
      headers: {
        ${corsBlock.streamHeadersSpread}'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    },
  );
};
${corsBlock.optionsHandler}`;
}
