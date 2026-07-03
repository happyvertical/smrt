/**
 * Conditional GET v1 for generated read routes (#1757).
 *
 * Generated `list`/`get` responses carry a strong ETag computed from the
 * serialized JSON body, and a matching `If-None-Match` answers
 * `304 Not Modified` with an empty body. v1 deliberately still runs the query
 * — the win is transfer, parse, and re-render, not the database round trip
 * (a later slice upgrades the ETag source to the change-feed table version).
 *
 * Cache-Control policy (fail-private, mirroring the #1540 posture):
 * - Default reads: `private, no-cache` — responses may be stored by the
 *   browser but MUST be revalidated before reuse, and shared caches never
 *   store them.
 * - `@smrt({ api: { public: true | 'read', cache: { sMaxage } } })` reads:
 *   `public, max-age=0, s-maxage=<n>` — CDNs/shared caches may serve the
 *   response for `n` seconds while browsers still revalidate (cheap 304s).
 *   Models without the public flag NEVER emit shared-cache headers, even when
 *   `cache.sMaxage` is configured.
 * - Tenant-scoped models (`@smrt({ tenantScoped })` / `@TenantScoped()`, any
 *   mode) NEVER emit shared-cache headers: their bodies vary with the tenant
 *   context, which URL-keyed shared caches cannot see. `sMaxage` is ignored
 *   with a one-time warning.
 * - Field-level read-permission models NEVER emit shared-cache headers: their
 *   bodies vary with the caller's resolved permission set, which shared caches
 *   cannot see. These routes use the v1 body-hash ETag so the validator covers
 *   the redacted payload actually returned to that caller.
 *
 * Consumed by both the runtime REST generator (`./rest.ts`) and — as an
 * emitted code snippet — the SvelteKit route generator
 * (`../vite-plugin/sveltekit-generator.ts`). Keeping every piece here keeps
 * the two generators' diffs minimal and the policy in one place.
 */

import { createHash } from 'node:crypto';
import { resolveDispatchTenantScope } from '../dispatch/tenant-resolver.js';

/** Default Cache-Control for generated reads: private conditional revalidation. */
export const PRIVATE_READ_CACHE_CONTROL = 'private, no-cache';

/**
 * Compute the strong ETag for a serialized response body.
 *
 * SHA-256 of the exact JSON text, base64url-encoded and quoted per RFC 9110.
 * Deterministic for a given body, so any change to the underlying data (which
 * changes the serialized JSON) changes the ETag.
 */
export function computeBodyEtag(body: string): string {
  return `"${createHash('sha256').update(body).digest('base64url')}"`;
}

/**
 * Whether an `If-None-Match` request header matches the response ETag.
 *
 * Implements RFC 9110 §13.1.2 weak comparison: `*` matches anything, the
 * header may carry a comma-separated list, and a `W/` prefix is ignored.
 */
export function ifNoneMatchSatisfied(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    const opaque = tag.startsWith('W/') ? tag.slice(2) : tag;
    return opaque === etag;
  });
}

interface ApiCacheShape {
  cache?: { sMaxage?: unknown };
  public?: unknown;
}

/** Model-level context that constrains the cache policy beyond `api` config. */
export interface ReadCacheControlOptions {
  /**
   * Whether the model is tenant-scoped (`@smrt({ tenantScoped })` or the
   * `@TenantScoped()` decorator, ANY mode including `'optional'`). Tenant
   * scoping keys the response body on request identity (session cookie), which
   * shared caches cannot see — they key on the URL alone — so honoring
   * `sMaxage` would serve one tenant's rows to other tenants or to anonymous
   * visitors. Fail-closed: tenant-scoped models NEVER emit shared-cache
   * headers (#1757 review finding).
   */
  tenantScoped?: boolean;
  /**
   * Whether the response body varies with caller permissions because at least
   * one field has `@field({ readPermission })`. Shared caches key on URL, not
   * user permission sets, so this also fails private regardless of `sMaxage`.
   */
  permissionScoped?: boolean;
}

/**
 * The shared Cache-Control string the `api` config asks for, or null when the
 * config does not (validly) opt into shared caching. Config-only — the
 * tenant-scoped restriction is applied by `resolveReadCacheControl`.
 */
