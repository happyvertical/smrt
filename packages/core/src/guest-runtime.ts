/**
 * The process-wide guest runtime (#5196): what a generated route needs to
 * serve a guest beyond its permission set. The host (the app runtime's guest
 * admission) builds ONE of these per application and publishes it on every
 * guest principal; routes never build their own, so a limiter is shared by
 * every route and collection of the process (a limiter per generated module
 * would turn the per-tenant limit into a per-collection one).
 *
 * - {@link createGuestRuntime} validates the app's per-collection guest-create
 *   field lists and builds the limiters;
 * - {@link guestReadThrottle} charges a guest read against the per-client and
 *   per-tenant read limits;
 * - {@link guestCreateAdmission} and {@link handleGuestCreate} are the whole
 *   guest create pipeline of a generated route: size cap, projection, rate
 *   limit, plain insert plus audit row in one savepoint, then an empty `201`.
 *
 * Everything fails closed: a missing runtime, writer, field list, grant or
 * unverifiable model is "not a guest create", and the route then answers as it
 * does for any anonymous caller (401).
 *
 * @packageDocumentation
 */

import type { AuditWriter } from './audit.js';
import {
  clientKeyFor,
  createGuestCreateLimiter,
  defineGuestCreate,
  executeGuestCreate,
  GuestCreateBodyError,
  type GuestCreateConfig,
  type GuestCreateDb,
  type GuestCreateLimiter,
  type GuestCreateLimiterOptions,
  guestRowDefaults,
  projectGuestBody,
  type ResolvedGuestCreateConfig,
} from './guest-create.js';
import {
  type GuestRequestPrincipal,
  guestPrincipalOf,
  isGuestOperationAllowed,
} from './guest-request.js';
import { BoundedSlidingWindowRateLimiter } from './http.js';
import { ObjectRegistry } from './registry.js';

/** Guest read limits: looser than creates, still per client and per tenant. */
export interface GuestReadLimiterOptions {
  /** Reads per client per window. Default 120. */
  perClient?: number;
  /** Reads per tenant per window. Default 1,200. */
  perTenant?: number;
  /** Window in ms. Default 60,000. */
  windowMs?: number;
  /** Max distinct keys per limiter. Default 10,000. */
  maxEntries?: number;
}

export interface GuestRuntimeOptions {
  /**
   * Allowed body fields per guest-create collection (the permission
   * collection slug). A collection without an entry accepts no guest create.
   */
  createFields?: Readonly<Record<string, GuestCreateConfig>>;
  /**
   * Trusted reverse-proxy hops for the client identity (the app's existing
   * trusted-proxy setting). Default 0: only the socket address counts, never
   * a forwarded header.
   */
  trustedHops?: number | boolean;
  /** The app's audit writer. Without it no guest create is accepted. */
  auditWriter?: AuditWriter;
  /** Create limits (default 5/min per client, 60/min per tenant). */
  create?: GuestCreateLimiterOptions;
  /** Read limits (default 120/min per client, 1,200/min per tenant). */
  read?: GuestReadLimiterOptions;
}

/** A model's validated guest-create shape, resolved once per process. */
export interface ResolvedGuestCreateModel {
  readonly config: ResolvedGuestCreateConfig;
  readonly defaults: Readonly<Record<string, string | number | boolean | null>>;
  readonly tenantColumn: string;
}

export interface GuestRuntime {
  readonly trustedHops: number | boolean;
  readonly auditWriter: AuditWriter | undefined;
  readonly createLimiter: GuestCreateLimiter;
  readonly readLimiter: GuestCreateLimiter;
  /**
   * The validated guest-create shape for `collection` on registry `model`, or
   * `null` (not configured, or the field list failed validation against the
   * registered model: never partly applied).
   */
  resolveCreate(
    collection: string,
    model: string,
  ): ResolvedGuestCreateModel | null;
}

function readLimiter(
  options: GuestReadLimiterOptions = {},
): GuestCreateLimiter {
  const windowMs = options.windowMs ?? 60_000;
  const maxEntries = options.maxEntries ?? 10_000;
  return {
    client: new BoundedSlidingWindowRateLimiter({
      maxEvents: options.perClient ?? 120,
      windowMs,
      maxEntries,
      denyWhenFull: true,
    }),
    tenant: new BoundedSlidingWindowRateLimiter({
      maxEvents: options.perTenant ?? 1_200,
      windowMs,
      maxEntries,
      denyWhenFull: true,
    }),
  };
}

