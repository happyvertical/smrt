/**
 * Route-level request limits (#5198): one 429 decision for the runtime REST
 * handler and the generated SvelteKit routes.
 *
 * Both transports call {@link enforceRouteLimits} before they route, decide
 * authorization or touch a database, so a caller over its limit gets a 429
 * with `Retry-After` and never reaches a model. The decision is read from the
 * request's decided principal (the `resolvePrincipal` answer, or `locals` for
 * SvelteKit), never from a header or body the client chose: the tenant and the
 * caller kind come from the host, the client from the user id or, for a caller
 * with none, the client IP (`extractClientIp`, which only trusts as many
 * `X-Forwarded-For` hops as configured).
 *
 * Two buckets count a request, both in the bounded sliding window of
 * `BoundedSlidingWindowRateLimiter`:
 *
 * - per tenant and caller: `(tenant, callerKind, client)`, limited by
 *   {@link RouteLimitsConfig.client} scaled by the caller kind's entry in
 *   {@link RouteLimitsConfig.callerKindScale};
 * - per tenant (optional): every caller of one tenant together.
 *
 * `callerKind` is an opaque string: a guest, an agent or a service is one more
 * table entry, not a branch. A request that is refused is not counted.
 */

import {
  BoundedSlidingWindowRateLimiter,
  extractClientIp,
  HttpTooManyRequestsError,
} from '../http';

/** One window: at most `maxEvents` requests in `windowMs`. */
export interface RouteLimit {
  maxEvents: number;
  windowMs: number;
}

/** What the limits are told about one request. */
export interface RouteLimitSubject {
  /** The request, for the client IP. */
  request: Request;
  /** Tenant of the decided principal; `null` for a caller with no tenant. */
  tenantId: string | null | undefined;
  /** Signed-in user of the decided principal. */
  userId?: string | null;
  /** What kind of caller the principal is (a user, a guest, an agent, ...). */
  callerKind?: string | null;
}

export interface RouteLimitsConfig {
  /** Per tenant and caller; the base limit every caller kind scales. */
  client: RouteLimit;
  /** All callers of one tenant together. Absent: no tenant-wide limit. */
  tenant?: RouteLimit;
  /**
   * Multiplier of `client.maxEvents` for a caller kind, `(0, 1]` to tighten.
   * Merged over {@link DEFAULT_CALLER_KIND_SCALE}; a kind it does not name
   * gets the base limit.
   */
  callerKindScale?: Readonly<Record<string, number>>;
  /**
   * `X-Forwarded-For` hops to trust for the client IP of a caller with no
   * user id (see `extractClientIp`). Default 0: the header is ignored.
   */
  trustProxyHops?: boolean | number;
  /** Resolve the client address yourself (a socket address, a platform header). */
  clientAddress?: (request: Request) => string | undefined;
  /** Distinct keys kept in memory per limiter (LRU). Default 10,000. */
  maxEntries?: number;
}

/**
 * Callers that get less of the base limit unless the config says otherwise.
 * A guest is anonymous by definition, so it starts at a quarter.
 */
export const DEFAULT_CALLER_KIND_SCALE: Readonly<Record<string, number>> =
  Object.freeze({ guest: 0.25 });

/** Longest id or kind that goes into a key; the rest is cut, not trusted. */
const MAX_KEY_PART = 256;

export interface RouteLimitDecision {
  /** Seconds until the caller may retry, `>= 1`. */
  retryAfterSeconds: number;
}

export interface RouteLimiter {
  /**
   * Count one request, or refuse it. Returns `null` when admitted (and
   * counted), the refusal when not (nothing counted).
   */
  admit(subject: RouteLimitSubject, nowMs?: number): RouteLimitDecision | null;
  /** Forget every counter. */
  reset(): void;
}

function assertLimit(name: string, limit: RouteLimit): void {
  if (!Number.isSafeInteger(limit.maxEvents) || limit.maxEvents < 1) {
    throw new RangeError(`${name}.maxEvents must be a positive safe integer`);
  }
  if (!Number.isSafeInteger(limit.windowMs) || limit.windowMs < 1) {
    throw new RangeError(`${name}.windowMs must be a positive safe integer`);
  }
}

function part(value: string): string {
  return value.length > MAX_KEY_PART ? value.slice(0, MAX_KEY_PART) : value;
}