function requestedSharedCacheControl(apiConfig: unknown): string | null {
  if (!apiConfig || typeof apiConfig !== 'object') {
    return null;
  }

  const config = apiConfig as ApiCacheShape;
  const publicRead = config.public === true || config.public === 'read';
  const sMaxage = config.cache?.sMaxage;

  if (
    publicRead &&
    typeof sMaxage === 'number' &&
    Number.isFinite(sMaxage) &&
    sMaxage > 0
  ) {
    // Shared caches serve for sMaxage seconds; browsers (max-age=0) always
    // revalidate, so end users see edits immediately via cheap 304s.
    return `public, max-age=0, s-maxage=${Math.floor(sMaxage)}`;
  }

  return null;
}

/**
 * Resolve the Cache-Control header for a generated read response from a
 * model's `@smrt({ api })` config (defensively typed — the config arrives as
 * `unknown` from the registry at runtime and from the manifest at build time).
 *
 * Only models that opted out of auth via `public: true` (or `'read'`, which
 * makes reads public) may emit shared-cache headers, and only when they also
 * configure a positive `cache.sMaxage`. Everything else — including a
 * non-public model that configures `sMaxage` — stays `private, no-cache`.
 *
 * Tenant-scoped and permission-scoped models are ALWAYS `private, no-cache`
 * regardless of config: their response bodies vary with request identity
 * (tenant or permissions, invisible to URL-keyed shared caches), so shared
 * caching would leak one caller's representation to another caller.
 */
export function resolveReadCacheControl(
  apiConfig: unknown,
  options: ReadCacheControlOptions = {},
): string {
  if (options.tenantScoped || options.permissionScoped) {
    return PRIVATE_READ_CACHE_CONTROL;
  }

  return requestedSharedCacheControl(apiConfig) ?? PRIVATE_READ_CACHE_CONTROL;
}

/** Whether an `api` config opts reads out of auth (`public: true | 'read'`). */
function isPublicRead(apiConfig: unknown): boolean {
  if (!apiConfig || typeof apiConfig !== 'object') {
    return false;
  }
  const value = (apiConfig as ApiCacheShape).public;
  return value === true || value === 'read';
}

// One warning per model — both transports resolve the same model repeatedly
// (per route template at generation time, per request at runtime).
const sharedCacheNeutralizedWarned = new Set<string>();

// One warning per model for the tenant-scoped + public-read combination (#1782).
const tenantScopedPublicReadWarned = new Set<string>();

/**
 * Warn (once per model) when a tenant-scoped model is also marked publicly
 * readable (`@smrt({ api: { public: true | 'read' } })`).
 *
 * Anonymous / no-tenant-context reads on such a model fail closed to NULL-tenant
 * (global) rows only (#1782): they never expose any tenant's rows. That is the
 * intended, safe behavior, but silently it reads as "the public endpoint returns
 * nothing" — so surface the combination and its consequence at generation /
 * serve time. Called from both the REST runtime and the SvelteKit route
 * generator so the message appears wherever the model is exposed.
 */
export function warnIfTenantScopedPublicRead(
  modelName: string,
  apiConfig: unknown,
  tenantScoped: boolean,
): void {
  if (!tenantScoped) return;
  if (!isPublicRead(apiConfig)) return;
  if (tenantScopedPublicReadWarned.has(modelName)) return;
  tenantScopedPublicReadWarned.add(modelName);
  console.warn(
    `[smrt] tenant-scoped model ${modelName} is marked api.public — ` +
      'anonymous reads with no tenant context return NULL-tenant (global) ' +
      'rows ONLY, never any tenant’s rows (fail-closed, #1782). Resolve a ' +
      'tenant from the request (host/subdomain/session) if per-tenant public ' +
      'reads are intended.',
  );
}

/**
 * Warn (once per model) when a tenant-scoped model configures
 * `api.cache.sMaxage`: the knob is deliberately neutralized to private
 * caching, and silently ignoring it would leave developers wondering why no
 * CDN caching happens. Called from both the REST runtime and the SvelteKit
 * route generator so the message surfaces wherever the model is served.
 */