/** Build the guest runtime for one application. */
export function createGuestRuntime(
  options: GuestRuntimeOptions = {},
): GuestRuntime {
  const cache = new Map<string, ResolvedGuestCreateModel>();
  const fields = options.createFields ?? {};
  return Object.freeze({
    trustedHops: options.trustedHops ?? 0,
    auditWriter: options.auditWriter,
    createLimiter: createGuestCreateLimiter(options.create),
    readLimiter: readLimiter(options.read),
    resolveCreate(collection: string, model: string) {
      const key = `${collection}\0${model}`;
      const cached = cache.get(key);
      if (cached) return cached;
      let resolved: ResolvedGuestCreateModel | null = null;
      try {
        const raw = Object.hasOwn(fields, collection)
          ? fields[collection]
          : undefined;
        const registered = ObjectRegistry.getClass(model);
        const tenantColumn = registered
          ? ObjectRegistry.getOwnershipTenantColumn(
              registered.qualifiedName ?? registered.name,
            )
          : undefined;
        if (raw && registered && tenantColumn) {
          resolved = Object.freeze({
            config: defineGuestCreate(collection, raw, { className: model }),
            defaults: Object.freeze(guestRowDefaults(model)),
            tenantColumn,
          });
        }
      } catch {
        resolved = null;
      }
      // Only a validated shape is kept: a refusal is recomputed, so a
      // model that was not registered yet is not denied for the process.
      if (resolved) cache.set(key, resolved);
      return resolved;
    },
  });
}

function tooMany(retryAfterSeconds: number): Response {
  return new Response(
    JSON.stringify({ message: 'Too many requests', code: 'RATE_LIMITED' }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(Math.max(1, Math.ceil(retryAfterSeconds))),
      },
    },
  );
}

function jsonError(status: number, code: string, message: string): Response {
  return new Response(JSON.stringify({ message, code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function socketAddressOf(
  getClientAddress: (() => string) | undefined,
): string | undefined {
  try {
    return getClientAddress?.();
  } catch {
    return undefined;
  }
}

/**
 * Charge one guest read against the per-client and per-tenant read limits.
 * `null` means the read may proceed (also for every non-guest caller); a
 * `429` response with `Retry-After` means it may not. A guest whose runtime
 * is absent is refused, never admitted unlimited.
 */
export function guestReadThrottle(
  locals: unknown,
  request: Request,
  getClientAddress?: () => string,
  nowMs: number = Date.now(),
): Response | null {
  const principal = guestPrincipalOf(locals);
  if (!principal) return null;
  const runtime = principal.runtime;
  if (!runtime) return tooMany(60);
  let client: string;
  try {
    client = clientKeyFor(
      request,
      runtime.trustedHops,
      socketAddressOf(getClientAddress),
    );
  } catch {
    return tooMany(60);
  }
  const tenantKey = principal.tenantId;
  const clientKey = `${tenantKey}:${client}`;
  const waits = [
    runtime.readLimiter.tenant.check(tenantKey, nowMs),
    runtime.readLimiter.client.check(clientKey, nowMs),
  ].filter((n): n is number => n !== null);
  if (waits.length > 0) return tooMany(Math.max(...waits));
  runtime.readLimiter.tenant.record(tenantKey, nowMs);
  runtime.readLimiter.client.record(clientKey, nowMs);
  return null;
}

/** A request cleared to run the guest create pipeline. */
export interface GuestCreateAdmission {
  readonly principal: GuestRequestPrincipal;
  readonly runtime: GuestRuntime;
  readonly resolved: ResolvedGuestCreateModel;
  readonly model: string;
  readonly collection: string;
}

/**
 * Whether `locals` is a guest allowed to create in this collection: a valid
 * guest principal with a runtime that holds an audit writer and a validated
 * field list for the collection, the `<collection>.create` grant, and the
 * generated `create` operation (never a custom method). `null` otherwise, and
 * the caller then takes its ordinary (anonymous) path. A `public: true` model
 * is never a guest create: it already admits anonymous creates.
 */
export function guestCreateAdmission(
  locals: unknown,
  model: string,
  collection: string,
  publicAccess: boolean | 'read',
): GuestCreateAdmission | null {
  if (publicAccess === true) return null;
  const principal = guestPrincipalOf(locals);
  if (!principal) return null;
  const runtime = principal.runtime;
  if (!runtime || typeof runtime.auditWriter !== 'function') return null;
  if (
    !isGuestOperationAllowed(principal.permissions, model, collection, 'create')
  ) {
    return null;
  }
  const resolved = runtime.resolveCreate(collection, model);
  if (!resolved) return null;
  return { principal, runtime, resolved, model, collection };
}

/** Read at most `maxBytes` of a request body, then parse it as JSON. */
async function readBoundedJson(
  request: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    return {
      ok: false,
      response: jsonError(413, 'BODY_TOO_LARGE', 'Request body is too large'),
    };
  }
  const reader = request.body?.getReader();
  if (!reader) {
    return {
      ok: false,
      response: jsonError(400, 'BAD_BODY', 'Request body must be JSON'),
    };
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return {
          ok: false,
          response: jsonError(
            413,
            'BODY_TOO_LARGE',
            'Request body is too large',
          ),
        };
      }
      chunks.push(value);
    }
  } catch {
    return {
      ok: false,
      response: jsonError(400, 'BAD_BODY', 'Request body must be JSON'),
    };
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, value: JSON.parse(new TextDecoder().decode(bytes)) };
  } catch {
    return {
      ok: false,
      response: jsonError(400, 'BAD_BODY', 'Request body must be JSON'),
    };
  }
}