/** Build a limiter from a validated config. */
export function createRouteLimiter(config: RouteLimitsConfig): RouteLimiter {
  assertLimit('client', config.client);
  if (config.tenant) assertLimit('tenant', config.tenant);
  const scale: Record<string, number> = {
    ...DEFAULT_CALLER_KIND_SCALE,
    ...config.callerKindScale,
  };
  for (const [kind, factor] of Object.entries(scale)) {
    if (!(factor > 0)) {
      throw new RangeError(`callerKindScale.${kind} must be greater than 0`);
    }
  }
  const maxEntries = config.maxEntries;
  // One limiter per distinct `maxEvents`: the window length is shared, the
  // event cap is per caller kind.
  const clientLimiters = new Map<number, BoundedSlidingWindowRateLimiter>();
  const clientLimiter = (maxEvents: number) => {
    let limiter = clientLimiters.get(maxEvents);
    if (!limiter) {
      limiter = new BoundedSlidingWindowRateLimiter({
        maxEvents,
        windowMs: config.client.windowMs,
        ...(maxEntries ? { maxEntries } : {}),
      });
      clientLimiters.set(maxEvents, limiter);
    }
    return limiter;
  };
  const tenantLimiter = config.tenant
    ? new BoundedSlidingWindowRateLimiter({
        maxEvents: config.tenant.maxEvents,
        windowMs: config.tenant.windowMs,
        ...(maxEntries ? { maxEntries } : {}),
      })
    : undefined;

  return {
    admit(subject, nowMs = Date.now()) {
      const tenant = subject.tenantId ? part(subject.tenantId) : null;
      const kind = subject.callerKind ? part(subject.callerKind) : '';
      const client = subject.userId
        ? `u:${part(subject.userId)}`
        : `ip:${config.clientAddress?.(subject.request) ?? extractClientIp(subject.request, undefined, config.trustProxyHops ?? 0)}`;
      const factor = kind && Object.hasOwn(scale, kind) ? scale[kind] : 1;
      const maxEvents = Math.max(
        1,
        Math.floor(config.client.maxEvents * Math.min(factor, 1)),
      );
      const limiter = clientLimiter(maxEvents);
      const clientKey = `${tenant ?? ''}\u0000${kind}\u0000${client}`;
      const tenantKey = tenant ? `tenant\u0000${tenant}` : undefined;

      const waits = [
        limiter.check(clientKey, nowMs),
        tenantLimiter && tenantKey
          ? tenantLimiter.check(tenantKey, nowMs)
          : null,
      ].filter((wait): wait is number => wait !== null);
      if (waits.length > 0) {
        return { retryAfterSeconds: Math.max(...waits) };
      }
      limiter.record(clientKey, nowMs);
      if (tenantLimiter && tenantKey) tenantLimiter.record(tenantKey, nowMs);
      return null;
    },
    reset() {
      for (const limiter of clientLimiters.values()) limiter.clear();
      tenantLimiter?.clear();
    },
  };
}

/** The one 429 answer of both transports. */
export function rateLimitedResponse(decision: RouteLimitDecision): Response {
  const error = new HttpTooManyRequestsError(
    'Too many requests.',
    decision.retryAfterSeconds,
  );
  return new Response(
    JSON.stringify({
      message: error.publicMessage,
      code: error.code,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(error.retryAfterSeconds),
        'cache-control': 'no-store',
      },
    },
  );
}

let activeLimiter: RouteLimiter | undefined;

/**
 * Configure the process-wide route limits the generated SvelteKit routes read
 * (the runtime REST handler takes `APIConfig.routeLimits` and falls back to
 * this). `undefined` switches them off. Without a configuration nothing is
 * limited.
 */
export function configureRouteLimits(
  config: RouteLimitsConfig | undefined,
): RouteLimiter | undefined {
  activeLimiter = config ? createRouteLimiter(config) : undefined;
  return activeLimiter;
}

/** The configured process-wide limiter, if any. */
export function getRouteLimiter(): RouteLimiter | undefined {
  return activeLimiter;
}

/**
 * Admit one request or answer it with the 429. `limiter` defaults to the
 * process-wide one; with neither the request is admitted. Never throws into
 * the request: a limiter defect admits (the limit is a guard, not a gate on
 * the app being up).
 */
export function enforceRouteLimits(
  subject: RouteLimitSubject,
  limiter: RouteLimiter | undefined = activeLimiter,
): Response | undefined {
  if (!limiter) return undefined;
  try {
    const decision = limiter.admit(subject);
    return decision ? rateLimitedResponse(decision) : undefined;
  } catch {
    return undefined;
  }
}