export function warnIfSharedCacheNeutralized(
  modelName: string,
  apiConfig: unknown,
  tenantScoped: boolean,
  permissionScoped = false,
): void {
  if (!tenantScoped && !permissionScoped) return;
  if (requestedSharedCacheControl(apiConfig) === null) return;
  const reasonKey = `${tenantScoped ? 'tenant' : ''}:${permissionScoped ? 'permission' : ''}`;
  const warningKey = `${modelName}:${reasonKey}`;
  if (sharedCacheNeutralizedWarned.has(warningKey)) return;
  sharedCacheNeutralizedWarned.add(warningKey);
  const scopeDescription =
    tenantScoped && permissionScoped
      ? 'tenant/read-permission context'
      : tenantScoped
        ? 'tenant context'
        : 'caller permissions';
  const modelDescription =
    tenantScoped && permissionScoped
      ? 'tenant-scoped/read-permission model'
      : tenantScoped
        ? 'tenant-scoped model'
        : 'read-permission model';
  console.warn(
    `[smrt] api.cache.sMaxage ignored for ${modelDescription} ${modelName}: ` +
      `shared caches cannot key on ${scopeDescription} — serving ` +
      `'${PRIVATE_READ_CACHE_CONTROL}' instead (#1757).`,
  );
}

/**
 * Build the JSON response for a generated read, honoring `If-None-Match`.
 *
 * Returns `304 Not Modified` with an EMPTY body when the request's
 * `If-None-Match` matches the body ETag; otherwise a 200 with the serialized
 * payload. Both carry the ETag and the resolved Cache-Control so clients can
 * revalidate the representation they hold.
 */
export function conditionalJsonResponse(
  request: Request,
  payload: unknown,
  cacheControl: string,
): Response {
  const body = JSON.stringify(payload);
  const etag = computeBodyEtag(body);

  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: {
        'Cache-Control': cacheControl,
        ETag: etag,
      },
    });
  }

  return new Response(body, {
    status: 200,
    headers: {
      'Cache-Control': cacheControl,
      'Content-Type': 'application/json',
      ETag: etag,
    },
  });
}

// ===========================================================================
// ETag v2: per-table change-feed version source (#1765)
//
// v1 (above) hashes the serialized response body, so a 304 still runs the
// query — the win is transfer, not the database round trip. v2 derives the
// ETag from the change feed's per-table version (getTableVersion in
// ../change-feed) plus the request representation, so a matching If-None-Match
// short-circuits into a 304 BEFORE the collection query runs. The Cache-Control
// policy, If-None-Match matching, and 304/200 response shape are all preserved
// verbatim from v1 — only the ETag SOURCE changes.
//
// ## Consistency model (the deliberate cost of zero-query revalidation)
//
// Revalidating against a version PROXY instead of the response body — the whole
// point of "zero database work" — means v2 is weakly, not strongly, consistent.
// Two bounded windows follow, both acceptable for the sites-track read cache
// this serves; a route that needs strong consistency keeps the v1 body-hash
// path (which reads the data), as serializer routes do:
//
//   1. Write→feed gap. On the autocommit save()/delete() path the data row
//      commits and THEN the afterSave/afterDelete interceptor appends the feed
//      row (a separate statement — see change-feed.ts). A revalidation landing
//      in that sub-statement window reads the pre-write version and can return a
//      stale 304; it self-heals on the next revalidation once the feed advances.
//      (Wrapping save() + append in one transaction would close it, but that is
//      a change-feed write-path concern, not this consumer's.)
//   2. Shape change without a table write. The ETag reflects the table version
//      and request, NOT the serialization shape. A deploy that changes fields /
//      toPublicJSON / transformJSON / sensitive markings without any table write
//      leaves ETags unchanged, so clients keep the old shape until the table
//      next changes. Deploy-time invalidation — salting the ETag with the
//      manifest/build hash — is version-awareness (#1764) territory; shared-cache
//      operators should purge on a shape-changing deploy in the meantime.
// ===========================================================================

/**
 * Compute the strong ETag for a generated read from the table's change-feed
 * version and the request representation.
 *
 * Keying the ETag on the representation as well as the version is what keeps
 * two different reads of the SAME table from colliding: `?limit=10` and
 * `?limit=20` share a table version but produce different ETags, so a client
 * caching one can never be wrongly answered `304` for the other. Any write to
 * the table advances its version (see {@link getTableVersion}) and therefore
 * every representation's ETag.
 *
 * The `version:representation` join is injective because `version` is a
 * non-negative integer with no `:` — the first colon unambiguously delimits it
 * from the representation, so `(1, ':x')` and `(1, 'x')` never collide.
 * Deterministic and carrying no per-process state, so it is replica-stable.
 */