export interface HandleGuestCreateInput {
  admission: GuestCreateAdmission;
  request: Request;
  /** The collection's request-scoped database (the RLS transaction). */
  db: GuestCreateDb;
  /** The collection's physical table name. */
  tableName: string;
  /** SvelteKit `getClientAddress` (the socket address). */
  getClientAddress?: () => string;
  /** Clock override for tests. */
  nowMs?: number;
}

/**
 * The guest create pipeline. Answers `201` with an empty body (no id, no
 * `Location`; a unique conflict answers the same), `429` + `Retry-After`
 * when a limit trips, `400`/`413` for a bad or oversized body. Any other
 * failure (including a failed audit write, after the insert is rolled back)
 * throws, so the caller answers 500.
 */
export async function handleGuestCreate(
  input: HandleGuestCreateInput,
): Promise<Response> {
  const { admission, request } = input;
  const { resolved, runtime, principal } = admission;
  const writer = runtime.auditWriter;
  if (typeof writer !== 'function') {
    return jsonError(403, 'PERMISSION_DENIED', 'Permission denied.');
  }

  const body = await readBoundedJson(request, resolved.config.maxBodyBytes);
  if (!body.ok) return body.response;

  let projected: ReturnType<typeof projectGuestBody>;
  try {
    projected = projectGuestBody(body.value, resolved.config);
  } catch (error) {
    if (error instanceof GuestCreateBodyError) {
      return jsonError(
        error.code === 'GUEST_CREATE_BODY_TOO_LARGE' ? 413 : 400,
        'BAD_BODY',
        'Invalid request body',
      );
    }
    throw error;
  }

  let clientKey: string;
  try {
    clientKey = clientKeyFor(
      request,
      runtime.trustedHops,
      socketAddressOf(input.getClientAddress),
    );
  } catch {
    return tooMany(60);
  }

  const result = await executeGuestCreate({
    db: input.db,
    table: input.tableName,
    tenantId: principal.tenantId,
    tenantColumn: resolved.tenantColumn,
    body: projected,
    config: resolved.config,
    defaults: { ...resolved.defaults },
    smrtColumns: true,
    limiter: runtime.createLimiter,
    clientKey,
    audit: { writer, resourceType: admission.model },
    ...(input.nowMs === undefined ? {} : { nowMs: input.nowMs }),
  });
  if (result.status === 'rate_limited') {
    return tooMany(result.retryAfterSeconds);
  }
  return new Response(null, { status: 201 });
}