export function computeTableVersionEtag(
  version: number,
  representation: string,
): string {
  return `"${createHash('sha256')
    .update(`${version}:${representation}`)
    .digest('base64url')}"`;
}

/**
 * Build a canonical, order-independent representation string for a read
 * request: the URL path plus its query parameters sorted by name, and an
 * optional extra discriminator (e.g. the resolved tenant scope) folded in.
 *
 * Two requests that must return the same body produce the same string (so they
 * share an ETag and revalidate cheaply); any difference that changes the body —
 * a different path, a different filter/limit/offset, or a different tenant —
 * produces a different string and therefore a different ETag.
 *
 * Sorting is by parameter NAME only (a stable sort, so repeated keys keep their
 * original relative order). Sorting by value too would make `?limit=10&limit=20`
 * and `?limit=20&limit=10` canonicalize identically, yet the generated handlers
 * read `searchParams.get('limit')` (the FIRST value) — different reads that must
 * not share an ETag. Name-only sorting keeps different orderings of the same
 * keys distinct while still making `?a=1&b=2` and `?b=2&a=1` equivalent.
 *
 * Names, values, and the extra discriminator are percent-ENCODED before being
 * joined — the `searchParams` entries arrive already decoded, so re-joining them
 * raw with `&`/`=`/`|` would let a value containing those characters collide with
 * a structurally different request (`?q=a%26b=c` vs `?q=a&b=c` both decode-then-
 * rejoin to `q=a&b=c`), a false-304 vector. Encoding makes the string injective.
 */
export function canonicalReadRepresentation(
  request: Request,
  extra?: string,
): string {
  const url = new URL(request.url);
  const params = [...url.searchParams.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const search = params
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(value)}`,
    )
    .join('&');
  return `${url.pathname}?${search}${extra ? `|${encodeURIComponent(extra)}` : ''}`;
}

/**
 * The active tenant folded into a read's ETag representation, or `undefined`
 * when tenancy is not being enforced.
 *
 * This closes a cross-tenant hole specific to per-table version ETags: the
 * table version spans all tenants, so without a tenant component two tenants —
 * or one client switching tenants — would compute the SAME ETag for the same
 * URL. Since tenant-scoped reads are `private, no-cache` (never shared-cached
 * but still browser-cached), a client that viewed tenant A and then switched to
 * tenant B could revalidate B's request with A's cached validator and be
 * wrongly served A's rows from its own cache. Keying the ETag on the active
 * tenant makes A's and B's validators distinct, so the switch forces a fresh
 * `200`. Mirrors the fail-closed dispatch rule: enforced with no context →
 * `global`, so a missing context never collides with a real tenant.
 */
export function resolveTenantEtagDiscriminator(): string | undefined {
  const scope = resolveDispatchTenantScope();
  if (!scope.enforced) return undefined;
  return `t:${scope.tenantId ?? 'global'}`;
}

/**
 * Whether an `If-None-Match` header carries a CONCRETE ETag match — a specific
 * quoted tag equal to `etag` — as opposed to the wildcard `*`.
 *
 * The version fast-path uses this rather than {@link ifNoneMatchSatisfied}
 * because `*` matches unconditionally: per RFC 9110 `*` is satisfied only when a
 * current representation EXISTS, which the pre-query fast-path cannot know. A
 * concrete match, by contrast, can only be held by a client that received it
 * from a prior `200` — and any delete of that row advances the table version,
 * so the concrete ETag would no longer match — making a `304` without the query
 * safe. `*` is deferred until existence is confirmed (see
 * {@link versionConditionalResponse}).
 */
export function ifNoneMatchHasConcreteMatch(
  header: string | null | undefined,
  etag: string,
): boolean {
  if (!header) return false;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    if (tag === '*') return false;
    const opaque = tag.startsWith('W/') ? tag.slice(2) : tag;
    return opaque === etag;
  });
}

/**
 * Build a generated read response from a precomputed version ETag, skipping the
 * query on a conditional hit (#1765).
 *
 * A CONCRETE `If-None-Match` match returns `304 Not Modified` with an empty body
 * and **never invokes `buildPayload`** — the collection query does not run,
 * which is the point of ETag v2. Otherwise `buildPayload` runs; if it succeeds
 * (a current representation therefore exists) a wildcard `If-None-Match: *` is
 * honored with a `304` — deferring `*` past the build is what stops a
 * `304` from being returned for a row that no longer exists (a `buildPayload`
 * that throws, e.g. a `404` for a missing item, propagates and is never a 304).
 * Mirrors {@link conditionalJsonResponse}'s response shape and header policy.
 */
export async function versionConditionalResponse(
  request: Request,
  etag: string,
  cacheControl: string,
  buildPayload: () => unknown | Promise<unknown>,
): Promise<Response> {
  const notModified = () =>
    new Response(null, {
      status: 304,
      headers: {
        'Cache-Control': cacheControl,
        ETag: etag,
      },
    });

  const ifNoneMatch = request.headers.get('if-none-match');
  if (ifNoneMatchHasConcreteMatch(ifNoneMatch, etag)) {
    return notModified();
  }

  const payload = await buildPayload();
  // Existence confirmed by a successful build → honor a wildcard `*` now.
  if (ifNoneMatchSatisfied(ifNoneMatch, etag)) {
    return notModified();
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'Cache-Control': cacheControl,
      'Content-Type': 'application/json',
      ETag: etag,
    },
  });
}

/** Generation-time context for the emitted SvelteKit route helper. */
export interface ConditionalGetRouteHelperOptions
  extends ReadCacheControlOptions {
  /** Model name used for the one-time sMaxage-neutralized warning. */
  modelName?: string;
  /**
   * Emit the v1 body-hash helper (`conditionalJson`, query-first) instead of the
   * v2 version-first `conditionalVersionedRead`. Set when the route's GET handler
   * renders via a CUSTOM serializer whose output can depend on RELATED tables
   * (e.g. content's `serializeContent` loads assets/references): the per-base-
   * table version cannot observe those changes, so a version-derived `304` would
   * serve stale serialized fields. The body hash covers the whole rendered
   * payload, so it stays correct — at the cost of running the query (a
   * transfer-saving 304, not zero-query). The default `toPublicJSON` payload IS a
   * pure function of the base table, so it uses v2.
   */
  useBodyHash?: boolean;
}

/**
 * Emit the conditional-GET helper inlined into generated SvelteKit route files,
 * following the generator's existing inline-helper convention (auth guard,
 * tenant context, writable policy). The Cache-Control policy is resolved at
 * generation time from the object's `@smrt({ api })` config plus tenant scoping
 * and baked in as a constant.
 *
 * Two shapes, chosen per route by `useBodyHash`:
 * - **v2 (default, #1765)** — `conditionalVersionedRead(request, db, tableName,
 *   buildPayload)` derives the ETag from the table's change-feed version
 *   ({@link getTableVersion}) keyed by the request representation, so a concrete
 *   `If-None-Match` returns a `304` and `buildPayload` — the collection query —
 *   never runs. Imports its primitives from `@happyvertical/smrt-core` (the
 *   version lookup is dialect-aware SQL that cannot be inlined portably),
 *   mirroring the generated `_changes` route. Correct only when the payload is a
 *   pure function of the base table — the `toPublicJSON` path.
 * - **v1 (#1757, `useBodyHash`)** — the inlined body-hash `conditionalJson`,
 *   used where a custom serializer can pull in related tables the base-table
 *   version can't see, or where `@field({ readPermission })` means the body
 *   differs by caller permissions.
 *
 * For tenant-scoped models the v2 representation folds in the active tenant
 * ({@link resolveTenantEtagDiscriminator}) so one tenant's cached validator
 * never satisfies another's read of the same URL — the cross-tenant false-304
 * guard. The v2 runtime behavior is exercised end to end (query observation, 304
 * without a query, mutation bumps the version) by the REST `conditional-get.spec`
 * over the SAME core primitives this route calls.
 */
export function generateConditionalGetRouteHelper(
  apiConfig: unknown,
  options: ConditionalGetRouteHelperOptions = {},
): string {
  // All branches of resolveReadCacheControl return fixed framework-owned
  // strings (no user text), so interpolating into a single-quoted literal is
  // safe and matches the generated-code quoting style.
  const cacheControl = resolveReadCacheControl(apiConfig, options);
  if (options.modelName) {
    warnIfSharedCacheNeutralized(
      options.modelName,
      apiConfig,
      options.tenantScoped === true,
      options.permissionScoped === true,
    );
    warnIfTenantScopedPublicRead(
      options.modelName,
      apiConfig,
      options.tenantScoped === true,
    );
  }

  // Serializer-backed or permission-scoped routes: the body can depend on data
  // the base-table version representation cannot see, so keep the v1 body-hash
  // ETag (query-first but correct). See useBodyHash.
  const useBodyHash = options.useBodyHash || options.permissionScoped === true;
  if (useBodyHash) {
    return `
// Conditional GET (#1757 v1): a strong body-hash ETag over the serialized
// response — used where a custom serializer can render data from related tables
// that the per-table change-feed version cannot observe, so the ETag must cover
// the whole rendered body.
import { createHash } from 'node:crypto';

const READ_CACHE_CONTROL = '${cacheControl}';

function bodyEtag(body: string): string {
  return \`"\${createHash('sha256').update(body).digest('base64url')}"\`;
}

function ifNoneMatchSatisfied(header: string | null, etag: string): boolean {
  if (!header) return false;
  if (header.trim() === '*') return true;
  return header.split(',').some((candidate) => {
    const tag = candidate.trim();
    const opaque = tag.startsWith('W/') ? tag.slice(2) : tag;
    return opaque === etag;
  });
}

function conditionalJson(request: Request, payload: unknown): Response {
  const body = JSON.stringify(payload);
  const etag = bodyEtag(body);
  if (ifNoneMatchSatisfied(request.headers.get('if-none-match'), etag)) {
    return new Response(null, {
      status: 304,
      headers: { 'cache-control': READ_CACHE_CONTROL, etag },
    });
  }
  return new Response(body, {
    status: 200,
    headers: {
      'cache-control': READ_CACHE_CONTROL,
      'content-type': 'application/json',
      etag,
    },
  });
}
`;
  }

  // Tenant-scoped models key the ETag on the active tenant; non-tenant models
  // omit the discriminator (their bodies do not vary by tenant), so the import
  // and the representation argument are conditional on tenant scoping.
  const tenantScoped = options.tenantScoped === true;
  const coreImports = [
    'canonicalReadRepresentation',
    'computeTableVersionEtag',
    'getTableVersion',
    'ifNoneMatchHasConcreteMatch',
    'ifNoneMatchSatisfied',
    ...(tenantScoped ? ['resolveTenantEtagDiscriminator'] : []),
  ].join(',\n  ');
  const representationExtra = tenantScoped
    ? 'resolveTenantEtagDiscriminator()'
    : 'undefined';

  return `
// Conditional GET (#1765): the ETag is the table's change-feed version keyed by
// the request representation, so a CONCRETE If-None-Match returns 304 BEFORE the
// collection query runs. A wildcard \`*\` is honored only after the payload builds
// (existence confirmed), so a 304 is never returned for a missing row. Reads stay
// private unless the model is public AND opts into shared caching via
// @smrt({ api: { cache: { sMaxage } } }).
import {
  ${coreImports},
} from '@happyvertical/smrt-core';

const READ_CACHE_CONTROL = '${cacheControl}';

async function conditionalVersionedRead(
  request: Request,
  db: Parameters<typeof getTableVersion>[0],
  tableName: string,
  buildPayload: () => Promise<unknown>,
): Promise<Response> {
  const version = await getTableVersion(db, tableName);
  const etag = computeTableVersionEtag(
    version,
    canonicalReadRepresentation(request, ${representationExtra}),
  );
  const ifNoneMatch = request.headers.get('if-none-match');
  const notModified = () =>
    new Response(null, {
      status: 304,
      headers: { 'cache-control': READ_CACHE_CONTROL, etag },
    });
  if (ifNoneMatchHasConcreteMatch(ifNoneMatch, etag)) {
    return notModified();
  }
  const payload = await buildPayload();
  // Existence confirmed by a successful build → honor a wildcard \`*\` now.
  if (ifNoneMatchSatisfied(ifNoneMatch, etag)) {
    return notModified();
  }
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      'cache-control': READ_CACHE_CONTROL,
      'content-type': 'application/json',
      etag,
    },
  });
}
`;
}
